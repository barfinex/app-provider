// binance.service.ts
import {
    forwardRef,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    OnModuleInit,
} from '@nestjs/common';

import {
    DataSource,
    MarketType,
    TimeFrame,
    Symbol,
    SubscriptionType,
    Candle,
    Trade,
    OrderBook,
    AccountEvent,
    SymbolPrice,
    Subscription,
    SubscriptionValue,
    ConnectorType,
} from '@barfinex/types';

import { ConfigService } from '@barfinex/config';
import { ConnectorService } from '../../connector.service';
import { CandleService } from '../../../candle/candle.service';
import { SymbolRepository } from '../../../symbol/symbol.repository';
import { TradeRepository } from '../../../questdb/repositories/trade.repository';
import { OrderBookRepository } from '../../../questdb/repositories/orderbook.repository';
import { EventSinkRepository } from '../../../questdb/event-sink/event-sink.repository';

import { BinanceClientService } from './core/binance.client';
import { BinanceRedisService } from './core/binance.redis';
import { BinanceSubscriptionService } from './ws/binance.subscription.service';
import { BinanceWsManager } from './ws/binance.ws.manager';

import { BinanceAccountApi } from './api/binance.account.api';
import { BinanceMarketApi } from './api/binance.market.api';
import { BinanceOrderApi } from './api/binance.order.api';

import { createCandleAdapter } from './adapters/candle.adapter';
import { createTradeAdapter } from './adapters/trade.adapter';
import { createOrderBookAdapter } from './adapters/orderbook.adapter';
import { createAccountAdapter } from './adapters/account.adapter';
import { createSymbolsAdapter } from './adapters/symbols.adapter';
import { createSymbolPricesAdapter } from './adapters/symbol-prices.adapter';

@Injectable()
// export class BinanceService implements DataSource {
export class BinanceService {
    private readonly logger = new Logger(BinanceService.name);

    private readonly connectorType = ConnectorType.binance;
    private readonly isEmitToRedisEnabled = true;

    private lastSymbolsHash: string | null = null;
    private lastAccountEventTime = 0;
    private readonly accountStreamDisabledMarkets = new Set<MarketType>();

    private subscription: {
        options?: { symbols: Symbol[]; intervals?: TimeFrame[] };
        unsubscribeAccount?: () => void;
        unsubscribeOrderBook?: () => void;
        unsubscribeTrade?: () => void;
        unsubscribeSymbolPrices?: () => void;
        unsubscribeSymbols?: () => void;
        unsubscribeCandles?: () => void;
    } = {};

    constructor(
        private readonly configService: ConfigService,
        private readonly symbolRepository: SymbolRepository,
        private readonly tradeRepository: TradeRepository,
        private readonly orderBookRepository: OrderBookRepository,
        private readonly eventSinkRepository: EventSinkRepository,

        @Inject(forwardRef(() => CandleService))
        private readonly candleService: CandleService,

        private readonly client: BinanceClientService,
        private readonly redis: BinanceRedisService,
        private readonly subscriptions: BinanceSubscriptionService,
        private readonly ws: BinanceWsManager,

        private readonly accountApi: BinanceAccountApi,
        private readonly marketApi: BinanceMarketApi,
        private readonly orderApi: BinanceOrderApi,
    ) { }

    // =========================================================================
    // READY
    // =========================================================================
    async ensureReady(): Promise<void> {
        await this.client.ensureReady();
    }

    private get api() {
        return this.client.api;
    }

