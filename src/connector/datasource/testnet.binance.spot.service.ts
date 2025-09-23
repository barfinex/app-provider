import { ConsoleLogger, Inject, Injectable, InternalServerErrorException, Logger, OnModuleInit } from "@nestjs/common";

import { AppError, ErrorEnvironment } from '../../error';
import Binance, {
    BidDepth as BinanceBidDepth,
    Candle as BinanceCandle,
    CandleChartInterval,
    Depth as BinanceDepth,
    Trade as BinanceTrade,
    AggregatedTrade as BinanceAggregatedTrade,

    // OutboundAccountInfo, | ExecutionReport | AccountUpdate | OrderUpdate | AccountConfigUpdate | MarginCall

    ExchangeInfo,
    FuturesOrder,
    // FuturesOrderType_LT,
    NewFuturesOrder,
    NewOrderMargin,
    NewOrderMarketBase,
    NewOrderRespType,
    Order as OrderBinance,
    OrderSide as OrderSideBinance,
    OrderType as BinanceOrderType,
    PositionSide,
    SideEffectType,
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
import BinanceApi from 'binance-api-node'
import binance from 'binance-api-node'
//import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import { ClientProxy } from '@nestjs/microservices';
import {
    Connector,
    Order,
    DataSource,
    OrderSide,
    OrderType,
    TimeFrame,
    CandleHandler,
    OrderBookHandler,
    AccountHandler,
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
    SymbolSubscription,
    // AccountSymbol,
    AccountEventHandler,
    AccountEvent,
    Subscription,
    OrderSourceType,
    Symbol,
    SymbolPrice,
    SubscriptionValue,
} from '@barfinex/types';
// import { placeSandboxOrder } from '@barfinex/utils/sandbox';
// import { AccountService } from "../account/account.service";
// import { ConfigProvider, GlobalService } from "../global.service";
import moment from 'moment';
// import { ProviderGateway } from "../provider.gateway";
import { resourceLimits } from "worker_threads";
// import { GlobalService } from "../../global.service";
import { ConnectorService } from "../connector.service";
import { ConfigService } from "@barfinex/config/config.service";
// import { EventEmitter2 } from "@nestjs/event-emitter";




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

    private readonly api: ReturnType<typeof Binance>;
    private assets: Map<string, Asset> = new Map();
    private info: ExchangeInfo;
    // private futuresInfo: ExchangeInfo<FuturesOrderType_LT>;
    private hedgeMode = false;


    /////////.... from tradingSystem


    private marketTick: Candle;
    protected candles: Candle[] = [];

    get currentCandle() {
        return this.candles[0];
    }

    /////////....

    // private opt: { connectorType: ProviderType, marketType: MarketType } = {
    //     connectorType: ProviderType.binance,
    //     marketType: 'futures'
    // }

    private readonly badStatus = ['CANCELED', 'EXPIRED', 'PENDING_CANCEL', 'REJECTED'];
    private readonly ignoredErrorsList = ['Margin is insufficient', 'ReduceOnly Order is rejected'];
    constructor(
        @Inject('PROVIDER_SERVICE') private readonly client: ClientProxy,
        private readonly configService: ConfigService,
    ) {
        this.api = null
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
        // console.log("onModuleInit()");

        // this.api.time().then(time => console.log("testnet binance time:", moment.utc(time).format('YYYY-MM-DD HH:mm:ss')))
        // this.api.
        // this.registerEvents();
    }




    async getPrices(marketType: MarketType, symbols: Symbol[]): Promise<{ [index: string]: { value: number, moment: number } }> {

        let result: { [index: string]: { value: number, moment: number } } = {}

        let exchangePrices: { [index: string]: string } = {}
        let exchangeTime: number


        switch (marketType) {
            case MarketType.spot:
                exchangeTime = await this.api.time();
                exchangePrices = await this.api.prices()
                break;
            case MarketType.futures:
                exchangeTime = await this.api.futuresTime();
                exchangePrices = await this.api.futuresPrices()
                break;
        }


        symbols.forEach(symbol => {
            if (exchangePrices[symbol.name]) result[symbol.name] = { value: Number(exchangePrices[symbol.name]), moment: exchangeTime }
        });

        return result

    }



    async getAssetsInfo(marketType: MarketType): Promise<{ assets: Asset[], positions: Position[] }> {

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

        const currency = 'USDT'

        let account: Account = {
            connectorType: null,
            marketType: null,
            // totals: {
            //     //profit: 0,
            //     //orders: 0,
            //     //assets: []
            // },
            assets: [],
            positions: [],
            orders: [],
            symbols: [],
            isActive: false
        };


        //console.log("marketType:", marketType);

        // if (this.connectorType == ProviderType.binance) {
        switch (marketType) {
            case MarketType.spot:

                const pricesSpot = await this.api.prices();

                //console.log("pricesSpot:", pricesSpot);

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

                    // console.log("accountInfoSpot:", accountInfoSpot);
                });


                // if (isOpenOrders) account.orders = await this.getOpenOrders({ connectorType, marketType });


                break;
            case MarketType.futures:

                const pricesFutures = await this.api.futuresPrices();

                // console.log("pricesFutures:", pricesFutures);
                // console.log(await client.accountInfo())

                // makerCommission: 10, - limitorder
                // takerCommission: 10, - market


                const accountInfoFutures = await this.api.futuresAccountInfo();


                // console.log('accountInfoFutures:', accountInfoFutures);

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
                    //console.log("accountInfoFutures:", accountInfoFutures);
                });





                const filterAssets = account.assets.filter(q => q.symbol.name != currency)

                for (let i = 0; i < filterAssets.length; i++) {
                    const asset = filterAssets[i];

                    //console.log("symbol:", asset.symbol + currency);

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
                            // priceStop: order.stopPrice,
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



                    // orders....forEach(order => {
                    //     account.orders.push(order);    
                    // });
                }


                // if (isOpenOrders) account.orders = await this.orderSecvice.getOpenOrders({ connectorType, marketType });

                // console.log("account.orders.data:", JSON.stringify(Object.fromEntries(account.orders.data as Map<number, Order>)));

                break;
            // case MarketType.margin:

            // break;
        }

        // if (!!account.assets.length) {
        //     account.assets.forEach(asset => {

        //         //console.log("asset", asset);
        //         if (asset.price.find(q => q.currency == currency)) account.totals.assets.find(q => q.currency == currency).cost += asset.walletBalance * asset.price.find(q => q.currency == currency).value
        //     });
        // }

        //}


        //if (account.totals.assets.find(q => q.currency == 'USDT').cost != 0) account.isActive = true
        if (account.assets.length > 0) account.isActive = true


        //console.log("account on provider:", account.orders);


        return account

        return {
            ...account
            // , orders: {
            //     open: { data: JSON.stringify(Object.fromEntries(account.orders.data as Map<number, Order>)) },
            //     close: { data: JSON.stringify(Object.fromEntries(account.orders.close.data as Map<number, Order>)) },
            //     short: { data: JSON.stringify(Object.fromEntries(account.orders.short.data as Map<number, Order>)) },
            //     long: { data: JSON.stringify(Object.fromEntries(account.orders.long.data as Map<number, Order>)) }
            // }
        };
    }

    async changeLeverage(symbol: Symbol, newLeverage: number): Promise<Symbol> {
        const result = await this.api.futuresLeverage({ symbol: symbol.name, leverage: newLeverage })
        return { name: result.symbol, leverage: result.leverage };
    }

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


                    const spotOrderEntity = await this.api.order(spotOrderToProvider)
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


                    // console.log('test1');
                    // console.log('futuresOrderToProvider:', futuresOrderToProvider);

                    let orders: Order[] = await this.getOpenOrders({ marketType: order.marketType })

                    let futuresOrderEntity: FuturesOrder = null

                    if (!orders.find(q => q.symbol.name == futuresOrderToProvider.symbol && q.type == futuresOrderToProvider.type && q.side == futuresOrderToProvider.side))
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

        const { id, symbol, marketType } = options

        const orders = await this.api.futuresOpenOrders({ symbol: symbol.name });

        console.log("{ orderId: +id, symbol }:", { orderId: +id, symbol });

        if (orders.find(q => q.orderId == id)) await this.api.futuresCancelOrder({ orderId: +id, symbol: symbol.name })

        return null
    }


    async closeAllOrders(options: { symbol: Symbol, marketType: MarketType }): Promise<void> {

        const { symbol, marketType } = options

        if (marketType == MarketType.spot) {
            await this.api.cancelOpenOrders({ symbol: symbol.name })
        } else {
            await this.api.futuresCancelAllOpenOrders({ symbol: symbol.name })
        }

    }




    public async getOpenOrders(options: { symbol?: Symbol, detectorSysname?: string, marketType: MarketType }): Promise<Order[]> {

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
    // unsubscribeSymbol(symbol: Symbol) {


    // }


    // async subscribeSymbol(symbol: Symbol) {

    //     // this.symbols = await this.getSymbolsInfo(this.options);

    //     // console.log("this.symbols:", this.symbols);

    //     // GlobalService.providers[this.options.connectorType] = { connectorType: ProviderType.binance, subscribedAssets: {} };
    //     // this.options.subscriptions.assets[symbol] = {}
    //     //GlobalService.providers[this.options.connectorType].subscribedAssets[symbol] = { symbol: symbol }




    //     // this.unSubscribeCollection[symbol].unSubscribeToAccount = await this.subscribeToAccount(this.options, this.handlerForAccount);
    //     // const account = await this.getAccountInfo(this.options.connectorType, this.options.marketType)
    //     // this.client.emit(EventType.PROVIDER_ACCOUNT_EVENT, { account, options: { ...this.options } })
    //     //this.eventEmitter.emit('message', { value: { account, options: { type: EventType.PROVIDER_ACCOUNT_EVENT } } })
    // }


    private handlerForAccount = async (marketType: MarketType, accountEvent: AccountEvent) => {

        const subscriptionType = SubscriptionType.PROVIDER_ACCOUNT_EVENT
        const subscriptionValue: SubscriptionValue = { value: accountEvent, options: { connectorType: this.connectorType, marketType, key: null, updateMoment: Date.now() } }

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



    private handlerForOrderbook = async (marketType: MarketType, orderbook: OrderBook) => {
        const subscriptionType = SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK;

        // Сортировка заявок: reverse по цене
        const bids = [...orderbook.bids.entries()].reverse().map(([, value]) => value);
        const orderbookSort: OrderBook = { ...orderbook, bids };

        const subscriptionValue: SubscriptionValue = {
            value: orderbookSort,
            options: { connectorType: this.connectorType, marketType, key: null, updateMoment: Date.now() },
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
            options: { connectorType: this.connectorType, marketType, key: null, updateMoment: Date.now() },
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

    // private handlerForCandle = async (candle: Candle) => {

    //     if (this.options.subscriptions.assets[candle.symbol]) this.options.subscriptions.assets[candle.symbol].updateMomentCandle = parseFloat(moment().format('x'));


    //     console.log("PROVIDER_MARKETDATA_CANDLE!");
    //     console.log("candle:", candle);

    //     this.client.emit(EventType.PROVIDER_MARKETDATA_CANDLE, { value: { candle, options: {} } })
    // };



    // async getSymbolsInfo(connectorType: ConnectorType, marketType: MarketType): Promise<Symbol[]> {


    //     let info: any;
    //     let prices: any;

    //     if (marketType === MarketType.futures) {
    //         info = this.futuresInfo = this.futuresInfo || (await this.api.futuresExchangeInfo());
    //         prices = await this.api.futuresPrices();
    //         this.hedgeMode = (await this.api.futuresPositionMode()).dualSidePosition;
    //     } else {
    //         info = this.info = this.info || (await this.api.exchangeInfo());
    //         prices = await this.api.prices();
    //     }

    //     const foundSymbols: any[] = [];

    //     symbols.forEach(symbol => {
    //         const foundSymbol = info.symbols.find((item: { symbol: Symbol; }) => item.symbol === symbol)
    //         if (foundSymbol) {
    //             foundSymbols.push(
    //                 {
    //                     symbol,
    //                     connectorType: this.connectorType,
    //                     marketType,
    //                     status: foundSymbol.status,
    //                     baseAsset: foundSymbol.baseAsset,
    //                     price: parseFloat(prices[symbol]),
    //                     orderTypes: foundSymbol.orderTypes
    //                 }
    //             );
    //         }
    //     });

    //     if (!foundSymbols) {
    //         throw new Error(ErrorEnvironment.Provider, 'Unknown asset');
    //     }
    //     // let minQuantity = 0;
    //     // let minNotional = 0;

    //     // for (const filter of result.filters) {
    //     //     if (filter.filterType === 'LOT_SIZE') {
    //     //         minQuantity = Number(filter.minQty);
    //     //     } else if (filter.filterType === 'MIN_NOTIONAL') {
    //     //         // @ts-ignore
    //     //         minNotional = Number(filter.minNotional) || Number(filter.notional);
    //     //     }

    //     //     if (minQuantity && minNotional) {
    //     //         break;
    //     //     }
    //     // }

    //     // 0.0000100 -> 0.00001
    //     // const lotPrecision = minQuantity === 1 ? 0 : math.getPrecision(minQuantity);




    //     // const data: Asset = {
    //     //     // figi: ticker,
    //     //     symbol: ticker,
    //     //     // minNotional,
    //     //     // minQuantity,
    //     //     lot: 1,
    //     //     lotPrecision,
    //     //     marketType: marketType,
    //     //     id: assetId,
    //     // };


    //     // const result: Map<string, AccountSymbol> = new Map();


    //     // foundSymbols.forEach(s => {
    //     //     result.set(s.symbol, s);
    //     // });

    //     // console.log("result:", result);

    //     // return result;
    //     return foundSymbols;
    // }

    public async subscribeToСandles(options: { marketType: MarketType, symbols: Symbol[], interval: TimeFrame }, handler: CandleHandler) {

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


    // public async placeOrder(order: Order, options: Connector): Promise<Order> {
    //     const { side: side, quantity: lots, useSandbox } = order;
    //     //const asset = await this.getAssetsInfo(options.connectorType, options.marketType);
    //     const { marketTypes: marketType, currency } = options;
    //     // const { id, symbol: ticker } = asset;
    //     // order.retries = order.retries || 0;

    //     if (useSandbox) {
    //         return placeSandboxOrder(order, options);
    //     }

    //     // const base: NewOrderMarketBase = {
    //     //     quantity: String(lots),
    //     //     side: OrderSideBinance.BUY ? OrderSideBinance.BUY : OrderSideBinance.SELL,
    //     //     symbol: ticker,
    //     //     type: BinanceOrderType.MARKET,
    //     // };

    //     let res: Order | FuturesOrder;
    //     // Only network condition should be try catch wrapped and retried, for prevent network retries when error throws from JS error

    //     try {
    //         switch (marketType) {
    //             case 'futures':
    //                 let positionSide = PositionSide.BOTH;

    //                 if (this.hedgeMode) {
    //                     positionSide = OrderSideBinance.BUY ? PositionSide.LONG : PositionSide.SHORT;

    //                     // if (order.close) {
    //                     //     positionSide = OrderSideBinance.BUY ? PositionSide.SHORT : PositionSide.LONG;
    //                     // }
    //                 }

    //                 // const futuresPayload: NewFuturesOrder = {
    //                 //     ...base,
    //                 //     positionSide,
    //                 //     newOrderRespType: NewOrderRespType.RESULT,
    //                 // };

    //                 // res = await this.api.futuresOrder(futuresPayload);
    //                 break;
    //             case 'margin':
    //                 // const marginPayload: NewOrderMargin = {
    //                 //     ...base,
    //                 //     sideEffectType: order.close ? SideEffectType.AUTO_REPAY : SideEffectType.MARGIN_BUY,
    //                 // };

    //                 // res = await this.api.marginOrder(marginPayload);
    //                 break;
    //             default:
    //                 // res = await this.api.order(base);
    //                 break;
    //         }

    //         // if (this.badStatus.includes(res.status)) {
    //         //     throw res;
    //         // }
    //     } catch (e) {
    //         // if (order.retries <= 10 && this.canRetry(e)) {
    //         //     debug.logDebug('error order place', e);
    //         //     order.retries++;
    //         //     // 10 ретраев чтобы точно попасть в период блокировки биржи изза скачков цены на 30 минут
    //         //     // тк блокировка длится в среднем 30 минут
    //         //     const timeout = Math.floor(
    //         //         math.clamp(Math.pow(3 + Math.random(), order.retries) * 1000, 3000, 300000) + 60000 * Math.random(),
    //         //     );
    //         //     await promise.sleep(timeout);

    //         //     // Проверяем, что подписка все еще актуальна
    //         //     if (this.assets.has(asset.id)) {
    //         //         return this.placeOrder(order, options);
    //         //     }
    //         // }

    //         debug.logDebug('retry failure with order', order);

    //         throw new Error(ErrorEnvironment.Provider, e.message);
    //     }

    //     // if (order.retries > 0) {
    //     //     debug.logDebug('retry success');
    //     // }

    //     const precision = math.getPrecision(order.price);
    //     // avg trade price
    //     let fees = 0;
    //     let price = 0;
    //     let qty = 0;

    //     // if ('fills' in res) {
    //     //     res.fills.forEach((fill) => {
    //     //         price += Number(fill.price);
    //     //         qty += Number(fill.qty);

    //     //         // if (ticker.startsWith(fill.commissionAsset)) {
    //     //         //     fees += Number(fill.commission);
    //     //         // }
    //     //     });

    //     //     price = math.toFixed(price / res.fills.length, precision);
    //     // }

    //     if ('avgPrice' in res) {
    //         price = math.toFixed(Number(res.avgPrice), precision);
    //     }

    //     let executedLots: number;

    //     if (qty) {
    //         const realQty = qty - fees;
    //         // executedLots = this.prepareLots(realQty, id);
    //     } else if ('executedQty' in res) {
    //         executedLots = Number(res.executedQty);
    //     }

    //     //const feeAmount = fees && isFinite(fees) ? fees : price * order.origQty * (options.fee / 100);
    //     //const commission = { value: feeAmount, currency };
    //     const executed: Order = {
    //         ...order,
    //         quantity: executedLots,
    //         price,
    //     };

    //     return executed;
    // }

    // public prepareLots(lots: number, assetId: string) {
    //     const asset = this.assets.get(assetId);

    //     if (!asset) {
    //         throw new Error(ErrorEnvironment.Provider, `Unknown instument id ${assetId}`);
    //     }

    //     const resultLots = 0;

    //     //const isInteger = asset.lotPrecision === 0;
    //     // let resultLots = isInteger ? Math.round(lots) : math.toFixed(lots, asset.lotPrecision);
    //     // const lotsRedunantValue = isInteger ? 1 : orders.getMinIncrementValue(asset.minQuantity);

    //     // if (Math.abs(resultLots - lots) > lotsRedunantValue) {
    //     //     const rev = resultLots < lots ? 1 : -1;

    //     //     // Issue with rounding
    //     //     // Reduce lots when rounding is more than source amount and incrase when it less than non rounded lots
    //     //     while (Math.abs(resultLots - lots) >= lotsRedunantValue) {
    //     //         resultLots = math.toFixed(resultLots + lotsRedunantValue * rev, asset.lotPrecision);
    //     //     }
    //     // }

    //     return resultLots;
    // }


    // candleMsgs: Array<{ symbol: Symbol, interval: string, firstTradeId: number, lastTradeId: number, count?: number }> = []


    private candleAdapter(handler: CandleHandler, interval: TimeFrame) {
        return (msg: BinanceCandle) => {

            const { isFinal, open, high, low, close, volume, startTime, symbol, firstTradeId, lastTradeId, } = msg


            if (isFinal) {
                // console.log("candleAdapter msg:", msg);
                // const a = this.candleMsgs.find(q => q.symbol == msg.symbol && q.interval == interval.toString() && q.firstTradeId == msg.firstTradeId && q.lastTradeId == msg.lastTradeId)

                // if (!a)
                //     this.candleMsgs.push({ symbol: msg.symbol, interval, firstTradeId: msg.firstTradeId, lastTradeId: msg.lastTradeId, count: 1 })
                // else {
                //     this.candleMsgs = this.candleMsgs.filter(q => q != a)
                //     this.candleMsgs.push({ symbol, interval, firstTradeId, lastTradeId, count: a.count + 1 })
                // }

                // // console.log("this.candleMsgs:", this.candleMsgs);
                // // console.log("msg:", msg);


                // handler(
                //     this.subscription.options.marketType,
                //     {
                //         o: parseFloat(open),
                //         h: parseFloat(high),
                //         l: parseFloat(low),
                //         c: parseFloat(close),
                //         v: parseFloat(volume),
                //         time: startTime,
                //         interval,
                //         symbol: { name: symbol }
                //     }
                // );
            }
        };
    }


    // async accountAdapter(handler: AccountHandler, connectorType: ProviderType, marketType: MarketType): Promise<any> {

    //     // Object.keys(this.subscription.symbols).forEach(symbol => {
    //     //     this.options.eventsCount += Object.keys(this.subscription.symbols[symbol]).length;
    //     // });

    //     return async (value: any) => {

    //         if (Number(value.eventTime) != this.lastAccountAdapterEventTime) {

    //             this.lastAccountAdapterEventTime = Number(value.eventTime)

    //             const account = await this.getAccountInfo(connectorType, marketType);

    //             let orders: Order[] = await this.getOpenOrders({ marketType })

    //             if (orders && orders.length > 0) account.orders = orders


    //             console.log("account:", account);

    //             return handler(account);
    //         }

    //     }

    //     // const currency = 'USDT'

    //     // let account: Account = {
    //     //     totals: {
    //     //         profit: 0,
    //     //         orders: 0,
    //     //         assetsCost: [
    //     //             {
    //     //                 currency,
    //     //                 current: 0,
    //     //                 start: 0,
    //     //                 max: 0,
    //     //                 min: 0
    //     //             }
    //     //         ]
    //     //     },
    //     //     assets: [],
    //     //     positions: [],
    //     //     orders: []
    //     // };

    //     // return (value: any) => {
    //     //     if (value.eventType == 'ACCOUNT_UPDATE') {
    //     //         let assets: Asset[] = [];
    //     //         let positions: Position[] = [];

    //     //         value.balances.forEach((v: { asset: any; walletBalance: string; availableBalance: string; }) => {
    //     //             account.assets.push({
    //     //                 connectorType,
    //     //                 marketType,
    //     //                 symbol: v.asset,
    //     //                 walletBalance: parseFloat(v.walletBalance),
    //     //                 availableBalance: parseFloat(v.availableBalance)
    //     //             })
    //     //         });


    //     //         value.positions.forEach((v) => {
    //     //             const positionAmount = parseFloat(v.positionAmount);
    //     //             if (v.symbol && positionAmount != 0) {
    //     //                 account.positions.push({
    //     //                     connectorType,
    //     //                     marketType,
    //     //                     symbol: v.symbol,
    //     //                     quantity: parseFloat(v.positionAmt),
    //     //                     entryPrice: parseFloat(v.entryPrice),
    //     //                     // initialMargin: parseFloat(element.initialMargin),
    //     //                     leverage: parseFloat(v.leverage),
    //     //                     side: (parseFloat(v.positionAmt) > 0) ? OrderSide.BUY : OrderSide.SELL
    //     //                 })
    //     //             }
    //     //         });

    //     //         return handler(account);
    //     //     }
    //     // };
    // }


    private accountAdapter(marketType: MarketType, handler: AccountEventHandler) {

        return (msg: OutboundAccountInfo | ExecutionReport | AccountUpdate | OrderUpdate | AccountConfigUpdate | MarginCall | UserDataStreamEvent) => {
            // ((msg: OutboundAccountInfo | ExecutionReport | AccountUpdate | OrderUpdate | AccountConfigUpdate | MarginCall) => void) & ((msg: UserDataStreamEvent) => void)

            let options: any = {}

            // console.log('accountAdapter msg:', msg);

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

            // console.log("msg:", msg);

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

            // console.log("orderBookAdapter msg:", msg);

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


    // private getInstrumentId(options: Connector) {
    //     return `${options.symbols}:${options.marketTypes}`;
    // }

    private canRetry(e: Error) {
        for (const ignoreText of this.ignoredErrorsList) {
            if (e.message.includes(ignoreText)) {
                return false;
            }
        }

        return true;
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