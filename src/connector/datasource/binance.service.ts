import { forwardRef, Inject, Injectable, InternalServerErrorException, Logger, OnModuleInit } from "@nestjs/common";
import { AppError, ErrorEnvironment } from '../../error';
import Binance, {
    BidDepth as BinanceBidDepth,
    Candle as BinanceCandle,
    CandleChartInterval,
    Depth as BinanceDepth,
    AggregatedTrade as BinanceAggregatedTrade,
    ExchangeInfo,
    FuturesOrder,
    NewFuturesOrder,
    NewOrderMarketBase,
    Order as BinanceOrder,
    FuturesOrder as BinanceFuturesOrder,
    OrderSide as OrderSideBinance,
    OrderType as BinanceOrderType,
    PositionSide,
    NewOrderSpot,
    NewOrderLimit,
    NewOrderSL,
    MarketNewFuturesOrder,
    LimitNewFuturesOrder,
    TakeProfitNewFuturesOrder,
    StopNewFuturesOrder,
    OutboundAccountInfo,
    ExecutionReport,
    AccountUpdate,
    OrderUpdate,
    MarginCall,
    AccountConfigUpdate,
    UserDataStreamEvent,
    TakeProfitMarketNewFuturesOrder,
    StopMarketNewFuturesOrder,
    FuturesIncomeResult
} from 'binance-api-node';
import { ClientProxy, Transport, ClientProxyFactory, RedisOptions } from '@nestjs/microservices';
import {
    Order,
    DataSource,
    OrderSide,
    OrderType,
    TimeFrame,
    CandleHandler,
    OrderBookHandler,
    TradeHandler,
    DepthOrder,
    Candle,
    Trade,
    TradeSide,
    OrderBook,
    Account,
    Asset,
    Position,
    ConnectorType,
    MarketType,
    SubscriptionType,
    AccountEventHandler,
    AccountEvent,
    Subscription,
    OrderSourceType,
    Symbol,
    SymbolPrice,
    AccountDailyProfitDetail,
    SubscriptionValue,
    CandleRaw,
} from '@barfinex/types';
import moment from 'moment';
import { ConnectorService } from "../connector.service";
import axios from 'axios';
import { WebSocketService } from './websocket.service';
import { InjectRepository } from "@nestjs/typeorm";
import { SymbolEntity } from "../../symbol/symbol.entity";
import { Repository } from "typeorm";
import { ConfigService } from "@barfinex/config/config.service";
import { CandleService } from '../../candle/candle.service';
import { CandleEntity } from "../../candle/candle.entity";
import { Console } from "console";
import { candleMapper } from "@barfinex/utils/src";

@Injectable()
export class BinanceService implements OnModuleInit, DataSource {

    private readonly logger = new Logger(BinanceService.name);

    private isEmitToRedisEnabled = true

    private lastSymbolsHash: string | null = null;

    private connectorType = ConnectorType.binance


    private subscription: {
        options?: { symbols: Symbol[], intervals: TimeFrame[] }
        unsubscribeAccount?: () => void;
        unsubscribeOrderBook?: () => void;
        unsubscribeTrade?: () => void;
        unsubscribeSymbolPrices?: () => void;
        unsubscribeSymbols?: () => void;
        unsubscribeCandles?: () => void;
    } = {};

    private lastAccountAdapterEventTime: number = 0

