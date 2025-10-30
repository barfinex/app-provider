import { Inject, Injectable, InternalServerErrorException, Logger, OnModuleInit } from "@nestjs/common";

import { AppError, ErrorEnvironment } from '../../error';
import Binance, {
    BidDepth as BinanceBidDepth,
    Candle as BinanceCandle,
    CandleChartInterval,
    Depth as BinanceDepth,
    AggregatedTrade as BinanceAggregatedTrade,
    FuturesOrder,
    NewFuturesOrder,
    NewOrderMarketBase,
    OrderType as BinanceOrderType,
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
    StopMarketNewFuturesOrder
} from 'binance-api-node';
import { ClientProxy } from '@nestjs/microservices';
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
    SubscriptionValue
} from '@barfinex/types';
import moment from 'moment';
import { ConnectorService } from "../connector.service";
import { ConfigService } from "@barfinex/config";

@Injectable()
export class TestnetBinanceSpotService implements OnModuleInit, DataSource {

    private readonly logger = new Logger(TestnetBinanceSpotService.name);

    private connectorType = ConnectorType.binance

    private readonly isEmitToRedisEnabled = false

    private subscription: {
        options?: { symbols: Symbol[], intervals: TimeFrame[] }
        unsubscribeAccount?: () => void;
        unsubscribeOrderBook?: () => void;
        unsubscribeTrade?: () => void;
        unsubscribePrices?: () => void;
        unsubscribeSymbols?: () => void;
    } = {}

    private lastAccountAdapterEventTime: number = 0