    // =========================================================================
    // ACCOUNT EVENT (dedup + dynamic symbols)
    // =========================================================================
    private async handleAccountEvent(
        marketType: MarketType,
        event: AccountEvent,
    ): Promise<void> {
        if (event.eventTime === this.lastAccountEventTime) return;
        this.lastAccountEventTime = event.eventTime;

        await this.emit(SubscriptionType.PROVIDER_ACCOUNT_EVENT, marketType, event);
        this.eventSinkRepository.emit('account.update', {
            category: 'connector',
            action: 'update',
            connectorType: this.connectorType,
            marketType,
            timestamp: Number(event.eventTime) || Date.now(),
            data: event,
        });

        const symbolName = event.options?.symbol;
        if (!symbolName || typeof symbolName !== 'string') return;

        if (!this.subscription.options) {
            this.subscription.options = { symbols: [], intervals: [] };
        }

        const exists = this.subscription.options.symbols.some(
            (s) => s?.name?.toUpperCase() === symbolName.toUpperCase(),
        );

        if (!exists) {
            // сохраняем как доменный Symbol
            this.subscription.options.symbols.push({
                name: symbolName,
                connectorType: this.connectorType,
                marketType,
            });

            await this.updateSubscribeCollection(
                marketType,
                this.subscription.options.symbols,
                this.subscription.options.intervals,
            );
        }
    }

    // =========================================================================
    // REST — delegation
    // =========================================================================
    getAssetsInfo(marketType: MarketType) {
        return this.accountApi.getAssetsInfo(marketType);
    }

    getAccountInfo(marketType: MarketType) {
        return this.accountApi.getAccountInfo(marketType);
    }

    changeLeverage(symbol: Symbol, leverage: number) {
        return this.accountApi.changeLeverage(symbol, leverage);
    }

    getSymbolsInfo(connectorType: ConnectorType, marketType: MarketType) {
        return this.marketApi.getSymbolsInfo(connectorType, marketType);
    }

    openOrder(order: any) {
        return this.orderApi.openOrder(order);
    }

    closeOrder(options: any) {
        return this.orderApi.closeOrder(options);
    }

    closeAllOrders(options: any) {
        return this.orderApi.closeAllOrders(options);
    }

    getOpenOrders(options: any) {
        return this.orderApi.getOpenOrders(options);
    }

    // =========================================================================
    // SUBSCRIBE / UNSUBSCRIBE
    // =========================================================================
    async unsubscribe(): Promise<void> {
        // аккуратно вызываем только функции отписок
        if (this.subscription.unsubscribeAccount) this.subscription.unsubscribeAccount();
        if (this.subscription.unsubscribeOrderBook) this.subscription.unsubscribeOrderBook();
        if (this.subscription.unsubscribeTrade) this.subscription.unsubscribeTrade();
        if (this.subscription.unsubscribeSymbolPrices) this.subscription.unsubscribeSymbolPrices();
        if (this.subscription.unsubscribeSymbols) this.subscription.unsubscribeSymbols();
        if (this.subscription.unsubscribeCandles) this.subscription.unsubscribeCandles();
    }