    delay = async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms));

    private readonly api: ReturnType<typeof Binance>;

    protected candles: Candle[] = [];

    get currentCandle() {
        return this.candles[0];
    }

    private readonly client: ClientProxy;

    protected providerKey: string = null

    constructor(
        private readonly configService: ConfigService,
        private readonly webSocketService: WebSocketService,

        @InjectRepository(SymbolEntity)
        private readonly symbolRepository: Repository<SymbolEntity>,

        @Inject(forwardRef(() => CandleService))
        private readonly candleService: CandleService,

    ) {

        const tcpHost = process.env.REDIS_HOST || 'localhost';
        const tcpPort = parseInt(process.env.REDIS_PORT, 10) || 6379;

        if (isNaN(tcpPort) || tcpPort < 0 || tcpPort > 65535) this.logger.error(`Invalid TCP port: ${tcpPort}`);

        this.logger.log(`Connecting to Redis on ${tcpHost}:${tcpPort}`);

        this.client = ClientProxyFactory.create({
            transport: Transport.REDIS,
            options: {
                host: tcpHost,
                port: tcpPort
            },
        } as RedisOptions);


        this.providerKey = this.configService.getConfig().provider.key

        const securityConfig = this.configService.getConfig().provider.connectors.find(q => q.connectorType == this.connectorType);



        type BinanceTimeResponse = { serverTime: number };

        const fetchBinanceTime = async (): Promise<number> => {
            const res = await fetch('https://api.binance.com/api/v3/time');
            const { serverTime } = (await res.json()) as Partial<BinanceTimeResponse>;

            if (typeof serverTime !== 'number') {
                throw new InternalServerErrorException('Invalid Binance time response');
            }

            return serverTime;
        };


        if (securityConfig?.key && securityConfig?.secret) {
            this.api = Binance({
                apiKey: process.env.BINANCE_API_KEY,
                apiSecret: process.env.BINANCE_API_SECRET,
                getTime: fetchBinanceTime
            });
        } else {
            this.logger.error('Binance API keys are not configured properly.');
            throw new InternalServerErrorException('Binance API keys are missing in the configuration.');
        }



    }

    async onModuleInit() {
        this.logger.log(`ModuleInit`);

        try {
            await this.client.connect();
            this.logger.log('Connected to Redis successfully!');
        } catch (error) {
            this.logger.error('Failed to connect to Redis:', error?.message || error);
        }

        try {
            this.api?.time()
                .then(time => {
                    this.logger.log(
                        "Binance time:",
                        moment.utc(time).format('YYYY-MM-DD HH:mm:ss'),
                        "Local time:",
                        moment.utc(Date.now()).format('YYYY-MM-DD HH:mm:ss')
                    );
                })
                .catch(err => {
                    this.logger.error("Error fetching Binance time:", err?.message || err);
                });
        } catch (err) {
            this.logger.error("Unhandled error in onModuleInit:", err?.message || err);
        }
    }




    /**
     * Fetches current prices for the given symbols in a specified market type.
     * @param marketType - Market type (spot or futures).
     * @param symbols - Array of trading symbols.
     * @returns An object mapping symbols to their current price and timestamp.
     */
    async getPrices(marketType: MarketType, symbols: Symbol[]): Promise<{ [index: string]: { value: number, moment: number } }> {

        let result: { [index: string]: { value: number, moment: number } } = {}

        let exchangePrices: { [index: string]: string } = {}
        let exchangeTime: number


        switch (marketType) {
            case MarketType.spot:
                exchangeTime = await this.api?.time();
                exchangePrices = await this.api?.prices()
                break;
            case MarketType.futures:
                exchangeTime = await this.api?.futuresTime();
                exchangePrices = await this.api?.futuresPrices()
                break;
        }

        symbols.forEach(symbol => {
            if (exchangePrices[symbol.name]) result[symbol.name] = { value: Number(exchangePrices[symbol.name]), moment: exchangeTime }
        });
        return result
    }

    async getHistory(options: {
        marketType: MarketType;
        symbols: Symbol[];
        interval: TimeFrame;
        days: number;         // как у вас (например 7/100)
        gapDays?: number;     // опционально
    }): Promise<CandleEntity[]> {
        const { marketType, symbols, interval, days, gapDays = 0 } = options;

        return this.candleService.getHistory({
            connectorType: ConnectorType.binance,
            marketType,
            symbols,
            days,
            interval,
            gapDays,
        });
    }


    /**
     * Retrieves asset and position information for a specified market type.
     * @param marketType - Market type (spot or futures).
     * @returns Object containing arrays of assets and positions.
     */
    async getAssetsInfo(marketType: MarketType): Promise<{ assets: Asset[], positions: Position[] }> {

        const currency = 'USDT'

        let result: { assets: Asset[], positions: Position[] } = {
            assets: [],
            positions: []
        };


        switch (marketType) {
            case MarketType.spot:

                const pricesSpot = await this.api?.prices();
                const accountInfoSpot = (await this.api?.accountInfo()).balances.filter(q => parseFloat(q.free) != 0 || parseFloat(q.locked));
                accountInfoSpot.forEach(element => {
                    result.assets.push({
                        connectorType: this.connectorType,
                        marketType,
                        symbol: { name: element.asset },
                        walletBalance: parseFloat(element.free) + parseFloat(element.locked),
                        availableBalance: parseFloat(element.free),
                        price: [{ currency, value: (element.asset == currency) ? parseFloat('1') : parseFloat(pricesSpot[element.asset + currency]) }]
                    })
                });
                break;
            case MarketType.futures:

                const pricesFutures = await this.api?.futuresPrices();

                const accountInfoFutures = await this.api?.futuresAccountInfo();
                const accountInfoFutures_Assets = accountInfoFutures.assets.filter(q => parseFloat(q.walletBalance) != 0 || parseFloat(q.availableBalance));
                accountInfoFutures_Assets.forEach(element => {
                    result.assets.push({
                        connectorType: this.connectorType,
                        marketType,
                        symbol: { name: element.asset },
                        walletBalance: parseFloat(element.walletBalance),
                        availableBalance: parseFloat(element.availableBalance),
                        price: [{ currency, value: (element.asset == currency) ? parseFloat('1') : parseFloat(pricesFutures[element.asset + currency]) }]
                    })
                });

                const accountInfoFutures_Positions = accountInfoFutures.positions.filter(q => parseFloat(q.positionAmt) != 0);
                accountInfoFutures_Positions.forEach(element => {
                    result.positions.push({
                        connectorType: this.connectorType,
                        marketType,
                        symbol: { name: element.symbol },
                        quantity: parseFloat(element.positionAmt),
                        entryPrice: parseFloat(element.entryPrice),
                        initialMargin: parseFloat(element.initialMargin),
                        leverage: parseFloat(element.leverage),
                        side: (parseFloat(element.positionAmt) > 0) ? TradeSide.LONG : TradeSide.SHORT,
                        lastPrice: Number(pricesFutures[element.symbol])
                    })
                });
                break;
        }

        return result;
    }

    /**
     * Retrieves information about tradable symbols for a specific connector and market type.
     * @param connectorType - The type of the connector (e.g., Binance).
     * @param marketType - Market type (spot, futures, or margin).
     * @returns An array of symbol details.
     */
    async getSymbolsInfo(connectorType: ConnectorType, marketType: MarketType): Promise<Symbol[]> {

        const resultSymbols: Symbol[] = [];

        if (connectorType === ConnectorType.binance) {
            try {
                if (marketType === MarketType.spot) {
                    // Получение информации о спотовых рынках
                    const exchangeInfo = await this.api?.exchangeInfo();
                    exchangeInfo.symbols.forEach((item) => {
                        resultSymbols.push({
                            name: item.symbol,
                            baseAsset: item.baseAsset,
                            quoteAsset: item.quoteAsset,
                            status: item.status,
                            minPrice: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.minPrice,
                            maxPrice: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.maxPrice,
                            minQuantity: item.filters.find((filter) => filter.filterType === 'LOT_SIZE')?.minQty,
                            stepSize: item.filters.find((filter) => filter.filterType === 'LOT_SIZE')?.stepSize,
                            tickSize: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.tickSize,
                            isSpotTradingAllowed: item.isSpotTradingAllowed,
                            isMarginTradingAllowed: item.isMarginTradingAllowed,
                            connectorType: connectorType,
                            marketType: marketType,
                        });
                    });

                } else if (marketType === MarketType.futures) {
                    const exchangeInfo = await this.api?.futuresExchangeInfo();
                    exchangeInfo.symbols.forEach((item) => {
                        resultSymbols.push({
                            name: item.symbol, // <-- исправлено
                            baseAsset: item.baseAsset,
                            quoteAsset: item.quoteAsset,
                            status: item.status,
                            minPrice: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.minPrice,
                            maxPrice: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.maxPrice,
                            minQuantity: item.filters.find((filter) => filter.filterType === 'LOT_SIZE')?.minQty,
                            stepSize: item.filters.find((filter) => filter.filterType === 'LOT_SIZE')?.stepSize,
                            tickSize: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.tickSize,
                            isSpotTradingAllowed: false,
                            isMarginTradingAllowed: false,
                            connectorType: connectorType,
                            marketType: marketType,
                        });
                    });

                } else if (marketType === MarketType.margin) {

                    const securityConfig = this.configService.getConfig().provider.connectors.find(q => q.connectorType == this.connectorType);

                    const restApiUrl = 'https://api.binance.com/sapi/v1/margin/allPairs';
                    const response = await axios.get(restApiUrl, {
                        headers: {
                            'X-MBX-APIKEY': securityConfig.key,
                        },
                    });

                    response.data.forEach((item: any) => {
                        resultSymbols.push({
                            name: `${item.baseAsset}${item.quoteAsset}`,
                            baseAsset: item.baseAsset,
                            quoteAsset: item.quoteAsset,
                            status: 'TRADING',
                            connectorType: connectorType,
                            marketType: marketType,
                        });
                    });
                }
            } catch (error) {
                this.logger.error(
                    `Error fetching symbols from Binance for connectorType: ${connectorType}, marketType: ${marketType}`,
                    error.stack,
                );

                throw new InternalServerErrorException('Failed to fetch symbols from Binance. Please try again later.');
            }
        }

        return resultSymbols;
    }


    /**
     * Retrieves detailed account information for a specified market type.
     * @param marketType - Market type (spot or futures).
     * @returns Object containing account assets, positions, orders, and more.
     */
    async getAccountInfo(marketType: MarketType): Promise<Account> {

        const currency = 'USDT'

        let account: Account = {
            connectorType: this.connectorType,
            marketType,
            assets: [],
            positions: [],
            orders: [],
            symbols: [],
            isActive: false,
        };


        let startIncomeTime = Number(moment.utc(moment().utc()).add(-1, 'days').format('x'))
        let endIncomeTime = Number(moment().utc().format('x'))

        // if (this.connectorType == ProviderType.binance) {
        switch (marketType) {
            case MarketType.spot:

                const pricesSpot = await this.api?.prices();


                const accountInfoSpot = (await this.api?.accountInfo())?.balances.filter(q => parseFloat(q.free) != 0 || parseFloat(q.locked));


                accountInfoSpot?.forEach(element => {
                    account.assets.push({
                        connectorType: this.connectorType,
                        marketType,
                        symbol: { name: element.asset },
                        walletBalance: parseFloat(element.free) + parseFloat(element.locked),
                        availableBalance: parseFloat(element.free),
                        price: [{ currency, value: (element.asset == currency) ? parseFloat('1') : parseFloat(pricesSpot[element.asset + currency] ? pricesSpot[element.asset + currency] : '0') }]

                    })

                });

                account.dailyProfit = {
                    value: 0,
                    startTime: startIncomeTime,
                    endTime: endIncomeTime,
                    details: []
                };

                break;
            case MarketType.futures:

                const pricesFutures = await this.api?.futuresPrices();
                const accountInfoFutures = await this.api?.futuresAccountInfo();
                const accountInfoFutures_Assets = accountInfoFutures?.assets.filter(q => Number(q.walletBalance) != 0 && Number(q.availableBalance) != 0);
                accountInfoFutures_Assets?.forEach(element => {
                    account.assets.push({
                        connectorType: this.connectorType,
                        marketType,
                        symbol: { name: element.asset },
                        walletBalance: parseFloat(element.walletBalance),
                        availableBalance: parseFloat(element.availableBalance),
                        price: [{ currency, value: (element.asset == currency) ? parseFloat('1') : parseFloat(pricesFutures[element.asset + currency]) }]
                    })
                });

                const accountInfoFutures_Positions = accountInfoFutures?.positions.filter(q => parseFloat(q.positionAmt) != 0);
                accountInfoFutures_Positions?.forEach(element => {

                    if (!account.symbols.find(q => q.name == element.symbol)) account.symbols.push({ name: element.symbol });

                    account.positions.push({
                        connectorType: this.connectorType,
                        marketType,
                        symbol: { name: element.symbol },
                        quantity: parseFloat(element.positionAmt),
                        entryPrice: parseFloat(element.entryPrice),
                        initialMargin: parseFloat(element.initialMargin),
                        leverage: parseFloat(element.leverage),
                        side: (parseFloat(element.positionAmt) > 0) ? TradeSide.LONG : TradeSide.SHORT,
                        lastPrice: Number(pricesFutures[element.symbol])
                    })

                });

                const filterAssets = account.assets.filter(q => q.symbol.name != currency)

                for (let i = 0; i < filterAssets.length; i++) {
                    const asset = filterAssets[i];

                    const orders = await this.api?.futuresOpenOrders({ symbol: asset.symbol + currency } as any);

                    let type: OrderType
                    let side: OrderSide

                    orders.forEach(order => {

                        side = order.side as OrderSide

                        switch (order.type.toString()) {
                            // case 'MARKET': type = OrderType.MARKET; break
                            case 'LIMIT': type = OrderType.LIMIT; break
                            case 'TAKE_PROFIT_LIMIT': type = OrderType.TAKE_PROFIT; break
                            case 'STOP_LOSS_LIMIT': type = OrderType.STOP; break
                            default: type = OrderType.MARKET; break
                        }

                        return account.orders.push({
                            symbol: { name: order.symbol },
                            side: side,
                            type: type,
                            quantity: Number(order.origQty),
                            updateTime: order.updateTime,
                            time: order.time,
                            price: Number(order.price),
                            useSandbox: false,
                            connectorType: this.connectorType,
                            marketType: marketType,
                            source: {
                                type: OrderSourceType.provider,
                                key: this.connectorType,
                                restApiUrl: this.configService.getConfig().provider.restApiUrl
                            }
                        });
                    });

                }



                const futuresIncome: FuturesIncomeResult[] = await this.api?.futuresIncome({
                    startTime: startIncomeTime,
                })

                let income = 0.00

                if (futuresIncome) {
                    for (let i = 0; i < futuresIncome.length; i++) {
                        const element = futuresIncome[i];

                        if (i == 0) startIncomeTime = Number(moment.utc(element.time).format('x'))
                        endIncomeTime = Number(moment.utc(element.time).format('x'))
                        income += Number(element.income)
                    }
                }


                const details: AccountDailyProfitDetail[] = []
                futuresIncome.forEach(income => {
                    details.push({
                        symbol: { name: income.symbol },
                        incomeType: income.incomeType,
                        income: income.income,
                        asset: income.asset,
                        info: income.info,
                        time: income.time
                    })
                });

                account.dailyProfit = {
                    value: income,
                    startTime: startIncomeTime,
                    endTime: endIncomeTime,
                    details: details
                };

                break;
        }
        if (account.assets.length > 0) account.isActive = true

        return account
    }

    async changeLeverage(symbol: Symbol, newLeverage: number): Promise<Symbol> {
        const result = await this.api?.futuresLeverage({ symbol: symbol.name, leverage: newLeverage })
        return { name: result.symbol, leverage: result.leverage };
    }

    /**
     * Places a new order.
     * @param order - The order details, such as symbol, side, type, and quantity.
     * @returns A Promise resolving to the placed order with updated details.
     */
    async openOrder(order: Order): Promise<Order> {


        if (!order.useSandbox) {


            switch (order.marketType) {
                case MarketType.spot:

                    let spotOrderToProvider: NewOrderSpot;

                    switch (order.type) {

                        case OrderType.MARKET:
                            spotOrderToProvider = {
                                type: BinanceOrderType.MARKET,
                                symbol: order.symbol.name,
                                side: order.side.toString(),
                                quantity: order.quantity.toString(),
                            } as NewOrderMarketBase
                            break;

                        case OrderType.LIMIT:
                            spotOrderToProvider = {
                                type: BinanceOrderType.LIMIT,
                                symbol: order.symbol.name,
                                side: order.side.toString(),
                                // 'GTC' - Good Till Cancelled | 'IOC' - Immediate or Cancel | 'FOK' - Fill or Kill
                                timeInForce: 'GTC',
                                quantity: order.quantity.toString(),
                                price: order.price.toString(),
                            } as NewOrderLimit
                            break;

                        case OrderType.TAKE_PROFIT:
                            spotOrderToProvider = {
                                type: BinanceOrderType.TAKE_PROFIT_LIMIT,
                                symbol: order.symbol.name,
                                side: order.side.toString(),
                                quantity: order.quantity.toString(),
                                price: order.price.toString(),
                                // stopPrice: order.priceStop.toString(),
                            } as NewOrderSL
                            break;

                        case OrderType.STOP:
                            spotOrderToProvider = {
                                type: BinanceOrderType.STOP_LOSS_LIMIT,
                                symbol: order.symbol.name,
                                side: order.side.toString(),
                                quantity: order.quantity.toString(),
                                price: order.price.toString(),
                                // stopPrice: order.priceStop.toString(),
                            } as NewOrderSL
                            break;
                    }


                    const spotOrderEntity = await this.api?.order(spotOrderToProvider)
                    order.externalId = spotOrderEntity.orderId.toString()
                    order.updateTime = spotOrderEntity.updateTime

                    break;
                case MarketType.futures:

                    let futuresOrderToProvider: NewFuturesOrder;

                    switch (order.type) {

                        case OrderType.MARKET:
                            futuresOrderToProvider = {
                                type: order.type,
                                symbol: order.symbol.name,
                                side: order.side.toString(),
                                quantity: order.quantity.toString(),
                            } as MarketNewFuturesOrder
                            break;

                        case OrderType.LIMIT:
                            futuresOrderToProvider = {
                                type: order.type,
                                symbol: order.symbol.name,
                                side: order.side.toString(),
                                // 'GTC' - Good Till Cancelled | 'IOC' - Immediate or Cancel | 'FOK' - Fill or Kill
                                timeInForce: 'GTC',
                                quantity: order.quantity.toString(),
                                price: order.price.toString(),
                            } as LimitNewFuturesOrder
                            break;

                        case OrderType.TAKE_PROFIT:
                            futuresOrderToProvider = {
                                type: order.type,
                                symbol: order.symbol.name,
                                side: order.side.toString(),
                                quantity: order.quantity.toString(),
                                //price: order.price.toString(),
                                stopPrice: order.price.toString(),
                            } as TakeProfitNewFuturesOrder
                            break;

                        case OrderType.STOP:
                            futuresOrderToProvider = {
                                type: order.type,
                                symbol: order.symbol.name,
                                side: order.side.toString(),
                                quantity: order.quantity.toString(),
                                //price: order.price.toString(),
                                stopPrice: order.price.toString(),
                            } as StopNewFuturesOrder
                            break;

                        case OrderType.TAKE_PROFIT_MARKET:
                            futuresOrderToProvider = {
                                type: order.type,
                                symbol: order.symbol.name,
                                side: order.side.toString(),
                                quantity: order.quantity.toString(),
                                stopPrice: order.price.toString(),
                                workingType: "MARK_PRICE",
                                priceProtect: "TRUE",
                                priceMatch: "NONE",
                                selfTradePreventionMode: "NONE",
                                goodTillDate: 0,
                                positionSide: "BOTH",
                                closePosition: "true",
                            } as TakeProfitMarketNewFuturesOrder
                            break;

                        case OrderType.STOP_MARKET:
                            futuresOrderToProvider = {
                                type: order.type,
                                symbol: order.symbol.name,
                                side: order.side.toString(),
                                quantity: order.quantity.toString(),
                                stopPrice: order.price.toString(),
                                workingType: "MARK_PRICE",
                                priceProtect: "TRUE",
                                priceMatch: "NONE",
                                selfTradePreventionMode: "NONE",
                                goodTillDate: 0,
                                positionSide: "BOTH",
                                closePosition: "true",
                            } as StopMarketNewFuturesOrder
                            break;
                    }

                    let orders: Order[] = await this.getOpenOrders({ marketType: order.marketType })

                    let futuresOrderEntity: FuturesOrder = null

                    if (!orders.find(q => q.symbol.name == futuresOrderToProvider.symbol && q.type == futuresOrderToProvider.type && q.side == futuresOrderToProvider.side)) {
                        futuresOrderEntity = await this.api?.futuresOrder(futuresOrderToProvider)
                    }

                    if (futuresOrderEntity) {
                        order.externalId = futuresOrderEntity.orderId.toString()
                        order.updateTime = futuresOrderEntity.updateTime
                    }
                    break;
            }

        }
        return order;
    }



    /**
     * Closes an existing order by its ID.
     * @param options - Object containing the order ID, symbol, and market type.
     * @returns A Promise resolving to the closed order.
     */
    async closeOrder(options: { id: string, symbol: Symbol, marketType: MarketType }): Promise<Order> {

        const { id, symbol, marketType } = options

        const orders = await this.api?.futuresOpenOrders({ symbol: symbol.name });
        const element = orders.find(q => q.orderId == id)

        const order: Order = {
            symbol: { name: element.symbol },
            externalId: element.orderId.toString(),
            side: element.side.toString() as OrderSide,
            type: element.type.toString() as OrderType,
            price: parseFloat(element.price),
            quantity: parseFloat(element.origQty),
            time: element.time,
            updateTime: element.updateTime,
            source: {
                type: OrderSourceType.provider,
                key: this.connectorType,
                restApiUrl: this.configService.getConfig().provider.restApiUrl
            },
            useSandbox: false,
            marketType,
            connectorType: this.connectorType
        }

        if (element) await this.api?.futuresCancelOrder({ orderId: +id, symbol: symbol.name })

        return order
    }

    /**
     * Closes all open orders for a specific symbol and market type.
     * @param options - Object containing the symbol and market type.
     * @returns A Promise that resolves when all orders are closed.
     */
    async closeAllOrders(options: { symbol: Symbol, marketType: MarketType }): Promise<void> {

        const { symbol, marketType } = options

        if (marketType == MarketType.spot) {
            await this.api?.cancelOpenOrders({ symbol: symbol.name })
        } else {
            await this.api?.futuresCancelAllOpenOrders({ symbol: symbol.name })
        }

    }


    /**
     * Retrieves a list of open orders for a specific symbol and market type.
     * @param options - Object containing the optional symbol and market type.
     * @returns A Promise resolving to an array of open orders.
     */
    public async getOpenOrders(options: { symbol?: Symbol, marketType: MarketType }): Promise<Order[]> {

        let result: Order[] = []

        const { symbol, marketType } = options

        if (marketType == MarketType.spot) {

            const ordersInProvider_Spot = await this.api?.openOrders((symbol) ? { symbol: symbol.name } : {});

            for (let i = 0; i < ordersInProvider_Spot.length; i++) {
                const element = ordersInProvider_Spot[i];

                let order: Order = {
                    symbol: { name: element.symbol },
                    externalId: element.orderId.toString(),
                    side: element.side.toString() as OrderSide,
                    type: element.type.toString() as OrderType,
                    price: parseFloat(element.price),
                    quantity: parseFloat(element.origQty),
                    time: element.time,
                    updateTime: element.updateTime,
                    source: {
                        type: OrderSourceType.provider,
                        key: this.connectorType,
                        restApiUrl: this.configService.getConfig().provider.restApiUrl
                    },
                    useSandbox: false,
                    marketType,
                    connectorType: this.connectorType
                }

                result.push(order);
            }

        } else {

            const ordersInProvider_Futures = await this.api?.futuresOpenOrders((symbol) ? { symbol: symbol.name } : {});

            ordersInProvider_Futures.forEach(order => {

                const type = order.type.toString() as OrderType
                let price = parseFloat(order.price)

                if (type == OrderType.STOP_MARKET || type == OrderType.TAKE_PROFIT_MARKET)
                    price = parseFloat(order.stopPrice)

                result.push({
                    symbol: { name: order.symbol },
                    externalId: order.orderId,
                    side: order.side.toString() as OrderSide,
                    type: type,
                    price: price,
                    quantity: parseFloat(order.origQty),
                    time: order.time,
                    updateTime: order.updateTime,
                    useSandbox: false,
                    connectorType: this.connectorType,
                    marketType: marketType,
                    source: {
                        type: OrderSourceType.provider,
                        key: this.connectorType,
                        restApiUrl: this.configService.getConfig().provider.restApiUrl
                    }
                });
            });
        }

        return result

    }

    /**
     * Unsubscribes from all active subscriptions.
     * @returns A Promise that resolves when all subscriptions are successfully unsubscribed.
     */
    public async unsubscribe(): Promise<void> {

        if (this.subscription.unsubscribeAccount) this.subscription.unsubscribeAccount()
        if (this.subscription.unsubscribeOrderBook) this.subscription.unsubscribeOrderBook()
        if (this.subscription.unsubscribeTrade) this.subscription.unsubscribeTrade()
        if (this.subscription.unsubscribeSymbols) this.subscription.unsubscribeSymbols()
        if (this.subscription.unsubscribeSymbolPrices) this.subscription.unsubscribeSymbolPrices()
        await this.delay(2000);
    }

    /**
     * Subscribes to multiple data streams for specified symbols and time frames.
     * @param marketType - The market type (e.g., spot, futures).
     * @param symbols - Array of symbols to subscribe to.
     * @param intervals - Array of time frames for the subscription.
     * @returns A Promise that resolves when the subscription is active.
     */
    public async subscribe(marketType: MarketType, symbols: Symbol[], intervals: TimeFrame[]): Promise<void> {
        const connector = this.configService
            .getConfig()
            .provider
            .connectors
            .find(c =>
                c.connectorType === this.connectorType &&
                c.markets?.some(m => m.marketType === marketType)
            );

        if (!connector) {
            throw new InternalServerErrorException(`Connector ${this.connectorType}-${marketType} not found in config`);
        }

        const subscriptionsConfig = connector.subscriptions || [];


        for (const subscriptionConfig of subscriptionsConfig) {

            // console.log('subscriptionsConfig', subscriptionConfig);
            // console.log('subscriptionsConfig', subscriptionConfig.intervals);

            if (!subscriptionConfig.active) continue;

            switch (subscriptionConfig.type) {
                case SubscriptionType.INSPECTOR_EVENT:
                case SubscriptionType.PROVIDER_MARKETDATA_CANDLE: {
                    const intervals =
                        subscriptionConfig.intervals ??
                        subscriptionConfig.detector?.intervals ??
                        [];

                    if (!intervals || intervals.length === 0) {
                        this.logger.warn(
                            `No intervals provided for PROVIDER_MARKETDATA_CANDLE, symbols=${symbols
                                .map((s) => s.name)
                                .join(", ")}`
                        );
                        continue;
                    }

                    for (const interval of intervals) {
                        this.subscription.unsubscribeCandles = await this.subscribeToСandles(
                            { marketType, symbols, interval },
                            this.handlerForCandle
                        );

                        this.logger.log(
                            `Subscribed to PROVIDER_MARKETDATA_CANDLE interval=${interval} for ${symbols
                                .map((s) => s.name)
                                .join(", ")}`
                        );
                    }
                    break;
                }

                case SubscriptionType.PROVIDER_ORDER_CLOSE:
                case SubscriptionType.PROVIDER_ORDER_CREATE:
                    break;

                case SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK:
                    this.subscription.unsubscribeOrderBook = await this.subscribeToOrderBook(
                        { marketType, symbols },
                        this.handlerForOrderbook
                    );
                    break;

                case SubscriptionType.PROVIDER_MARKETDATA_TRADE:
                    this.subscription.unsubscribeTrade = await this.subscribeToTrade(
                        { marketType, symbols },
                        this.handlerForTrade
                    );
                    break;

                case SubscriptionType.PROVIDER_SYMBOLS: {
                    // 🚫 если это Futures — можно не отключать, просто логируем
                    if (marketType === MarketType.futures) {
                        this.logger.warn(
                            `Subscribing to PROVIDER_SYMBOLS on futures market (symbols will be updated hourly)`
                        );
                    }

                    try {
                        this.subscription.unsubscribeSymbols = await this.subscribeToSymbols(
                            { marketType },
                            this.handlerForSymbols
                        );

                        this.logger.log(
                            `Subscribed to PROVIDER_SYMBOLS for ${marketType} market. Symbols will refresh every hour.`
                        );
                    } catch (err: any) {
                        this.logger.error(
                            `Failed to subscribe to PROVIDER_SYMBOLS for ${marketType} market: ${err.message}`
                        );
                    }

                    break;
                }


                case SubscriptionType.PROVIDER_SYMBOL_PRICES:
                    try {
                        const symbols = await this.getSymbolsInfo(this.connectorType, marketType);

                        if (!symbols || symbols.length === 0) {
                            this.logger.warn(
                                `No symbols found on Binance for ${marketType} → skipping PROVIDER_SYMBOL_PRICES subscription.`,
                            );
                            break;
                        }

                        // 🔥 ограничиваем top20
                        const limitedSymbols = symbols
                            .filter((s) => s.name.endsWith('USDT'))
                            .slice(0, 20);

                        this.subscription.unsubscribeSymbolPrices =
                            await this.subscribeToSymbolPrices(
                                {
                                    marketType,
                                    symbols: limitedSymbols.map((s) => s.name),
                                },
                                this.handlerForSymbolPrices,
                            );

                        this.logger.log(
                            `Subscribed to PROVIDER_SYMBOL_PRICES with ${limitedSymbols.length} symbols for ${marketType} market (top20).`,
                        );
                    } catch (err: any) {
                        this.logger.error(
                            `Failed to fetch symbols for ${marketType} before PROVIDER_SYMBOL_PRICES: ${err.message}`,
                        );
                    }
                    break;
            }
        }

        await this.delay(2000);
    }



    public async subscribeToSymbols(
        options: { marketType: MarketType },
        handler: (marketType: MarketType, symbols: Symbol[]) => Promise<void>
    ): Promise<() => void> {
        const { marketType } = options;

        const abortController = new AbortController();
        const { signal } = abortController;

        const fetchSymbolsAndProcess = async () => {
            if (signal.aborted) return;

            try {
                const symbols = await this.getSymbolsInfo(this.connectorType, marketType);
                if (!symbols || symbols.length === 0) {
                    this.logger.warn(`No symbols found for ${marketType} market`);
                    return;
                }

                // ⚡ ВАЖНО: здесь НЕ трогаем lastSymbolsHash
                await handler(marketType, symbols);

                this.logger.log(
                    `Fetched ${symbols.length} symbols for ${marketType} market (before hash-check).`
                );
            } catch (error) {
                this.logger.error(
                    `Failed to fetch symbols for ${marketType} market: ${error.message}`
                );
            }
        };

        // 🔥 сразу при запуске — 1 раз
        await fetchSymbolsAndProcess();

        // 🔥 дальше обновляем строго раз в час
        const REFRESH_INTERVAL_MS = 3600000;
        const intervalId = setInterval(() => {
            fetchSymbolsAndProcess().catch((error) =>
                this.logger.error(
                    `Error during scheduled fetch for ${marketType} market: ${error.message}`
                )
            );
        }, REFRESH_INTERVAL_MS);

        this.logger.warn(
            `Subscribing to PROVIDER_SYMBOLS on ${marketType} market (symbols will be updated hourly)`
        );

        return () => {
            clearInterval(intervalId);
            abortController.abort();
            this.logger.log(
                `Unsubscribed from PROVIDER_SYMBOLS on ${marketType} market.`
            );
        };
    }


    chunkSymbols(symbols: string[], maxPerWs = 50, maxUrlLength = 1900): string[][] {
        const result: string[][] = [];
        let batch: string[] = [];
        let length = 0;

        for (const sym of symbols) {
            const stream = `${sym.toLowerCase()}@ticker`;
            const extraLength = (batch.length > 0 ? 1 : 0) + stream.length;

            if (
                batch.length >= maxPerWs ||
                length + extraLength > maxUrlLength
            ) {
                result.push(batch);
                batch = [];
                length = 0;
            }

            batch.push(stream);
            length += extraLength;
        }

        if (batch.length) result.push(batch);

        return result;
    }


    public async subscribeToSymbolPrices(
        options: { marketType: MarketType; symbols: string[] },
        handler: (marketType: MarketType, symbolPrices: SymbolPrice) => void,
    ): Promise<() => void> {
        const { marketType, symbols } = options;

        let wsUrl: string;

        if (marketType === MarketType.spot) {
            // Spot поддерживает мультистрим через query
            const stream = symbols.map((s) => `${s.toLowerCase()}@ticker`).join('/');
            wsUrl = `wss://stream.binance.com:9443/stream?streams=${stream}`;
        } else {
            // Futures: только базовый ws, подписка позже
            wsUrl = 'wss://fstream.binance.com/ws';
        }

        this.logger.log(
            `Subscribing to WebSocket stream for ${marketType} market. URL: ${wsUrl}`,
        );

        // Создаём соединение
        const unsubscribe = await this.webSocketService.subscribeToStream(wsUrl);

        // Навешиваем обработчик сообщений
        this.webSocketService.onMessage(wsUrl, async (data: any) => {
            try {
                await handler(marketType, data);
            } catch (err: any) {
                this.logger.error(
                    `Error in symbolPrices handler for ${marketType}: ${err?.message || err}`,
                    err?.stack
                );
            }
        });

        // Если это futures — отправляем SUBSCRIBE после коннекта
        if (marketType === MarketType.futures) {
            this.webSocketService.onOpen(wsUrl, (ws) => {
                const params = symbols.map((s) => `${s.toLowerCase()}@ticker`);
                const payload = {
                    method: 'SUBSCRIBE',
                    params,
                    id: Date.now(),
                };
                ws.send(JSON.stringify(payload));

                // 🔥 сохраняем активные подписки в WebSocketService
                this.webSocketService.withSocket(wsUrl, (si) => {
                    si.activeSubs = params;
                });

                this.logger.log(
                    `Sent SUBSCRIBE for ${params.length} futures symbols.`,
                );
            });
        }

        this.logger.log(
            `Subscribed to price updates for ${symbols.length} symbols on ${marketType} market.`,
        );

        // Возвращаем функцию отписки
        return () => {

            if (marketType === MarketType.futures) {
                this.webSocketService.withSocket(wsUrl, (ws) => {
                    const payload = {
                        method: 'UNSUBSCRIBE',
                        params: symbols.map((s) => `${s.toLowerCase()}@ticker`),
                        id: Date.now(),
                    };
                    ws.send(JSON.stringify(payload));
                    this.logger.log(
                        `Sent UNSUBSCRIBE for ${symbols.length} futures symbols.`,
                    );
                });
            }

            unsubscribe();
            this.logger.log(
                `Unsubscribed from price updates on ${marketType} market.`,
            );
        };
    }


    /**
     * Updates the subscription collection by adding or removing symbols and intervals.
     * @param marketType - The market type (e.g., spot, futures).
     * @param symbols - Array of symbols to update in the subscription.
     * @param intervals - Array of time frames to update in the subscription.
     * @returns A Promise that resolves when the subscription collection is updated.
     */
    public async updateSubscribeCollection(marketType: MarketType, symbols: Symbol[], intervals: TimeFrame[]): Promise<void> {

        this.subscription.options = { symbols, intervals }
        this.unsubscribe()
        this.subscribe(marketType, symbols, intervals)
    }


    private handlerForAccount = async (marketType: MarketType, accountEvent: AccountEvent) => {

        const subscriptionType = SubscriptionType.PROVIDER_ACCOUNT_EVENT


        if (accountEvent.eventTime != this.lastAccountAdapterEventTime) {

            this.lastAccountAdapterEventTime = accountEvent.eventTime

            const subscription: Subscription = {
                type: subscriptionType,
                updateMoment: parseFloat(moment().format('x')),
                active: true
            }
            const subscriptionValue: SubscriptionValue = {
                value: accountEvent,
                options: { connectorType: this.connectorType, marketType, key: this.providerKey, updateMoment: subscription.updateMoment }
            }

            ConnectorService.addSubscription({ connectorType: this.connectorType, marketType, subscription })

            this.isEmitToRedisEnabled && this.client.emit(subscriptionType, subscriptionValue)

            if (accountEvent?.options?.symbol) {
                const { symbol } = accountEvent?.options
                if (symbol && !this.subscription.options.symbols.find(q => q == symbol)) {
                    this.subscription.options.symbols.push(symbol)
                    this.updateSubscribeCollection(marketType, this.subscription.options.symbols, this.subscription.options.intervals)
                }
            }
        }
    };


    private handlerForOrderbook = async (marketType: MarketType, orderbook: OrderBook) => {
        const subscriptionType = SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK;

        const bids = [...orderbook.bids.entries()].reverse().map(([, value]) => value);
        const orderbookSort: OrderBook = { ...orderbook, bids };



        const matchedSubscription = this.getMatchedSubscription(
            this.connectorType,
            marketType,
            subscriptionType
        );

        const subscription: Subscription = {
            type: subscriptionType,
            updateMoment: Date.now(),
            symbols: matchedSubscription.symbols,
            active: true,
        };

        const subscriptionValue: SubscriptionValue = {
            value: orderbookSort,
            options: { connectorType: this.connectorType, marketType, key: this.providerKey, updateMoment: subscription.updateMoment },
        };

        ConnectorService.addSubscription({
            connectorType: this.connectorType,
            marketType,
            subscription,
        });

        if (this.isEmitToRedisEnabled) {
            this.client.emit(subscriptionType, subscriptionValue);
        }
    };




    private handlerForSymbols = async (marketType: MarketType, symbols: Symbol[]) => {
        const subscriptionType = SubscriptionType.PROVIDER_SYMBOLS;

        // ✅ считаем хэш только здесь
        const hash = this.hashSymbols(symbols);

        if (this.lastSymbolsHash === hash) {
            this.logger.debug(
                `Symbols for ${this.connectorType}/${marketType} did not change — skipping emit`
            );
            return;
        }
        this.lastSymbolsHash = hash;

        // чистим старые
        await this.symbolRepository.delete({ connectorType: this.connectorType, marketType });

        // сохраняем новые
        const savedSymbols = symbols.map((symbol) =>
            this.symbolRepository.create({
                ...symbol,
                symbol: symbol.name,
                connectorType: this.connectorType,
                marketType,
                updatedAt: new Date(),
            })
        );
        await this.symbolRepository.save(savedSymbols);

        this.logger.log(
            `Symbols updated for ${this.connectorType}/${marketType}. Count=${symbols.length}`
        );

        // формируем подписку
        const subscription: Subscription = {
            type: subscriptionType,
            updateMoment: Date.now(),
            active: true,
        };

        const subscriptionValue: SubscriptionValue = {
            value: symbols,
            options: {
                connectorType: this.connectorType,
                marketType,
                key: this.providerKey,
                updateMoment: subscription.updateMoment,
            },
        };

        ConnectorService.addSubscription({ connectorType: this.connectorType, marketType, subscription });

        if (this.isEmitToRedisEnabled) {
            this.client.emit(subscriptionType, subscriptionValue);
            this.logger.log(
                `✅ Emitted PROVIDER_SYMBOLS for ${this.connectorType}/${marketType}, count=${symbols.length}`
            );
        }
    };


    // утилита для подсчёта хэша
    private hashSymbols(symbols: Symbol[]): string {
        return symbols
            .map((s) => s.name)
            .sort()
            .join('|');
    }


    private handlerForSymbolPrices = async (
        marketType: MarketType,
        raw: any, // Binance payload
    ) => {
        const subscriptionType = SubscriptionType.PROVIDER_SYMBOL_PRICES;

        const payload = raw.data ?? raw;

        const normalized: SymbolPrice = {
            symbol: { name: payload.s },

            // основные метрики
            price: Number(payload.c),
            open: Number(payload.o),
            high: Number(payload.h),
            low: Number(payload.l),
            volume: Number(payload.v),
            change: Number(payload.p),
            changePercent: Number(payload.P),
            time: payload.E,

            // дополнительные метрики Binance
            weightedAvgPrice: Number(payload.w),
            firstTradePrice: Number(payload.x),
            lastQty: Number(payload.Q),
            bestBidPrice: Number(payload.b),
            bestBidQty: Number(payload.B),
            bestAskPrice: Number(payload.a),
            bestAskQty: Number(payload.A),
            quoteVolume: Number(payload.q),
            openTime: payload.O,
            closeTime: payload.C,
            firstTradeId: payload.F,
            lastTradeId: payload.L,
            tradeCount: payload.n,
        } as any;


        const subscription: Subscription = {
            type: subscriptionType,
            updateMoment: Date.now(),
            active: true,
        };

        const subscriptionValue: SubscriptionValue = {
            value: normalized,
            options: { connectorType: this.connectorType, marketType, key: this.providerKey, updateMoment: subscription.updateMoment },
        };

        // console.log("📊 handlerForSymbolPrices", {
        //     marketType,
        //     first: normalized,
        // });

        ConnectorService.addSubscription({
            connectorType: this.connectorType,
            marketType,
            subscription,
        });

        if (this.isEmitToRedisEnabled) {
            this.client.emit(subscriptionType, subscriptionValue);
        }
    };




    private getMatchedSubscription(
        connectorType: ConnectorType,
        marketType: MarketType,
        subscriptionType: SubscriptionType
    ): Subscription {
        const matchedSubscription = this.configService
            .getConfig()
            .provider
            .connectors
            .find(c =>
                c.connectorType === connectorType &&
                c.markets?.some(m => m.marketType === marketType)
            )
            ?.subscriptions?.find(s => s.type === subscriptionType);

        if (!matchedSubscription) {
            throw new InternalServerErrorException(
                `Subscription not found for type: ${subscriptionType} in connector ${connectorType}-${marketType}`
            );
        }

        return matchedSubscription;
    }


    private handlerForTrade = async (marketType: MarketType, trade: Trade) => {
        const subscriptionType = SubscriptionType.PROVIDER_MARKETDATA_TRADE;



        const subscription: Subscription = {
            type: subscriptionType,
            updateMoment: Date.now(),
            symbols: this.getMatchedSubscription(this.connectorType, marketType, subscriptionType).symbols,
            active: true
        };

        const subscriptionValue: SubscriptionValue = {
            value: trade,
            options: { connectorType: this.connectorType, marketType, key: this.providerKey, updateMoment: subscription.updateMoment }
        };

        ConnectorService.addSubscription({
            connectorType: this.connectorType,
            marketType,
            subscription
        });


        // console.log('Emitting trade:', subscriptionValue);

        if (this.isEmitToRedisEnabled) {
            this.client.emit(subscriptionType, subscriptionValue);
        }
    };


    private handlerForCandle = async (
        marketType: MarketType,
        candle: Candle
    ) => {
        try {
            const subscriptionType = SubscriptionType.PROVIDER_MARKETDATA_CANDLE;

            const normalized: Candle = {
                ...candle,
                symbol: { name: String((candle.symbol as any)?.name || candle.symbol) },
            };


            const subscription: Subscription = {
                type: subscriptionType,
                updateMoment: Date.now(),
                symbols: [normalized.symbol],
                active: true,
            };

            const subscriptionValue: SubscriptionValue = {
                value: normalized,
                options: { connectorType: this.connectorType, marketType, key: this.providerKey, updateMoment: subscription.updateMoment },
            };

            ConnectorService.addSubscription({
                connectorType: this.connectorType,
                marketType,
                subscription,
            });

            if (this.isEmitToRedisEnabled) {
                this.client.emit(subscriptionType, subscriptionValue);
            }
        } catch (err) {
            this.logger.error(`Error in handlerForCandle: ${err?.message || err}`);
        }
    };



    public async subscribeToСandles(
        options: { marketType: MarketType; symbols: Symbol[]; interval: TimeFrame },
        handler: CandleHandler
    ) {
        const { marketType, symbols, interval } = options;

        this.logger.warn(
            `subscribeToСandles called with interval=${interval}, symbols=${symbols.map(s => s.name).join(',')}`
        );

        const method = (marketType === MarketType.futures) ? 'futuresCandles' : 'candles';

        const unsubscribe = this.api?.ws[method](
            symbols.map(s => s.name),
            this.convertTimeFrame(interval), // <-- тут валится
            this.candleAdapter(handler, marketType, interval),
        );

        return () => {
            unsubscribe({
                delay: 0,
                fastClose: true,
                keepClosed: true,
            });
        };
    }


    public async subscribeToOrderBook(options: { marketType: MarketType, symbols: Symbol[] }, handler: OrderBookHandler) {
        const { marketType, symbols } = options
        const method = marketType === MarketType.futures ? 'futuresDepth' : 'depth';
        const unsubscribe = this.api?.ws[method](symbols.map(s => s.name), this.orderBookAdapter(marketType, handler));

        return () => {
            unsubscribe({
                delay: 0,
                fastClose: true,
                keepClosed: true,
            });
        };
    }

    public async subscribeToAccount(options: { marketType: MarketType }, handler: AccountEventHandler) {
        const { marketType } = options
        const method = marketType === MarketType.futures ? 'futuresUser' : 'user';
        const unsubscribe = await this.api?.ws[method](this.accountAdapter(marketType, handler));

        return () => {
            unsubscribe({
                delay: 0,
                fastClose: true,
                keepClosed: true,
            });
        };
    }

    public async subscribeToTrade(options: { marketType: MarketType, symbols: Symbol[] }, handler: TradeHandler) {
        const { marketType, symbols } = options
        const method = marketType === MarketType.futures ? 'futuresAggTrades' : 'aggTrades';
        const unsubscribe = this.api?.ws[method](symbols.map(s => s.name), this.tradeAdapter(marketType, handler));

        return () => {
            unsubscribe({
                delay: 0,
                fastClose: true,
                keepClosed: true,
            });
        };
    }

    // BinanceService.ts
    private candleAdapter(handler: CandleHandler, marketType: MarketType, interval: TimeFrame) {
        return async (msg: BinanceCandle) => {
            try {
                const { isFinal, open, high, low, close, volume, startTime, symbol } = msg;

                if (isFinal) {
                    const candleRaw: CandleRaw = {
                        o: parseFloat(open),
                        h: parseFloat(high),
                        l: parseFloat(low),
                        c: parseFloat(close),
                        v: parseFloat(volume),
                        time: startTime,
                        interval,
                        symbol: { name: symbol },
                    };

                    const candle = candleMapper.toDomainCandle(candleRaw)


                    await handler(marketType, candle);

                    await this.candleService.upsertFinalCandle({
                        connectorType: this.connectorType,
                        marketType,
                        symbol: symbol,
                        interval,
                        candle: {
                            o: candle.open,
                            h: candle.high,
                            l: candle.low,
                            c: candle.close,
                            v: candle.volume,
                            time: candle.time,
                            symbol: { name: symbol },
                        },
                    });

                }
            } catch (err) {
                this.logger.error(`Error in candleAdapter: ${err?.message || err}`);
            }
        };
    }




    private accountAdapter(marketType: MarketType, handler: AccountEventHandler) {
        return (msg: OutboundAccountInfo | ExecutionReport | AccountUpdate | OrderUpdate | AccountConfigUpdate | MarginCall | UserDataStreamEvent) => {
            let options: any = {}

            if (msg.eventType == 'ACCOUNT_UPDATE') {

                const account: Account = {
                    connectorType: this.connectorType,
                    marketType: marketType,
                    assets: [],
                    positions: [],
                    orders: [],
                    isActive: true,
                    symbols: [],
                }

                msg.balances.map((item) => {

                    const asset: Asset = {
                        connectorType: this.connectorType,
                        marketType,
                        symbol: { name: item.asset },
                        walletBalance: parseFloat(item.walletBalance),
                        availableBalance: null,
                        price: [{ currency: 'USDT', value: null }]
                    }

                    const index = account.assets.findIndex(q => q.symbol == asset.symbol)

                    if (index != -1) account.assets.push(asset)
                    else account.assets[index] = asset
                })

                msg.positions.map((item) => {
                    const position: Position = {
                        connectorType: this.connectorType,
                        marketType,
                        symbol: { name: item.symbol },
                        quantity: parseFloat(item.positionAmount),
                        entryPrice: parseFloat(item.entryPrice),
                        initialMargin: 0,
                        leverage: 0,
                        side: null
                    }

                    const IMR = 1 / position.leverage
                    position.initialMargin = position.quantity * position.entryPrice * IMR
                    position.side = (position.quantity > 0) ? TradeSide.LONG : TradeSide.SHORT

                    const index = account.positions.findIndex(q => q.symbol == position.symbol)

                    if (index != -1) account.positions.push(position)
                    else account.positions[index] = position

                    if (!account.symbols.find(q => q.name == position.symbol.name)) account.symbols.push({ name: position.symbol.name })

                    ConnectorService.setAccount(account)
                })
            }

            if (msg.eventType == 'ORDER_TRADE_UPDATE') {
                options.orderId = msg.orderId
                options.orderTime = msg.orderTime
                options.orderType = msg.orderType
                options.orderStatus = msg.orderStatus
                options.clientOrderId = msg.clientOrderId
                options.symbol = msg.symbol
                options.side = msg.side
                options.quantity = msg.quantity
            }

            handler(marketType, {
                eventType: msg.eventType,
                eventTime: Number(msg.eventTime),
                options
            });
        };
    }

    private tradeAdapter(marketType: MarketType, handler: TradeHandler) {

        return (msg: BinanceAggregatedTrade) => {
            handler(
                marketType,
                {
                    symbol: { name: msg.symbol },
                    side: (msg.isBuyerMaker ? TradeSide.SHORT : TradeSide.LONG),
                    price: parseFloat(msg.price),
                    volume: parseFloat(msg.quantity),
                    time: msg.timestamp
                });
        };
    }

    private orderBookAdapter(marketType: MarketType, handler: OrderBookHandler) {
        function migrateData(value: BinanceBidDepth, result: DepthOrder[]) {
            const price = parseFloat(value.price);
            const qty = parseFloat(value.quantity);

            if (qty !== 0) {
                result.push({ price, volume: qty });
            }
        }

        return (msg: BinanceDepth) => {

            const bids: DepthOrder[] = [];
            const asks: DepthOrder[] = [];
            const symbol: Symbol = { name: msg.symbol };
            const time: number = msg.eventTime;

            msg.bidDepth.forEach((item) => {
                migrateData(item, bids);
            });

            msg.askDepth.forEach((item) => {
                migrateData(item, asks);
            });

            handler(
                marketType,
                { bids, asks, symbol, time }
            );
        };
    }

    // BinanceService.ts
    convertTimeFrame(interval: TimeFrame) {
        switch (interval) {
            case TimeFrame.min1: return CandleChartInterval.ONE_MINUTE;    // '1m'
            case TimeFrame.min3: return CandleChartInterval.THREE_MINUTES; // '3m'
            case TimeFrame.min5: return CandleChartInterval.FIVE_MINUTES;  // '5m'
            case TimeFrame.min15: return CandleChartInterval.FIFTEEN_MINUTES;
            case TimeFrame.min30: return CandleChartInterval.THIRTY_MINUTES;
            case TimeFrame.h1: return CandleChartInterval.ONE_HOUR;
            case TimeFrame.h2: return CandleChartInterval.TWO_HOURS;     // '2h'
            case TimeFrame.h4: return CandleChartInterval.FOUR_HOURS;
            case TimeFrame.day: return CandleChartInterval.ONE_DAY;
            case TimeFrame.week: return CandleChartInterval.ONE_WEEK;      // '1w'
            case TimeFrame.month: return CandleChartInterval.ONE_MONTH;     // '1M'
        }
        throw new AppError(ErrorEnvironment.Provider, 'Unsupported interval');
    }

}