    delay = async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms));

    private readonly api: ReturnType<typeof Binance> | null = null;
    protected candles: Candle[] = [];

    get currentCandle() {
        return this.candles[0];
    }

    private readonly ignoredErrorsList = ['Margin is insufficient', 'ReduceOnly Order is rejected'];
    constructor(
        @Inject('PROVIDER_SERVICE') private readonly client: ClientProxy,
        private readonly configService: ConfigService,
    ) {
        // this.api = null
    }
    subscribeToSymbols(options: { marketType: MarketType; }, handler: (marketType: MarketType, symbols: Symbol[]) => void): Promise<() => void> {
        throw new InternalServerErrorException("Method not implemented.");
    }
    getSymbolsInfo(connectorType: ConnectorType, marketType: MarketType): Promise<Symbol[]> {
        throw new InternalServerErrorException("Method not implemented.");
    }

    subscribeToSymbolPrices(options: { marketType: MarketType; }, handler: (marketType: MarketType, symbolPrices: SymbolPrice) => void): Promise<() => void> {
        throw new InternalServerErrorException("Method not implemented.");
    }

    async onModuleInit() {

        this.logger.log(`ModuleInit`);
        this.api?.time().then(time => console.log("testnet binance futures time:", moment.utc(time).format('YYYY-MM-DD HH:mm:ss')))
    }




    async getPrices(marketType: MarketType, symbols: Symbol[]): Promise<{ [index: string]: { value: number, moment: number } }> {

        let result: { [index: string]: { value: number, moment: number } } = {}

        let exchangePrices: { [index: string]: string } = {}
        let exchangeTime: number


        if (!this.api) {
            this.logger.error('Binance API is not initialized');
            throw new Error('Binance API not initialized');
        }

        switch (marketType) {
            case MarketType.spot:
                exchangeTime = await this.api.time();
                exchangePrices = await this.api.prices();
                break;

            case MarketType.futures:
                exchangeTime = await this.api.futuresTime();
                exchangePrices = await this.api.futuresPrices();
                break;
        }


        symbols.forEach(symbol => {
            if (exchangePrices[symbol.name]) result[symbol.name] = { value: Number(exchangePrices[symbol.name]), moment: exchangeTime }
        });

        return result

    }



    async getAssetsInfo(marketType: MarketType): Promise<{ assets: Asset[], positions: Position[] }> {

        if (!this.api) {
            this.logger.error('Binance API is not initialized');
            throw new Error('Binance API not initialized');
        }

        const currency = 'USDT'

        let result: { assets: Asset[], positions: Position[] } = {
            assets: [],
            positions: []
        };


        switch (marketType) {
            case MarketType.spot:

                const pricesSpot = await this.api.prices();
                const accountInfoSpot = (await this.api.accountInfo()).balances.filter(q => parseFloat(q.free) != 0 || parseFloat(q.locked));
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

                const pricesFutures = await this.api.futuresPrices();
                const accountInfoFutures = await this.api.futuresAccountInfo();
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

    // async getOpenOrders(symbols: Symbol[]): Promise<Order[]> {

    //     let orders: Order[] = []

    //     return orders
    // }

    async getAccountInfo(marketType: MarketType): Promise<Account> {

        if (!this.api) {
            this.logger.error('Binance API is not initialized');
            throw new Error('Binance API not initialized');
        }


        const currency = 'USDT'

        let account: Account = {
            assets: [],
            positions: [],
            orders: [],
            isActive: false,
            symbols: []
        };

        switch (marketType) {
            case MarketType.spot:

                const pricesSpot = await this.api.prices();
                const accountInfoSpot = (await this.api.accountInfo()).balances.filter(q => parseFloat(q.free) != 0 || parseFloat(q.locked));

                accountInfoSpot.forEach(element => {
                    account.assets.push({
                        connectorType: this.connectorType,
                        marketType,
                        symbol: { name: element.asset },
                        walletBalance: parseFloat(element.free) + parseFloat(element.locked),
                        availableBalance: parseFloat(element.free),
                        price: [{ currency, value: (element.asset == currency) ? parseFloat('1') : parseFloat(pricesSpot[element.asset + currency] ? pricesSpot[element.asset + currency] : '0') }]

                    })

                });
                break;

            case MarketType.futures:
                const pricesFutures = await this.api.futuresPrices();
                const accountInfoFutures = await this.api.futuresAccountInfo();

                const accountInfoFutures_Assets = accountInfoFutures.assets.filter(q => parseFloat(q.walletBalance) != 0 || parseFloat(q.availableBalance));
                accountInfoFutures_Assets.forEach(element => {
                    account.assets.push({
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

                const filterAssets = account.assets.filter((q: any) => q.symbol.name != currency)

                for (let i = 0; i < filterAssets.length; i++) {
                    const asset = filterAssets[i];

                    const orders = await this.api.futuresOpenOrders({ symbol: asset.symbol + currency } as any);

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
                                key: this.connectorType,
                                type: OrderSourceType.provider,
                                restApiUrl: null
                            }
                        });
                    });
                }
                break;
        }

        if (account.assets.length > 0) account.isActive = true

        return account
    }

    async changeLeverage(symbol: Symbol, newLeverage: number): Promise<Symbol> {
        if (!this.api) {
            this.logger.error('Binance API is not initialized');
            throw new Error('Binance API not initialized');
        }

        const result = await this.api.futuresLeverage({ symbol: symbol.name, leverage: newLeverage })
        return { name: result.symbol, leverage: result.leverage };
    }



    async openOrder(order: Order): Promise<Order> {

        if (!this.api) {
            this.logger.error('Binance API is not initialized');
            throw new Error('Binance API not initialized');
        }


        if (!order.useSandbox) {

            switch (order.marketType) {
                case MarketType.spot:

                    let spotOrderToProvider: NewOrderSpot = {} as NewOrderSpot;

                    switch (order.type) {

                        case OrderType.MARKET:
                            if (order.symbol && order.quantity)
                                spotOrderToProvider = {
                                    type: BinanceOrderType.MARKET,
                                    symbol: order.symbol.name,
                                    side: order.side,
                                    quantity: order.quantity.toString(),
                                } as NewOrderMarketBase
                            break;

                        case OrderType.LIMIT:
                            if (order.symbol && order.quantity && order.price)
                                spotOrderToProvider = {
                                    type: BinanceOrderType.LIMIT,
                                    symbol: order.symbol.name,
                                    side: order.side,
                                    // 'GTC' - Good Till Cancelled | 'IOC' - Immediate or Cancel | 'FOK' - Fill or Kill
                                    timeInForce: 'GTC',
                                    quantity: order.quantity.toString(),
                                    price: order.price.toString(),
                                } as NewOrderLimit
                            break;

                        case OrderType.TAKE_PROFIT:
                            if (order.symbol && order.quantity && order.price)
                                spotOrderToProvider = {
                                    type: BinanceOrderType.TAKE_PROFIT_LIMIT,
                                    symbol: order.symbol.name,
                                    side: order.side,
                                    quantity: order.quantity.toString(),
                                    price: order.price.toString(),
                                } as NewOrderSL
                            break;

                        case OrderType.STOP:
                            if (order.symbol && order.quantity && order.price)
                                spotOrderToProvider = {
                                    type: BinanceOrderType.STOP_LOSS_LIMIT,
                                    symbol: order.symbol.name,
                                    side: order.side,
                                    quantity: order.quantity.toString(),
                                    price: order.price.toString(),
                                } as NewOrderSL
                            break;
                    }

                    const spotOrderEntity = await this.api.order(spotOrderToProvider)
                    order.externalId = spotOrderEntity.orderId.toString()
                    order.updateTime = spotOrderEntity.updateTime

                    break;
                case MarketType.futures:

                    let futuresOrderToProvider: NewFuturesOrder = {} as NewFuturesOrder;

                    switch (order.type) {

                        case OrderType.MARKET:
                            if (order.symbol && order.quantity)
                                futuresOrderToProvider = {
                                    type: order.type,
                                    symbol: order.symbol.name,
                                    side: order.side,
                                    quantity: order.quantity.toString(),
                                } as MarketNewFuturesOrder
                            break;

                        case OrderType.LIMIT:
                            if (order.symbol && order.quantity && order.price)
                                futuresOrderToProvider = {
                                    type: order.type,
                                    symbol: order.symbol.name,
                                    side: order.side,
                                    // 'GTC' - Good Till Cancelled | 'IOC' - Immediate or Cancel | 'FOK' - Fill or Kill
                                    timeInForce: 'GTC',
                                    quantity: order.quantity.toString(),
                                    price: order.price.toString(),
                                } as LimitNewFuturesOrder
                            break;

                        case OrderType.TAKE_PROFIT:
                            if (order.symbol && order.quantity && order.price)
                                futuresOrderToProvider = {
                                    type: order.type,
                                    symbol: order.symbol.name,
                                    side: order.side,
                                    quantity: order.quantity.toString(),
                                    //price: order.price.toString(),
                                    stopPrice: order.price.toString(),
                                } as TakeProfitNewFuturesOrder
                            break;

                        case OrderType.STOP:
                            if (order.symbol && order.quantity && order.price)
                                futuresOrderToProvider = {
                                    type: order.type,
                                    symbol: order.symbol.name,
                                    side: order.side,
                                    quantity: order.quantity.toString(),
                                    //price: order.price.toString(),
                                    stopPrice: order.price.toString(),
                                } as StopNewFuturesOrder
                            break;

                        case OrderType.TAKE_PROFIT_MARKET:
                            if (order.symbol && order.quantity && order.price)
                                futuresOrderToProvider = {
                                    type: order.type,
                                    symbol: order.symbol.name,
                                    side: order.side,
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
                            if (order.symbol && order.quantity && order.price)
                                futuresOrderToProvider = {
                                    type: order.type,
                                    symbol: order.symbol.name,
                                    side: order.side,
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

                    let futuresOrderEntity: FuturesOrder = {} as FuturesOrder

                    if (!orders.find(q => q.symbol && q.symbol.name == futuresOrderToProvider.symbol && q.type == futuresOrderToProvider.type && q.side == futuresOrderToProvider.side))
                        futuresOrderEntity = await this.api.futuresOrder(futuresOrderToProvider)

                    if (futuresOrderEntity) {
                        order.externalId = futuresOrderEntity.orderId.toString()
                        order.updateTime = futuresOrderEntity.updateTime
                    }
                    break;
            }

        }

        return order;
    }




    async closeOrder(options: { id: string, symbol: Symbol, marketType: MarketType }): Promise<Order> {

        if (!this.api) {
            this.logger.error('Binance API is not initialized');
            throw new Error('Binance API not initialized');
        }

        const { id, symbol, marketType } = options

        const orders = await this.api.futuresOpenOrders({ symbol: symbol.name });

        console.log("{ orderId: +id, symbol }:", { orderId: +id, symbol });

        if (orders.find(q => q.orderId == id)) await this.api.futuresCancelOrder({ orderId: +id, symbol: symbol.name })

        return {
            externalId: id, symbol, side: OrderSide.BUY, type: OrderType.MARKET, price: 0, quantity: 0, time: Date.now(), updateTime: Date.now(), useSandbox: false, connectorType: this.connectorType, marketType, source: { key: this.connectorType, type: OrderSourceType.provider, restApiUrl: null }
        }
    }


    async closeAllOrders(options: { symbol: Symbol, marketType: MarketType }): Promise<void> {

        if (!this.api) {
            this.logger.error('Binance API is not initialized');
            throw new Error('Binance API not initialized');
        }

        const { symbol, marketType } = options

        if (marketType == MarketType.spot) {
            await this.api.cancelOpenOrders({ symbol: symbol.name })
        } else {
            await this.api.futuresCancelAllOpenOrders({ symbol: symbol.name })
        }

    }




    public async getOpenOrders(options: { symbol?: Symbol, detectorSysname?: string, marketType: MarketType }): Promise<Order[]> {

        if (!this.api) {
            this.logger.error('Binance API is not initialized');
            throw new Error('Binance API not initialized');
        }

        let result: Order[] = []

        const { symbol, detectorSysname, marketType } = options

        if (marketType == MarketType.spot) {

            const ordersInProvider_Spot = await this.api.openOrders((symbol) ? { symbol: symbol.name } : {});

            for (let i = 0; i < ordersInProvider_Spot.length; i++) {
                const element = ordersInProvider_Spot[i];

                // console.log('order binance:', element);

                let order: Order = {
                    symbol: { name: element.symbol },
                    externalId: element.orderId.toString(),
                    side: element.side.toString() as OrderSide,
                    type: element.type.toString() as OrderType,
                    price: parseFloat(element.price),
                    quantity: parseFloat(element.origQty),
                    // quantityExecuted: parseFloat(element.executedQty),
                    // priceStop: parseFloat(element.stopPrice),
                    time: element.time,
                    updateTime: element.updateTime,

                    // isClose: false,
                    useSandbox: false,
                    connectorType: this.connectorType,
                    marketType: marketType,
                    source: {
                        key: this.connectorType,
                        type: OrderSourceType.provider,
                        restApiUrl: null

                    }
                }

                result.push(order);
            }

        } else {

            const ordersInProvider_Futures = await this.api.futuresOpenOrders((symbol) ? { symbol: symbol.name } : {});

            // console.log(ordersInProvider_Futures);

            ordersInProvider_Futures.forEach(order => {

                //console.log('order binance:', order);

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
                    // quantityExecuted: parseFloat(order.executedQty),
                    // priceStop: parseFloat(element.stopPrice),
                    time: order.time,
                    updateTime: order.updateTime,

                    // isClose: false,
                    useSandbox: false,
                    connectorType: this.connectorType,
                    marketType: marketType,
                    source: {
                        key: this.connectorType,
                        type: OrderSourceType.provider,
                        restApiUrl: null

                    }
                });
            });

        }

        // console.log('result', result);

        return result

    }


    public async unsubscribe(): Promise<void> {

        if (this.subscription.unsubscribeAccount) this.subscription.unsubscribeAccount()
        if (this.subscription.unsubscribeOrderBook) this.subscription.unsubscribeOrderBook()
        if (this.subscription.unsubscribeTrade) this.subscription.unsubscribeTrade()
        // if (this.subscription.unsubscribePrices) this.subscription.unsubscribePrices()
        // if (this.subscription.unsubscribeSymbols) this.subscription.unsubscribeSymbols()

        await this.delay(2000);
    }

    public async subscribe(marketType: MarketType, symbols: Symbol[], intervals: TimeFrame[]): Promise<void> {

        this.subscription.unsubscribeAccount = await this.subscribeToAccount({ marketType }, this.handlerForAccount);
        this.subscription.unsubscribeOrderBook = await this.subscribeToOrderBook({ marketType, symbols }, this.handlerForOrderbook);
        this.subscription.unsubscribeTrade = await this.subscribeToTrade({ marketType, symbols }, this.handlerForTrade);
        // this.subscription.unsubscribePrices = await this.subscribeToPrices({ marketType }, this.handlerForSymbolPrices);
        // this.subscription.unsubscribeSymbols = await this.subscribeToSymbols({ marketType }, this.handlerForSymbols);

        await this.delay(2000);
    }


    public async updateSubscribeCollection(marketType: MarketType, symbols: Symbol[], intervals: TimeFrame[]): Promise<void> {

        this.subscription.options = { symbols, intervals }
        this.unsubscribe()
        this.subscribe(marketType, symbols, intervals)
    }


    private handlerForAccount = async (marketType: MarketType, accountEvent: AccountEvent) => {

        const subscriptionType = SubscriptionType.PROVIDER_ACCOUNT_EVENT
        const subscriptionValue: SubscriptionValue = { value: accountEvent, options: { connectorType: this.connectorType, marketType, updateMoment: Date.now() } }

        if (accountEvent.eventTime != this.lastAccountAdapterEventTime) {

            this.lastAccountAdapterEventTime = accountEvent.eventTime

            const subscription: Subscription = {
                type: subscriptionType,
                updateMoment: parseFloat(moment().format('x')),
                active: true
            }
            ConnectorService.addSubscription({ connectorType: this.connectorType, marketType, subscription })

            this.isEmitToRedisEnabled && this.client.emit(subscriptionType, subscriptionValue)
        }
    };

    private getMatchedSubscription(
        connectorType: ConnectorType,
        marketType: MarketType,
        subscriptionType: SubscriptionType
    ): Subscription {
        const config = this.configService?.getConfig();

        if (!config?.provider?.connectors) {
            throw new InternalServerErrorException(
                'Provider connectors configuration is missing in application config'
            );
        }

        const matchedConnector = config.provider.connectors.find(
            (c: any) =>
                c.connectorType === connectorType &&
                c.markets?.some((m: { marketType: MarketType }) => m.marketType === marketType)
        );

        if (!matchedConnector?.subscriptions) {
            throw new InternalServerErrorException(
                `No subscriptions defined for connector ${connectorType}-${marketType}`
            );
        }

        const matchedSubscription = matchedConnector.subscriptions.find(
            (s: { type: SubscriptionType }) => s.type === subscriptionType
        );

        if (!matchedSubscription) {
            throw new InternalServerErrorException(
                `Subscription not found for type: ${subscriptionType} in connector ${connectorType}-${marketType}`
            );
        }

        return matchedSubscription;
    }


    private handlerForOrderbook = async (marketType: MarketType, orderbook: OrderBook) => {
        const subscriptionType = SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK;

        // Сортировка заявок: reverse по цене
        const bids = [...orderbook.bids.entries()].reverse().map(([, value]) => value);
        const orderbookSort: OrderBook = { ...orderbook, bids };

        const subscriptionValue: SubscriptionValue = {
            value: orderbookSort,
            options: { connectorType: this.connectorType, marketType, updateMoment: Date.now() },
        };

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

        ConnectorService.addSubscription({
            connectorType: this.connectorType,
            marketType,
            subscription,
        });

        if (this.isEmitToRedisEnabled) {
            this.client.emit(subscriptionType, subscriptionValue);
        }
    };

    private handlerForTrade = async (marketType: MarketType, trade: Trade) => {
        const subscriptionType = SubscriptionType.PROVIDER_MARKETDATA_TRADE;

        const subscriptionValue: SubscriptionValue = {
            value: trade,
            options: { connectorType: this.connectorType, marketType, updateMoment: Date.now() },
        };

        const subscription: Subscription = {
            type: subscriptionType,
            updateMoment: Date.now(),
            symbols: this.getMatchedSubscription(this.connectorType, marketType, subscriptionType).symbols,
            active: true
        };

        ConnectorService.addSubscription({
            connectorType: this.connectorType,
            marketType,
            subscription
        });

        if (this.isEmitToRedisEnabled) {
            this.client.emit(subscriptionType, subscriptionValue);
        }
    };


    public async subscribeToСandles(options: { marketType: MarketType, symbols: Symbol[], interval: TimeFrame }, handler: CandleHandler) {

        if (!this.api) {
            this.logger.error('Binance API is not initialized');
            throw new Error('Binance API not initialized');
        }

        const { marketType, symbols, interval } = options
        const method = (marketType === MarketType.futures) ? 'futuresCandles' : 'candles';

        const unsubscribe = this.api.ws[method](
            symbols.map(s => s.name),
            this.convertTimeFrame(interval),
            this.candleAdapter(handler, interval),
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


        if (!this.api) {
            throw new Error("Binance API not initialized");
        }

        const { marketType, symbols } = options
        console.log("subscribeToOrderBook:", { marketType, symbols });
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

        if (!this.api) {
            throw new Error("Binance API not initialized");
        }

        const { marketType } = options
        const method = marketType === MarketType.futures ? 'futuresUser' : 'user';

        this.api?.ws.trades(['BTCUSDT'], trade => console.log("Number(trade.price):", Number(trade.price)))

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


        if (!this.api) {
            throw new Error("Binance API not initialized");
        }

        const { marketType, symbols } = options
        const method = 'aggTrades';

        const unsubscribe = this.api?.ws[method](symbols.map(s => s.name), this.tradeAdapter(marketType, handler));

        return () => {
            unsubscribe({
                delay: 0,
                fastClose: true,
                keepClosed: true,
            });
        };
    }



    private candleAdapter(handler: CandleHandler, interval: TimeFrame) {
        return (msg: BinanceCandle) => {

            const { isFinal, open, high, low, close, volume, startTime, symbol, firstTradeId, lastTradeId, } = msg

        };
    }




    private accountAdapter(marketType: MarketType, handler: AccountEventHandler) {

        return (msg: OutboundAccountInfo | ExecutionReport | AccountUpdate | OrderUpdate | AccountConfigUpdate | MarginCall | UserDataStreamEvent) => {

            let options: any = {}


            if (msg.eventType == 'ORDER_TRADE_UPDATE') {
                options.orderId = msg.orderId
                options.orderTime = msg.orderTime
                options.orderType = msg.orderType
                options.orderStatus = msg.orderStatus
                options.clientOrderId = msg.clientOrderId
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

    convertTimeFrame(interval: TimeFrame) {
        switch (interval) {
            case TimeFrame.min1: return CandleChartInterval.ONE_MINUTE;
            case TimeFrame.min3: return CandleChartInterval.THREE_MINUTES;
            case TimeFrame.min5: return CandleChartInterval.FIVE_MINUTES;
            case TimeFrame.min15: return CandleChartInterval.FIFTEEN_MINUTES;
            case TimeFrame.min30: return CandleChartInterval.THIRTY_MINUTES;
            case TimeFrame.h1: return CandleChartInterval.ONE_HOUR;
            case TimeFrame.h2: return CandleChartInterval.TWO_HOURS;
            case TimeFrame.h4: return CandleChartInterval.FOUR_HOURS;
            case TimeFrame.day: return CandleChartInterval.ONE_DAY;
            case TimeFrame.week: return CandleChartInterval.ONE_WEEK;
            case TimeFrame.month: return CandleChartInterval.ONE_MONTH;
            default:
                this.logger.error(`Unsupported interval: ${interval}`);
                throw new AppError(ErrorEnvironment.Provider, `Unsupported interval: ${interval}`);
        }
    }

}