    async subscribe(
        marketType: MarketType,
        symbols: Symbol[],
        intervals?: TimeFrame[],
    ): Promise<void> {
        const config = this.configService.getConfig();

        const connector = config.provider?.connectors?.find(
            (c: any) =>
                c.connectorType === this.connectorType &&
                c.markets?.some((m: any) => m.marketType === marketType),
        );

        if (!connector) {
            throw new InternalServerErrorException(
                `Connector ${this.connectorType}-${marketType} not found`,
            );
        }

        // фиксируем текущую коллекцию подписок (нужно для динамического расширения)
        this.subscription.options = { symbols, intervals };

        for (const sub of connector.subscriptions ?? []) {
            if (!sub.active) continue;

            try {
                switch (sub.type) {
                    case SubscriptionType.PROVIDER_ACCOUNT_EVENT:
                        if (this.accountStreamDisabledMarkets.has(marketType)) {
                            this.logger.debug(
                                `Account stream disabled for [${marketType}] due to previous HTTP 410.`,
                            );
                            break;
                        }
                        try {
                            this.subscription.unsubscribeAccount = await this.ws.subscribeToAccount(
                                { marketType },
                                createAccountAdapter({
                                    marketType,
                                    handler: this.handleAccountEvent.bind(this),
                                }),
                            );
                        } catch (accountErr: any) {
                            const status = accountErr?.response?.status;
                            if (status === 410) {
                                this.accountStreamDisabledMarkets.add(marketType);
                                this.logger.log(
                                    `Account stream deprecated for [${marketType}] (HTTP 410). Disabling further attempts; candles/trades continue.`,
                                );
                            } else {
                                this.logger.warn(
                                    `Account stream unavailable [${marketType}] (HTTP ${status ?? 'error'}). Candles/trades will still work.`,
                                );
                            }
                        }
                        break;

                    case SubscriptionType.PROVIDER_MARKETDATA_TRADE:
                        this.subscription.unsubscribeTrade = await this.ws.subscribeToTrade(
                            { marketType, symbols },
                            createTradeAdapter(this),
                        );
                        break;

                    case SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK:
                        this.subscription.unsubscribeOrderBook = await this.ws.subscribeToOrderBook(
                            { marketType, symbols },
                            createOrderBookAdapter(this),
                        );
                        break;

                    case SubscriptionType.PROVIDER_MARKETDATA_CANDLE:
                        for (const interval of intervals ?? []) {
                            // ⚠️ если нужно несколько interval одновременно — лучше хранить массив отписок
                            // но оставляем совместимость со старой структурой
                            this.subscription.unsubscribeCandles = await this.ws.subscribeToCandles(
                                { marketType, symbols, interval },
                                createCandleAdapter({
                                    marketType,
                                    interval,
                                    candleService: this.candleService,
                                    connectorType: this.connectorType,
                                    handler: this.handlerForCandle.bind(this),
                                    logger: this.logger,
                                    context: this,
                                }),
                            );
                        }
                        break;

                    case SubscriptionType.PROVIDER_SYMBOLS:
                        const symbolsHandler = createSymbolsAdapter({
                            context: this,
                            marketType,
                            handler: this.handlerForSymbols.bind(this),
                        });

                        this.subscription.unsubscribeSymbols =
                            await this.ws.subscribeToSymbols(
                                { marketType },
                                symbolsHandler,
                            );
                        break;

                    case SubscriptionType.PROVIDER_SYMBOL_PRICES:
                        this.subscription.unsubscribeSymbolPrices = await this.ws.subscribeToSymbolPrices(
                            {
                                marketType,
                                symbols: symbols.map((s) => s.name),
                            },
                            createSymbolPricesAdapter({
                                marketType,
                                handler: this.handlerForSymbolPrices.bind(this),
                            }),
                        );
                        break;
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                const is410 = typeof (err as any)?.response?.status === 'number' && (err as any).response.status === 410;
                this.logger.warn(
                    `Subscription failed [${sub.type}] market=${marketType}: ${msg}${is410 ? ' (endpoint may be deprecated)' : ''}`,
                );
                // не пробрасываем — продолжаем остальные подписки (свечи, трейды и т.д.)
            }
        }
    }

    async updateSubscribeCollection(
        marketType: MarketType,
        symbols: Symbol[],
        intervals?: TimeFrame[],
    ): Promise<void> {
        await this.unsubscribe();

        await new Promise(r => setTimeout(r, 300));

        await this.subscribe(marketType, symbols, intervals);
    }

    // =========================================================================
    // HANDLERS (ДОЛЖНЫ БЫТЬ Promise<void>)
    // =========================================================================
    private async handlerForTrade(
        marketType: MarketType,
        trade: Trade,
    ): Promise<void> {
        try {
            await this.tradeRepository.insert({
                keys: {
                    symbol: trade.symbol?.name ?? '',
                    side: String(trade.side ?? ''),
                },
                fields: {
                    price: Number(trade.price ?? 0),
                    volume: Number(trade.volume ?? 0),
                },
                timestampNs: BigInt(Math.trunc(Number(trade.time ?? Date.now()))) * 1_000_000n,
            });
        } catch (err) {
            this.logger.warn(
                `[trade->questdb] failed ${trade.symbol?.name ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        await this.emit(SubscriptionType.PROVIDER_MARKETDATA_TRADE, marketType, trade);
    }

    private async handlerForOrderBook(
        marketType: MarketType,
        orderbook: OrderBook,
    ): Promise<void> {
        try {
            const symbol = orderbook.symbol?.name ?? '';
            const tsNs = BigInt(Math.trunc(Number(orderbook.time ?? Date.now()))) * 1_000_000n;
            const topN = 20;
            const bids = (orderbook.bids ?? []).slice(0, topN);
            const asks = (orderbook.asks ?? []).slice(0, topN);
            const rows = [
                ...bids.map((level) => ({
                    keys: { symbol, side: 'bid' as const },
                    fields: { price: Number(level.price ?? 0), volume: Number(level.volume ?? 0) },
                    timestampNs: tsNs,
                })),
                ...asks.map((level) => ({
                    keys: { symbol, side: 'ask' as const },
                    fields: { price: Number(level.price ?? 0), volume: Number(level.volume ?? 0) },
                    timestampNs: tsNs,
                })),
            ];
            if (rows.length > 0) {
                await this.orderBookRepository.insertBatch(rows);
            }
        } catch (err) {
            this.logger.warn(
                `[orderbook->questdb] failed ${orderbook.symbol?.name ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        await this.emit(
            SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK,
            marketType,
            orderbook,
        );
    }

    private async handlerForCandle(
        marketType: MarketType,
        candle: Candle,
    ): Promise<void> {
        await this.emit(SubscriptionType.PROVIDER_MARKETDATA_CANDLE, marketType, candle);
    }

    private async handlerForSymbols(
        marketType: MarketType,
        symbols: Symbol[],
    ): Promise<void> {
        const hash = symbols.map((s) => s.name).sort().join('|');
        if (hash === this.lastSymbolsHash) return;
        this.lastSymbolsHash = hash;

        await this.emit(SubscriptionType.PROVIDER_SYMBOLS, marketType, symbols);
    }

    private async handlerForSymbolPrices(
        marketType: MarketType,
        price: SymbolPrice,
    ): Promise<void> {
        await this.emit(SubscriptionType.PROVIDER_SYMBOL_PRICES, marketType, price);
    }

    // =========================================================================
    // EMIT (возвращает Promise<void>, чтобы совпадать с CandleHandler)
    // =========================================================================
    private async emit(
        type: SubscriptionType,
        marketType: MarketType,
        value: any,
    ): Promise<void> {
        const subscription: Subscription = {
            type,
            updateMoment: Date.now(),
            active: true,
        };

        const payload: SubscriptionValue = {
            value,
            options: {
                connectorType: this.connectorType,
                marketType,
                updateMoment: subscription.updateMoment!,
            },
        };

        // ConnectorService.addSubscription({
        //     connectorType: this.connectorType,
        //     marketType,
        //     subscription,
        // });

        if (this.isEmitToRedisEnabled) {
            this.redis.emit(type, payload);
        }
    }

    // =========================================================================
    // READ — PRICES
    // =========================================================================
    async getPrices(
        marketType: MarketType,
        symbols: Symbol[],
    ): Promise<{ [index: string]: { value: number; moment: number } }> {
        await this.client.ensureReady();

        const result: { [index: string]: { value: number; moment: number } } = {};

        let exchangePrices: { [index: string]: string } = {};
        let exchangeTime = Date.now();

        switch (marketType) {
            case MarketType.spot:
                exchangeTime = await this.client.api.time();
                exchangePrices = await this.client.api.prices();
                break;

            case MarketType.futures:
                exchangeTime = await this.client.api.futuresTime();
                exchangePrices = await this.client.api.futuresPrices();
                break;
        }

        for (const symbol of symbols) {
            const price = exchangePrices[symbol.name];
            if (price) {
                result[symbol.name] = {
                    value: Number(price),
                    moment: exchangeTime,
                };
            }
        }

        return result;
    }

    // =========================================================================
    // READ — HISTORY
    // =========================================================================
    async getHistory(options: {
        marketType: MarketType;
        symbols: Symbol[];
        interval: TimeFrame;
        days: number;
        gapDays?: number;
    }): Promise<Candle[]> {
        const { marketType, symbols, interval, days, gapDays = 0 } = options;

        return this.candleService.getHistory({
            connectorType: ConnectorType.binance,
            marketType,
            symbols,
            interval,
            days,
            gapDays,
        });
    }
}
