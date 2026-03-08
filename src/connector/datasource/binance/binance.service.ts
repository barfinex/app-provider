// binance.service.ts
import {
    forwardRef,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    OnModuleDestroy,
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
import {
    MarketDataSnapshot,
    MarketQualityEngine,
    MarketValidationResult,
    MarketTrend,
} from '@barfinex/market-quality';

@Injectable()
// export class BinanceService implements DataSource {
export class BinanceService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(BinanceService.name);
    private readonly accountPayloadWarnSizeBytes = 100_000;
    private readonly ingestStatsLogIntervalMs = Math.max(
        1_000,
        Number(process.env.PROVIDER_INGEST_STATS_LOG_INTERVAL_MS || 5_000),
    );
    private readonly streamCardinalityWarnThreshold = 1_000;

    private readonly connectorType = ConnectorType.binance;
    private readonly isEmitToRedisEnabled = true;
    private readonly marketQualityEngine = new MarketQualityEngine();
    private readonly marketQualitySnapshots = new Map<string, MarketDataSnapshot>();
    private readonly marketQualityReports = new Map<string, MarketValidationResult>();
    private readonly marketQualitySummaryIntervalMs = Math.max(
        10_000,
        Number(process.env.PROVIDER_MARKET_QUALITY_SUMMARY_INTERVAL_MS || 60_000),
    );
    private marketQualitySummaryInterval: NodeJS.Timeout | null = null;

    private lastSymbolsHash: string | null = null;
    private lastAccountEventTime = 0;
    private readonly accountStreamDisabledMarkets = new Set<MarketType>();
    private readonly spotAccountStreamEnabled =
        process.env.BINANCE_SPOT_ACCOUNT_STREAM_ENABLED === 'true';
    private ingestStatsWindowStartedAt = Date.now();
    private tradesIngestedInWindow = 0;
    private orderbookEventsInWindow = 0;
    private tradeRowsWrittenInWindow = 0;
    private orderbookRowsWrittenInWindow = 0;

    private subscription: {
        options?: { symbols: Symbol[]; intervals?: TimeFrame[] };
        unsubscribeAccount?: () => void;
        unsubscribeOrderBook?: () => void;
        unsubscribeTrade?: () => void;
        unsubscribeSymbolPrices?: () => void;
        unsubscribeSymbols?: () => void;
        unsubscribeCandles?: Array<() => void>;
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
    onModuleInit(): void {
        this.marketQualitySummaryInterval = setInterval(() => {
            this.logMarketQualitySummary();
        }, this.marketQualitySummaryIntervalMs);
        this.marketQualitySummaryInterval.unref?.();
    }

    onModuleDestroy(): void {
        if (this.marketQualitySummaryInterval) {
            clearInterval(this.marketQualitySummaryInterval);
            this.marketQualitySummaryInterval = null;
        }
    }

    async ensureReady(): Promise<void> {
        await this.client.ensureReady();
    }

    getMarketQualityReport(
        symbol: string,
        snapshotOverride?: MarketDataSnapshot,
    ): MarketValidationResult | null {
        const normalized = String(symbol || '').trim().toUpperCase();
        if (!normalized) return null;
        const snapshot = snapshotOverride ?? this.marketQualitySnapshots.get(normalized);
        if (snapshot) {
            this.marketQualitySnapshots.set(normalized, snapshot);
            const report = this.marketQualityEngine.evaluateMarketDataQuality(normalized, snapshot);
            this.marketQualityReports.set(normalized, report);
            return report;
        }
        return this.marketQualityReports.get(normalized) ?? this.marketQualityEngine.getLatest(normalized);
    }

    getMarketQualitySnapshot(symbol: string): MarketDataSnapshot | null {
        const normalized = String(symbol || '').trim().toUpperCase();
        if (!normalized) return null;
        return this.marketQualitySnapshots.get(normalized) ?? null;
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

    validateBinanceSymbols(
        marketType: MarketType,
        symbols: string[],
    ): { validSymbols: string[]; removedSymbols: string[] } {
        return this.client.validateBinanceSymbols(marketType, symbols);
    }

    validateBinanceSymbolObjects(
        marketType: MarketType,
        symbols: Symbol[],
    ): { validSymbols: Symbol[]; removedSymbols: string[] } {
        const names = symbols.map((s) => s?.name ?? '');
        const { validSymbols: validNames, removedSymbols } =
            this.client.validateBinanceSymbols(marketType, names);
        const validNameSet = new Set(validNames);
        const dedup = new Set<string>();
        const validSymbols = symbols.filter((s) => {
            const name = String(s?.name ?? '').trim().toUpperCase();
            if (!name || !validNameSet.has(name) || dedup.has(name)) return false;
            dedup.add(name);
            return true;
        });
        return { validSymbols, removedSymbols };
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
        if (this.subscription.unsubscribeCandles?.length) {
            for (const unsubscribeCandle of this.subscription.unsubscribeCandles) {
                unsubscribeCandle();
            }
            this.subscription.unsubscribeCandles = [];
        }
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
        const estimatedStreams = this.estimateActiveStreamCardinality(
            symbols.length,
            Math.max(1, intervals?.length ?? 0),
            connector.subscriptions ?? [],
        );
        if (estimatedStreams >= this.streamCardinalityWarnThreshold) {
            this.logger.warn(
                `[BINANCE WS] high stream cardinality estimate streams=${estimatedStreams} symbols=${symbols.length} intervals=${Math.max(1, intervals?.length ?? 0)} market=${marketType} sharding_recommended=true`,
            );
        }

        for (const sub of connector.subscriptions ?? []) {
            if (!sub.active) continue;

            try {
                switch (sub.type) {
                    case SubscriptionType.PROVIDER_ACCOUNT_EVENT:
                        if (
                            marketType === MarketType.spot
                            && !this.spotAccountStreamEnabled
                        ) {
                            if (!this.accountStreamDisabledMarkets.has(marketType)) {
                                this.accountStreamDisabledMarkets.add(marketType);
                                this.logger.log(
                                    'Spot account stream is disabled (BINANCE_SPOT_ACCOUNT_STREAM_ENABLED!=true); market-data streams stay active.',
                                );
                            }
                            break;
                        }
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
                            createTradeAdapter(this)(
                                marketType,
                                this.handlerForTrade.bind(this),
                            ),
                        );
                        break;

                    case SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK:
                        this.subscription.unsubscribeOrderBook = await this.ws.subscribeToOrderBook(
                            { marketType, symbols },
                            createOrderBookAdapter(this)(
                                marketType,
                                this.handlerForOrderBook.bind(this),
                            ),
                        );
                        break;

                    case SubscriptionType.PROVIDER_MARKETDATA_CANDLE:
                        this.subscription.unsubscribeCandles = [];
                        for (const interval of intervals ?? []) {
                            const unsubscribeCandle = await this.ws.subscribeToCandles(
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
                            this.subscription.unsubscribeCandles.push(unsubscribeCandle);
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
        this.tradesIngestedInWindow += 1;
        this.logIngestSummaryIfDue();
        const symbol = String(trade.symbol?.name ?? '').toUpperCase();
        const snapshot = this.getOrCreateMarketSnapshot(symbol);
        this.applyTradeToSnapshot(snapshot, trade);
        const report = this.evaluateAndTrackMarketQuality(symbol, snapshot);
        if (report.critical) {
            return;
        }
        await this.emit(SubscriptionType.PROVIDER_MARKETDATA_TRADE, marketType, trade);
        try {
            this.tradeRepository.insert({
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
            this.tradeRowsWrittenInWindow += 1;
            this.logIngestSummaryIfDue();
        } catch (err) {
            this.logger.warn(
                `[trade->questdb] failed ${trade.symbol?.name ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    private async handlerForOrderBook(
        marketType: MarketType,
        orderbook: OrderBook,
    ): Promise<void> {
        this.orderbookEventsInWindow += 1;
        this.logIngestSummaryIfDue();
        const symbol = String(orderbook.symbol?.name ?? '').toUpperCase();
        const snapshot = this.getOrCreateMarketSnapshot(symbol);
        this.applyOrderbookToSnapshot(snapshot, orderbook);
        const report = this.evaluateAndTrackMarketQuality(symbol, snapshot);
        if (report.critical) {
            return;
        }
        await this.emit(
            SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK,
            marketType,
            orderbook,
        );
        const writeSymbol = orderbook.symbol?.name ?? '';
        const tsNs = BigInt(Math.trunc(Number(orderbook.time ?? Date.now()))) * 1_000_000n;
        const topN = 20;
        const bids = (orderbook.bids ?? []).slice(0, topN);
        const asks = (orderbook.asks ?? []).slice(0, topN);
        const rows = [
            ...bids.map((level) => ({
                keys: { symbol: writeSymbol, side: 'bid' as const },
                fields: { price: Number(level.price ?? 0), volume: Number(level.volume ?? 0) },
                timestampNs: tsNs,
            })),
            ...asks.map((level) => ({
                keys: { symbol: writeSymbol, side: 'ask' as const },
                fields: { price: Number(level.price ?? 0), volume: Number(level.volume ?? 0) },
                timestampNs: tsNs,
            })),
        ];
        if (rows.length > 0) {
            try {
                this.orderBookRepository.enqueueBatch(rows);
                this.orderbookRowsWrittenInWindow += rows.length;
                this.logIngestSummaryIfDue();
            } catch (err) {
                this.logger.warn(
                    `[orderbook->questdb] failed ${orderbook.symbol?.name ?? 'unknown'}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
    }

    private async handlerForCandle(
        marketType: MarketType,
        candle: Candle,
    ): Promise<void> {
        const symbol = String(candle.symbol?.name ?? '').toUpperCase();
        const snapshot = this.getOrCreateMarketSnapshot(symbol);
        this.applyCandleToSnapshot(snapshot, candle);
        const report = this.evaluateAndTrackMarketQuality(symbol, snapshot);
        if (report.critical) {
            return;
        }
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

        if (type === SubscriptionType.PROVIDER_ACCOUNT_EVENT) {
            let sizeBytes = 0;
            try {
                sizeBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
            } catch {
                sizeBytes = 0;
            }
            if (sizeBytes > this.accountPayloadWarnSizeBytes) {
                const valueAsAny = value as Record<string, unknown> | undefined;
                const positions = Array.isArray(valueAsAny?.positions)
                    ? valueAsAny.positions.length
                    : 0;
                const assets = Array.isArray(valueAsAny?.balances)
                    ? valueAsAny.balances.length
                    : 0;
                this.logger.warn(
                    `[PayloadSizeWarning] channel=${String(type)} size_bytes=${sizeBytes} positions=${positions} assets=${assets}`,
                );
            }
        }

        // ConnectorService.addSubscription({
        //     connectorType: this.connectorType,
        //     marketType,
        //     subscription,
        // });

        if (this.isEmitToRedisEnabled) {
            this.redis.emit(type, payload);
        }
    }

    private logIngestSummaryIfDue(force = false): void {
        const now = Date.now();
        const elapsedMs = now - this.ingestStatsWindowStartedAt;
        if (!force && elapsedMs < this.ingestStatsLogIntervalMs) return;
        const elapsedSec = Math.max(1, elapsedMs / 1000);
        const trades = this.tradesIngestedInWindow;
        const orderbook = this.orderbookEventsInWindow;
        const tradeRows = this.tradeRowsWrittenInWindow;
        const orderbookRows = this.orderbookRowsWrittenInWindow;

        this.ingestStatsWindowStartedAt = now;
        this.tradesIngestedInWindow = 0;
        this.orderbookEventsInWindow = 0;
        this.tradeRowsWrittenInWindow = 0;
        this.orderbookRowsWrittenInWindow = 0;

        if (trades + orderbook + tradeRows + orderbookRows === 0) return;

        this.logger.log(
            `[INGEST] aggregate trades_ingested_per_sec=${(trades / elapsedSec).toFixed(1)} `
            + `orderbook_events_per_sec=${(orderbook / elapsedSec).toFixed(1)} `
            + `questdb_trade_rows_per_sec=${(tradeRows / elapsedSec).toFixed(1)} `
            + `questdb_orderbook_rows_per_sec=${(orderbookRows / elapsedSec).toFixed(1)} `
            + `window_ms=${elapsedMs}`,
        );
    }

    private estimateActiveStreamCardinality(
        symbolsCount: number,
        intervalsCount: number,
        subscriptions: Array<{ type?: SubscriptionType; active?: boolean }>,
    ): number {
        if (symbolsCount <= 0) return 0;
        let estimate = 0;
        for (const subscription of subscriptions) {
            if (!subscription?.active) continue;
            switch (subscription.type) {
                case SubscriptionType.PROVIDER_MARKETDATA_CANDLE:
                    estimate += symbolsCount * Math.max(1, intervalsCount);
                    break;
                case SubscriptionType.PROVIDER_MARKETDATA_TRADE:
                case SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK:
                case SubscriptionType.PROVIDER_SYMBOL_PRICES:
                    estimate += symbolsCount;
                    break;
                case SubscriptionType.PROVIDER_SYMBOLS:
                case SubscriptionType.PROVIDER_ACCOUNT_EVENT:
                    estimate += 1;
                    break;
                default:
                    break;
            }
        }
        return estimate;
    }

    private evaluateAndTrackMarketQuality(
        symbol: string,
        snapshot: MarketDataSnapshot,
    ): MarketValidationResult {
        const report = this.marketQualityEngine.evaluateMarketDataQuality(symbol, snapshot);
        this.marketQualityReports.set(symbol, report);
        if (!report.valid) {
            this.logger.warn(
                `[MarketQuality][Provider] symbol=${report.symbol} healthScore=${report.healthScore.toFixed(2)} orderbook=${report.orderbookStatus} trades=${report.tradeStatus} candles=${report.candleStatus}`,
            );
        }
        return report;
    }

    private getOrCreateMarketSnapshot(symbol: string): MarketDataSnapshot {
        const normalized = String(symbol || '').trim().toUpperCase();
        const existing = this.marketQualitySnapshots.get(normalized);
        if (existing) return existing;
        const now = Date.now();
        const snapshot: MarketDataSnapshot = {
            symbol: normalized,
            orderbook: {
                bestBid: 0,
                bestAsk: 0,
                mid: 0,
                spread: 0,
                spreadPct: Number.POSITIVE_INFINITY,
                bids: [],
                asks: [],
                depth: 0,
                imbalance: 0,
                bidWalls: [],
                askWalls: [],
            },
            trades: {
                tradeCount: 0,
                buyVolume: 0,
                sellVolume: 0,
                aggressiveBuyVolume: 0,
                aggressiveSellVolume: 0,
                avgTradeSize: 0,
                maxTradeSize: 0,
                vwap: 0,
                totalVolume: 0,
                totalNotional: 0,
            },
            candles: { h1: [], h4: [], d1: [] },
            derivedMetrics: {
                volatility: 0,
                liquidity: 0,
                trend: 'unknown',
                regime: 'unknown',
            },
            timestamps: {
                orderbookTimestamp: now,
                tradeTimestamp: now,
                candleTimestamp: now,
            },
        };
        this.marketQualitySnapshots.set(normalized, snapshot);
        return snapshot;
    }

    private applyOrderbookToSnapshot(snapshot: MarketDataSnapshot, orderbook: OrderBook): void {
        const topDepthLevels = 20;
        const bids = (orderbook.bids ?? []).map(level => ({
            price: Number(level.price ?? 0),
            volume: Number(level.volume ?? 0),
        }));
        const asks = (orderbook.asks ?? []).map(level => ({
            price: Number(level.price ?? 0),
            volume: Number(level.volume ?? 0),
        }));
        const validBids = bids
            .filter((level) => level.price > 0 && level.volume > 0)
            .sort((a, b) => b.price - a.price);
        const validAsks = asks
            .filter((level) => level.price > 0 && level.volume > 0)
            .sort((a, b) => a.price - b.price);
        const bestBid = validBids.length > 0 ? validBids[0]!.price : 0;
        const bestAsk = validAsks.reduce((acc, level) => {
            if (!(level.price > 0)) return acc;
            return acc === 0 ? level.price : Math.min(acc, level.price);
        }, 0);
        const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
        const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : 0;
        const spreadPct = mid > 0 ? (spread / mid) * 100 : Number.POSITIVE_INFINITY;
        const bidVolume = validBids.reduce((acc, level) => acc + Math.max(0, level.volume), 0);
        const askVolume = validAsks.reduce((acc, level) => acc + Math.max(0, level.volume), 0);
        const denom = bidVolume + askVolume;
        const boundedBidLevels =
            mid > 0
                ? validBids.filter((level) => level.price >= mid * 0.5 && level.price <= mid * 1.5)
                : validBids;
        const boundedAskLevels =
            mid > 0
                ? validAsks.filter((level) => level.price >= mid * 0.5 && level.price <= mid * 1.5)
                : validAsks;

        snapshot.orderbook.bestBid = bestBid;
        snapshot.orderbook.bestAsk = bestAsk;
        snapshot.orderbook.mid = mid;
        snapshot.orderbook.spread = spread;
        snapshot.orderbook.spreadPct = spreadPct;
        snapshot.orderbook.bids = boundedBidLevels.slice(0, topDepthLevels);
        snapshot.orderbook.asks = boundedAskLevels.slice(0, topDepthLevels);
        snapshot.orderbook.depth = snapshot.orderbook.bids.length + snapshot.orderbook.asks.length;
        snapshot.orderbook.imbalance = denom > 0 ? (bidVolume - askVolume) / denom : 0;
        snapshot.orderbook.bidWalls = snapshot.orderbook.bids
            .slice()
            .sort((a, b) => b.volume - a.volume)
            .slice(0, 3);
        snapshot.orderbook.askWalls = snapshot.orderbook.asks
            .slice()
            .sort((a, b) => b.volume - a.volume)
            .slice(0, 3);
        const orderbookTimestamp = Number(orderbook.time ?? Date.now());
        snapshot.timestamps.orderbookTimestamp = Math.min(
            Date.now(),
            Number.isFinite(orderbookTimestamp) && orderbookTimestamp > 0 ? orderbookTimestamp : Date.now(),
        );
        this.refreshDerivedMetrics(snapshot);
    }

    private applyTradeToSnapshot(snapshot: MarketDataSnapshot, trade: Trade): void {
        const price = Number(trade.price ?? 0);
        const volume = Number(trade.volume ?? 0);
        const tradeTimestamp = Number(trade.time ?? Date.now());
        const isBuy = String(trade.side ?? '').toUpperCase() === 'LONG';
        snapshot.trades.tradeCount += 1;
        snapshot.trades.buyVolume += isBuy ? Math.max(0, volume) : 0;
        snapshot.trades.sellVolume += isBuy ? 0 : Math.max(0, volume);
        snapshot.trades.aggressiveBuyVolume += isBuy ? Math.max(0, volume) : 0;
        snapshot.trades.aggressiveSellVolume += isBuy ? 0 : Math.max(0, volume);
        snapshot.trades.maxTradeSize = Math.max(snapshot.trades.maxTradeSize, Math.max(0, volume));
        snapshot.trades.totalVolume = Number(snapshot.trades.totalVolume ?? 0) + Math.max(0, volume);
        snapshot.trades.totalNotional =
            Number(snapshot.trades.totalNotional ?? 0) + Math.max(0, price * volume);
        const totalVolume = Number(snapshot.trades.totalVolume ?? 0);
        snapshot.trades.avgTradeSize =
            snapshot.trades.tradeCount > 0 ? totalVolume / snapshot.trades.tradeCount : 0;
        snapshot.trades.vwap =
            totalVolume > 0 ? Number(snapshot.trades.totalNotional ?? 0) / totalVolume : 0;
        snapshot.trades.lastTrade = {
            price,
            volume,
            timestamp: tradeTimestamp,
        };
        snapshot.timestamps.tradeTimestamp = Math.min(
            Date.now(),
            Number.isFinite(tradeTimestamp) && tradeTimestamp > 0 ? tradeTimestamp : Date.now(),
        );
        this.refreshDerivedMetrics(snapshot);
    }

    private applyCandleToSnapshot(snapshot: MarketDataSnapshot, candle: Candle): void {
        const interval = String(candle.interval ?? TimeFrame.h1).toLowerCase();
        const point = {
            time: Number(candle.time ?? Date.now()),
            open: Number(candle.open ?? 0),
            high: Number(candle.high ?? 0),
            low: Number(candle.low ?? 0),
            close: Number(candle.close ?? 0),
            volume: Number(candle.volume ?? 0),
        };
        const key: 'h1' | 'h4' | 'd1' = interval.includes('h4')
            ? 'h4'
            : interval.includes('day') || interval.includes('d1')
                ? 'd1'
                : 'h1';
        const bucket = snapshot.candles[key];
        const idx = bucket.findIndex(row => Number(row.time) === point.time);
        if (idx >= 0) {
            bucket[idx] = point;
        } else {
            bucket.push(point);
            bucket.sort((a, b) => a.time - b.time);
            if (bucket.length > 300) {
                bucket.splice(0, bucket.length - 300);
            }
        }
        snapshot.timestamps.candleTimestamp = point.time;
        this.refreshDerivedMetrics(snapshot);
    }

    private refreshDerivedMetrics(snapshot: MarketDataSnapshot): void {
        const closes = snapshot.candles.h1
            .map(c => Number(c.close ?? NaN))
            .filter(value => Number.isFinite(value) && value > 0);
        let volatility = 0;
        if (closes.length >= 3) {
            const returns: number[] = [];
            for (let i = 1; i < closes.length; i += 1) {
                const prev = closes[i - 1]!;
                const curr = closes[i]!;
                returns.push((curr - prev) / prev);
            }
            const mean = returns.reduce((acc, value) => acc + value, 0) / returns.length;
            const variance = returns.reduce((acc, value) => acc + Math.pow(value - mean, 2), 0) / returns.length;
            volatility = Math.sqrt(Math.max(0, variance));
        }
        const spreadPct = Number(snapshot.orderbook.spreadPct ?? Number.POSITIVE_INFINITY);
        const depth = Number(snapshot.orderbook.depth ?? 0);
        const depthScore = depth > 0 ? Math.min(1, depth / 100) : 0;
        const spreadScore = Number.isFinite(spreadPct) ? 1 - Math.min(1, spreadPct / 0.5) : 0;
        const liquidity = Math.max(0, Math.min(1, depthScore * 0.35 + spreadScore * 0.65));
        const trend = this.resolveTrend(snapshot);
        const regime = liquidity < 0.2 ? 'breakout' : volatility < 0.003 ? 'range' : 'trend';

        snapshot.derivedMetrics.volatility = volatility;
        snapshot.derivedMetrics.liquidity = liquidity;
        snapshot.derivedMetrics.trend = trend;
        snapshot.derivedMetrics.regime = regime;
    }

    private resolveTrend(snapshot: MarketDataSnapshot): MarketTrend {
        const h1 = snapshot.candles.h1;
        if (h1.length < 3) return 'unknown';
        const last = Number(h1[h1.length - 1]?.close ?? NaN);
        const prev = Number(h1[h1.length - 3]?.close ?? NaN);
        if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0) return 'unknown';
        if (last > prev) return 'up';
        if (last < prev) return 'down';
        return 'mixed';
    }

    private logMarketQualitySummary(): void {
        const activeFromSubscriptions = this.subscription.options?.symbols?.map(symbol => symbol?.name) ?? [];
        const activeSymbols = new Set<string>([
            ...activeFromSubscriptions.map(symbol => String(symbol || '').toUpperCase()).filter(Boolean),
            ...Array.from(this.marketQualitySnapshots.keys()),
        ]);
        if (activeSymbols.size === 0) return;

        this.logger.log('[MarketQualitySummary]');
        for (const symbol of activeSymbols) {
            const snapshot = this.marketQualitySnapshots.get(symbol);
            if (!snapshot) continue;
            const report = this.marketQualityEngine.evaluateMarketDataQuality(symbol);
            this.marketQualityReports.set(symbol, report);
            this.logger.log(
                `[MarketQualitySummary] ${symbol} health=${report.healthScore.toFixed(2)} orderbook=${report.orderbookStatus} trades=${report.tradeStatus} candles=${report.candleStatus}`,
            );
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
