// import { forwardRef, Inject, Injectable, InternalServerErrorException, Logger, NotFoundException, OnModuleInit } from "@nestjs/common";
// import { AppError, ErrorEnvironment } from '../../error';
// import Binance, {
//     BidDepth as BinanceBidDepth,
//     Candle as BinanceCandle,
//     CandleChartInterval,
//     Depth as BinanceDepth,
//     AggregatedTrade as BinanceAggregatedTrade,
//     ExchangeInfo,
//     FuturesOrder,
//     NewFuturesOrder,
//     NewOrderMarketBase,
//     Order as BinanceOrder,
//     FuturesOrder as BinanceFuturesOrder,
//     OrderSide as OrderSideBinance,
//     OrderType as BinanceOrderType,
//     PositionSide,
//     NewOrderSpot,
//     NewOrderLimit,
//     NewOrderSL,
//     MarketNewFuturesOrder,
//     LimitNewFuturesOrder,
//     TakeProfitNewFuturesOrder,
//     StopNewFuturesOrder,
//     OutboundAccountInfo,
//     ExecutionReport,
//     AccountUpdate,
//     OrderUpdate,
//     MarginCall,
//     AccountConfigUpdate,
//     UserDataStreamEvent,
//     TakeProfitMarketNewFuturesOrder,
//     StopMarketNewFuturesOrder,
//     FuturesIncomeResult,
//     Binance as BinanceClient
// } from 'binance-api-node';
// import {
//     Order,
//     DataSource,
//     OrderSide,
//     OrderType,
//     TimeFrame,
//     CandleHandler,
//     OrderBookHandler,
//     TradeHandler,
//     DepthOrder,
//     Candle,
//     Trade,
//     TradeSide,
//     OrderBook,
//     Account,
//     Asset,
//     Position,
//     ConnectorType,
//     MarketType,
//     SubscriptionType,
//     AccountEventHandler,
//     AccountEvent,
//     Subscription,
//     OrderSourceType,
//     Symbol,
//     SymbolPrice,
//     AccountDailyProfitDetail,
//     SubscriptionValue
// } from '@barfinex/types';
// import moment from 'moment';
// import { ConnectorService } from "../connector.service";
// import axios from 'axios';
// import { WebSocketService } from './websocket.service';
// import { InjectRepository } from "@nestjs/typeorm";
// // import { SymbolEntity } from "../../symbol/symbol.entity";
// import { SymbolRepository } from '../../symbol/symbol.repository';
// // import { SymbolEventAdapter } from '../../symbol/symbol-event.adapter';
// import { Repository } from "typeorm";
// import { ConfigService } from "@barfinex/config";
// import { CandleService } from '../../candle/candle.service';
// // import { candleMapper } from "@barfinex/utils";

// @Injectable()
// export class BinanceService implements OnModuleInit, DataSource {

//     private readonly logger = new Logger(BinanceService.name);

//     private ready = false;
//     private readyPromise!: Promise<void>;
//     private resolveReady!: () => void;



//     private isEmitToRedisEnabled = true

//     private lastSymbolsHash: string | null = null;

//     private connectorType = ConnectorType.binance


//     private subscription: {
//         options?: { symbols: Symbol[], intervals?: TimeFrame[] }
//         unsubscribeAccount?: () => void;
//         unsubscribeOrderBook?: () => void;
//         unsubscribeTrade?: () => void;
//         unsubscribeSymbolPrices?: () => void;
//         unsubscribeSymbols?: () => void;
//         unsubscribeCandles?: () => void;
//     } = {};

//     private lastAccountAdapterEventTime: number = 0

//     delay = async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms));

//     private api!: BinanceClient;

//     protected candles: Candle[] = [];

//     get currentCandle() {
//         return this.candles[0];
//     }

//     private client!: ClientProxy;

//     protected providerKey: string | null = null

//     constructor(
//         private readonly configService: ConfigService,
//         private readonly webSocketService: WebSocketService,

//         private readonly symbolRepository: SymbolRepository,

//         @Inject(forwardRef(() => CandleService))
//         private readonly candleService: CandleService,

//     ) {

//         this.readyPromise = new Promise(res => this.resolveReady = res);
//     }

//     async onModuleInit() {
//         this.logger.log('🧩 BinanceService initializing...');

//         /* === 🧠 1. Подключение к Redis === */
//         const tcpHost = process.env.REDIS_HOST || 'localhost';
//         const tcpPort = Number(process.env.REDIS_PORT ?? '6379');

//         if (isNaN(tcpPort) || tcpPort <= 0 || tcpPort > 65535) {
//             this.logger.error(`Invalid Redis port: ${tcpPort}`);
//         }

//         this.logger.log(`Connecting to Redis on ${tcpHost}:${tcpPort}`);

//         this.client = createLegacyClient({
//             transport: legacy redis transport,
//             options: { host: tcpHost, port: tcpPort },
//         } as RedisOptions);

//         try {
//             await this.client.connect();
//             this.logger.log('✅ Connected to Redis successfully!');
//         } catch (error: any) {
//             this.logger.error('❌ Failed to connect to Redis:', error?.message || error);
//         }

//         /* === ⚙️ 2. Загрузка конфигурации === */
//         const config = this.configService.getConfig();
//         // this.logger.debug('🔍 Loaded config:', config);

//         // Получаем блок provider
//         const providerConfig = config.provider;
//         if (!providerConfig?.connectors?.length) {
//             this.logger.error('Provider connectors not defined in configuration');
//             throw new InternalServerErrorException('No connectors found in provider configuration');
//         }

//         // Ищем конфиг конкретно для Binance
//         const connectorConfig = providerConfig.connectors.find(
//             (c: { connectorType: string; }) => c.connectorType === 'binance',
//         );

//         if (!connectorConfig) {
//             this.logger.error('❌ Binance connector not found in configuration');
//             throw new InternalServerErrorException('Binance connector not found in configuration');
//         }

//         const connectorKey = connectorConfig.key ?? process.env.BINANCE_API_KEY;
//         const connectorSecret = connectorConfig.secret ?? process.env.BINANCE_API_SECRET;

//         if (!connectorKey || !connectorSecret) {
//             this.logger.error('❌ Binance API credentials missing in config or environment');
//             throw new InternalServerErrorException('Binance API credentials missing');
//         }

//         this.logger.debug(`🔑 connectorKey (truncated): ${connectorKey.slice(0, 6)}...`);

//         /* === 🌐 3. Инициализация Binance API === */
//         type BinanceTimeResponse = { serverTime: number };

//         const fetchBinanceTime = async (): Promise<number> => {
//             const res = await fetch('https://api.binance.com/api/v3/time');
//             const { serverTime } = (await res.json()) as Partial<BinanceTimeResponse>;
//             if (typeof serverTime !== 'number') {
//                 throw new InternalServerErrorException('Invalid Binance time response');
//             }
//             return serverTime;
//         };

//         try {
//             this.api = Binance({
//                 apiKey: connectorKey,
//                 apiSecret: connectorSecret,
//                 getTime: fetchBinanceTime,
//             });
//             this.logger.log('✅ Binance API initialized successfully');
//         } catch (err: any) {
//             this.logger.error('❌ Failed to initialize Binance API:', err?.message || err);
//             throw new InternalServerErrorException('Failed to initialize Binance API');
//         }

//         /* === 🕒 4. Проверка соединения с Binance === */
//         try {
//             const time = await this.api.time();
//             this.logger.log(
//                 `🕒 Binance time: ${moment.utc(time).format('YYYY-MM-DD HH:mm:ss')}, Local: ${moment
//                     .utc(Date.now())
//                     .format('YYYY-MM-DD HH:mm:ss')}`,
//             );
//         } catch (err: any) {
//             this.logger.warn('⚠️ Unable to fetch Binance time:', err?.message || err);
//         }

//         this.ready = true;
//         this.resolveReady();

//         this.logger.log('✅ BinanceService ModuleInit complete');
//     }


//     // async onApplicationBootstrap() {
//     //     this.ready = true;
//     //     this.resolveReady();
//     //     this.logger.log('🚀 BinanceService fully ready AFTER bootstrap');
//     // }


//     async ensureReady(): Promise<void> {
//         if (this.ready) return;
//         await this.readyPromise;
//     }


//     /**
//      * Fetches current prices for the given symbols in a specified market type.
//      * @param marketType - Market type (spot or futures).
//      * @param symbols - Array of trading symbols.
//      * @returns An object mapping symbols to their current price and timestamp.
//      */
//     async getPrices(marketType: MarketType, symbols: Symbol[]): Promise<{ [index: string]: { value: number, moment: number } }> {

//         await this.ensureReady();

//         let result: { [index: string]: { value: number, moment: number } } = {}

//         let exchangePrices: { [index: string]: string } = {}
//         let exchangeTime: number = Date.now();

//         // if (!this.api) {
//         //     this.logger.warn('[BinanceService] API not initialized, returning empty prices');
//         //     return result;
//         // }


//         switch (marketType) {
//             case MarketType.spot:
//                 exchangeTime = await this.api?.time();
//                 exchangePrices = await this.api?.prices()
//                 break;
//             case MarketType.futures:
//                 exchangeTime = await this.api?.futuresTime();
//                 exchangePrices = await this.api?.futuresPrices()
//                 break;
//         }

//         symbols.forEach(symbol => {
//             if (exchangePrices[symbol.name]) result[symbol.name] = { value: Number(exchangePrices[symbol.name]), moment: exchangeTime }
//         });
//         return result
//     }

//     async getHistory(options: {
//         marketType: MarketType;
//         symbols: Symbol[];
//         interval: TimeFrame;
//         days: number;         // как у вас (например 7/100)
//         gapDays?: number;     // опционально
//     }): Promise<Candle[]> {

//         await this.ensureReady();

//         const { marketType, symbols, interval, days, gapDays = 0 } = options;

//         return this.candleService.getHistory({
//             connectorType: ConnectorType.binance,
//             marketType,
//             symbols,
//             days,
//             interval,
//             gapDays,
//         });
//     }


//     /**
//      * Retrieves asset and position information for a specified market type.
//      * @param marketType - Market type (spot or futures).
//      * @returns Object containing arrays of assets and positions.
//      */
//     async getAssetsInfo(marketType: MarketType): Promise<{ assets: Asset[], positions: Position[] }> {

//         await this.ensureReady();

//         const currency = 'USDT'

//         let result: { assets: Asset[], positions: Position[] } = {
//             assets: [],
//             positions: []
//         };

//         // if (!this.api) {
//         //     this.logger.warn('[BinanceService] API not initialized, returning empty prices');
//         //     return result;
//         // }


//         switch (marketType) {
//             case MarketType.spot:

//                 const pricesSpot = await this.api?.prices();
//                 const accountInfoSpot = (await this.api?.accountInfo()).balances.filter(q => parseFloat(q.free) != 0 || parseFloat(q.locked));
//                 accountInfoSpot.forEach(element => {
//                     result.assets.push({
//                         connectorType: this.connectorType,
//                         marketType,
//                         symbol: { name: element.asset },
//                         walletBalance: parseFloat(element.free) + parseFloat(element.locked),
//                         availableBalance: parseFloat(element.free),
//                         price: [{ currency, value: (element.asset == currency) ? parseFloat('1') : parseFloat(pricesSpot[element.asset + currency]) }]
//                     })
//                 });
//                 break;
//             case MarketType.futures:

//                 const pricesFutures = await this.api?.futuresPrices();

//                 const accountInfoFutures = await this.api?.futuresAccountInfo();
//                 const accountInfoFutures_Assets = accountInfoFutures.assets.filter(q => parseFloat(q.walletBalance) != 0 || parseFloat(q.availableBalance));
//                 accountInfoFutures_Assets.forEach(element => {
//                     result.assets.push({
//                         connectorType: this.connectorType,
//                         marketType,
//                         symbol: { name: element.asset },
//                         walletBalance: parseFloat(element.walletBalance),
//                         availableBalance: parseFloat(element.availableBalance),
//                         price: [{ currency, value: (element.asset == currency) ? parseFloat('1') : parseFloat(pricesFutures[element.asset + currency]) }]
//                     })
//                 });

//                 const accountInfoFutures_Positions = accountInfoFutures.positions.filter(q => parseFloat(q.positionAmt) != 0);
//                 accountInfoFutures_Positions.forEach(element => {
//                     result.positions.push({
//                         connectorType: this.connectorType,
//                         marketType,
//                         symbol: { name: element.symbol },
//                         quantity: parseFloat(element.positionAmt),
//                         entryPrice: parseFloat(element.entryPrice),
//                         initialMargin: parseFloat(element.initialMargin),
//                         leverage: parseFloat(element.leverage),
//                         side: (parseFloat(element.positionAmt) > 0) ? TradeSide.LONG : TradeSide.SHORT,
//                         lastPrice: Number(pricesFutures[element.symbol])
//                     })
//                 });
//                 break;
//         }

//         return result;
//     }

//     /**
//      * Retrieves information about tradable symbols for a specific connector and market type.
//      * @param connectorType - The type of the connector (e.g., Binance).
//      * @param marketType - Market type (spot, futures, or margin).
//      * @returns An array of symbol details.
//      */
//     async getSymbolsInfo(connectorType: ConnectorType, marketType: MarketType): Promise<Symbol[]> {

//         await this.ensureReady();

//         const result: Symbol[] = [];

//         // if (!this.api) {
//         //     this.logger.warn('[BinanceService] API not initialized, returning empty prices');
//         //     return result;
//         // }

//         if (connectorType === ConnectorType.binance) {
//             try {
//                 if (marketType === MarketType.spot) {
//                     // Получение информации о спотовых рынках
//                     const exchangeInfo = await this.api?.exchangeInfo();
//                     exchangeInfo.symbols.forEach((item) => {
//                         result.push({
//                             name: item.symbol,
//                             baseAsset: item.baseAsset,
//                             quoteAsset: item.quoteAsset,
//                             status: item.status,
//                             minPrice: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.minPrice,
//                             maxPrice: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.maxPrice,
//                             minQuantity: item.filters.find((filter) => filter.filterType === 'LOT_SIZE')?.minQty,
//                             stepSize: item.filters.find((filter) => filter.filterType === 'LOT_SIZE')?.stepSize,
//                             tickSize: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.tickSize,
//                             isSpotTradingAllowed: item.isSpotTradingAllowed,
//                             isMarginTradingAllowed: item.isMarginTradingAllowed,
//                             connectorType: connectorType,
//                             marketType: marketType,
//                         });
//                     });

//                 } else if (marketType === MarketType.futures) {
//                     const exchangeInfo = await this.api?.futuresExchangeInfo();
//                     exchangeInfo.symbols.forEach((item) => {
//                         result.push({
//                             name: item.symbol, // <-- исправлено
//                             baseAsset: item.baseAsset,
//                             quoteAsset: item.quoteAsset,
//                             status: item.status,
//                             minPrice: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.minPrice,
//                             maxPrice: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.maxPrice,
//                             minQuantity: item.filters.find((filter) => filter.filterType === 'LOT_SIZE')?.minQty,
//                             stepSize: item.filters.find((filter) => filter.filterType === 'LOT_SIZE')?.stepSize,
//                             tickSize: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.tickSize,
//                             isSpotTradingAllowed: false,
//                             isMarginTradingAllowed: false,
//                             connectorType: connectorType,
//                             marketType: marketType,
//                         });
//                     });

//                 } else if (marketType === MarketType.margin) {

//                     const config = this.configService.getConfig();
//                     const connectors = config.provider?.connectors ?? [];

//                     const securityConfig = connectors.find(
//                         (q: { connectorType: any; }) => q.connectorType === this.connectorType
//                     );

//                     if (!securityConfig) {
//                         throw new InternalServerErrorException(
//                             `Connector config not found for type: ${this.connectorType}`
//                         );
//                     }

//                     const restApiUrl = 'https://api.binance.com/sapi/v1/margin/allPairs';
//                     const response = await axios.get(restApiUrl, {
//                         headers: {
//                             'X-MBX-APIKEY': securityConfig.key,
//                         },
//                     });

//                     response.data.forEach((item: any) => {
//                         result.push({
//                             name: `${item.baseAsset}${item.quoteAsset}`,
//                             baseAsset: item.baseAsset,
//                             quoteAsset: item.quoteAsset,
//                             status: 'TRADING',
//                             connectorType: connectorType,
//                             marketType: marketType,
//                         });
//                     });
//                 }
//             } catch (error: any) {
//                 this.logger.error(
//                     `Error fetching symbols from Binance for connectorType: ${connectorType}, marketType: ${marketType}`,
//                     error.stack,
//                 );

//                 throw new InternalServerErrorException('Failed to fetch symbols from Binance. Please try again later.');
//             }
//         }

//         return result;
//     }


//     /**
//      * Retrieves detailed account information for a specified market type.
//      * @param marketType - Market type (spot or futures).
//      * @returns Object containing account assets, positions, orders, and more.
//      */
//     async getAccountInfo(marketType: MarketType): Promise<Account> {

//         await this.ensureReady();

//         const currency = 'USDT'

//         let result: Account = {
//             connectorType: this.connectorType,
//             marketType,
//             assets: [],
//             positions: [],
//             orders: [],
//             symbols: [],
//             isActive: false,
//         };

//         // if (!this.api) {
//         //     this.logger.warn('[BinanceService] API not initialized, returning empty prices');
//         //     return result;
//         // }


//         let startIncomeTime = Number(moment.utc(moment().utc()).add(-1, 'days').format('x'))
//         let endIncomeTime = Number(moment().utc().format('x'))

//         // if (this.connectorType == ProviderType.binance) {
//         switch (marketType) {
//             case MarketType.spot:

//                 const pricesSpot = await this.api?.prices();


//                 const accountInfoSpot = (await this.api?.accountInfo())?.balances.filter(q => parseFloat(q.free) != 0 || parseFloat(q.locked));


//                 accountInfoSpot?.forEach(element => {
//                     result.assets.push({
//                         connectorType: this.connectorType,
//                         marketType,
//                         symbol: { name: element.asset },
//                         walletBalance: parseFloat(element.free) + parseFloat(element.locked),
//                         availableBalance: parseFloat(element.free),
//                         price: [{ currency, value: (element.asset == currency) ? parseFloat('1') : parseFloat(pricesSpot[element.asset + currency] ? pricesSpot[element.asset + currency] : '0') }]

//                     })

//                 });

//                 result.dailyProfit = {
//                     value: 0,
//                     startTime: startIncomeTime,
//                     endTime: endIncomeTime,
//                     details: []
//                 };

//                 break;
//             case MarketType.futures:

//                 const pricesFutures = await this.api?.futuresPrices();
//                 const accountInfoFutures = await this.api?.futuresAccountInfo();
//                 const accountInfoFutures_Assets = accountInfoFutures?.assets.filter(q => Number(q.walletBalance) != 0 && Number(q.availableBalance) != 0);
//                 accountInfoFutures_Assets?.forEach(element => {
//                     result.assets.push({
//                         connectorType: this.connectorType,
//                         marketType,
//                         symbol: { name: element.asset },
//                         walletBalance: parseFloat(element.walletBalance),
//                         availableBalance: parseFloat(element.availableBalance),
//                         price: [{ currency, value: (element.asset == currency) ? parseFloat('1') : parseFloat(pricesFutures[element.asset + currency]) }]
//                     })
//                 });

//                 const accountInfoFutures_Positions = accountInfoFutures?.positions.filter(q => parseFloat(q.positionAmt) != 0);
//                 accountInfoFutures_Positions?.forEach(element => {

//                     if (!result.symbols.find((q: { name: string; }) => q.name == element.symbol)) result.symbols.push({ name: element.symbol });

//                     result.positions.push({
//                         connectorType: this.connectorType,
//                         marketType,
//                         symbol: { name: element.symbol },
//                         quantity: parseFloat(element.positionAmt),
//                         entryPrice: parseFloat(element.entryPrice),
//                         initialMargin: parseFloat(element.initialMargin),
//                         leverage: parseFloat(element.leverage),
//                         side: (parseFloat(element.positionAmt) > 0) ? TradeSide.LONG : TradeSide.SHORT,
//                         lastPrice: Number(pricesFutures[element.symbol])
//                     })

//                 });

//                 const filterAssets = result.assets.filter((q: { symbol: { name: string; }; }) => q.symbol.name != currency)

//                 for (let i = 0; i < filterAssets.length; i++) {
//                     const asset = filterAssets[i];

//                     const orders = await this.api?.futuresOpenOrders({ symbol: asset.symbol + currency } as any);

//                     let type: OrderType
//                     let side: OrderSide

//                     orders.forEach(order => {

//                         side = order.side as OrderSide

//                         switch (order.type.toString()) {
//                             // case 'MARKET': type = OrderType.MARKET; break
//                             case 'LIMIT': type = OrderType.LIMIT; break
//                             case 'TAKE_PROFIT_LIMIT': type = OrderType.TAKE_PROFIT; break
//                             case 'STOP_LOSS_LIMIT': type = OrderType.STOP; break
//                             default: type = OrderType.MARKET; break
//                         }

//                         const provider = this.configService.getConfig().provider;
//                         if (!provider) {
//                             throw new InternalServerErrorException('Missing provider configuration');
//                         }

//                         return result.orders.push({
//                             symbol: { name: order.symbol },
//                             side,
//                             type,
//                             quantity: Number(order.origQty),
//                             updateTime: order.updateTime,
//                             time: order.time,
//                             price: Number(order.price),
//                             useSandbox: false,
//                             connectorType: this.connectorType,
//                             marketType,
//                             source: {
//                                 type: OrderSourceType.provider,
//                                 key: this.connectorType,
//                                 restApiUrl: provider.restApiUrl,
//                             },
//                             closeTime: null
//                         });
//                     });

//                 }



//                 const futuresIncome: FuturesIncomeResult[] = await this.api?.futuresIncome({
//                     startTime: startIncomeTime,
//                 })

//                 let income = 0.00

//                 if (futuresIncome) {
//                     for (let i = 0; i < futuresIncome.length; i++) {
//                         const element = futuresIncome[i];

//                         if (i == 0) startIncomeTime = Number(moment.utc(element.time).format('x'))
//                         endIncomeTime = Number(moment.utc(element.time).format('x'))
//                         income += Number(element.income)
//                     }
//                 }


//                 const details: AccountDailyProfitDetail[] = []
//                 futuresIncome.forEach(income => {
//                     details.push({
//                         symbol: { name: income.symbol },
//                         incomeType: income.incomeType,
//                         income: income.income,
//                         asset: income.asset,
//                         info: income.info,
//                         time: income.time
//                     })
//                 });

//                 result.dailyProfit = {
//                     value: income,
//                     startTime: startIncomeTime,
//                     endTime: endIncomeTime,
//                     details: details
//                 };

//                 break;
//         }
//         if (result.assets.length > 0) result.isActive = true

//         return result
//     }

//     async changeLeverage(symbol: Symbol, newLeverage: number): Promise<Symbol> {

//         await this.ensureReady();

//         const result: Symbol = {
//             name: symbol.name
//         };

//         // if (!this.api) {
//         //     this.logger.warn('[BinanceService] API not initialized, returning empty prices');
//         //     return result;
//         // }

//         const futuresLeverage = await this.api.futuresLeverage({ symbol: symbol.name, leverage: newLeverage })

//         result.leverage = futuresLeverage.leverage

//         return result;
//     }

//     /**
//      * Places a new order.
//      * @param order - The order details, such as symbol, side, type, and quantity.
//      * @returns A Promise resolving to the placed order with updated details.
//      */
//     async openOrder(order: Order): Promise<Order> {

//         await this.ensureReady();

//         const result: Order = { ...order };

//         // if (!this.api) {
//         //     this.logger.warn('[BinanceService] API not initialized, returning empty prices');
//         //     return result;
//         // }


//         if (!order.useSandbox) {
//             switch (order.marketType) {
//                 case MarketType.spot:

//                     let spotOrderToProvider: NewOrderSpot = {} as NewOrderSpot;

//                     switch (order.type) {

//                         case OrderType.MARKET:
//                             if (order.symbol && order.quantity)
//                                 spotOrderToProvider = {
//                                     type: BinanceOrderType.MARKET,
//                                     symbol: order.symbol.name,
//                                     side: order.side,
//                                     quantity: order.quantity.toString(),
//                                 } as NewOrderMarketBase
//                             break;

//                         case OrderType.LIMIT:
//                             if (order.symbol && order.quantity && order.price)
//                                 spotOrderToProvider = {
//                                     type: BinanceOrderType.LIMIT,
//                                     symbol: order.symbol.name,
//                                     side: order.side,
//                                     // 'GTC' - Good Till Cancelled | 'IOC' - Immediate or Cancel | 'FOK' - Fill or Kill
//                                     timeInForce: 'GTC',
//                                     quantity: order.quantity.toString(),
//                                     price: order.price.toString(),
//                                 } as NewOrderLimit
//                             break;

//                         case OrderType.TAKE_PROFIT:
//                             if (order.symbol && order.quantity && order.price)
//                                 spotOrderToProvider = {
//                                     type: BinanceOrderType.TAKE_PROFIT_LIMIT,
//                                     symbol: order.symbol.name,
//                                     side: order.side,
//                                     quantity: order.quantity.toString(),
//                                     price: order.price.toString(),
//                                     // stopPrice: order.priceStop.toString(),
//                                 } as NewOrderSL
//                             break;

//                         case OrderType.STOP:
//                             if (order.symbol && order.quantity && order.price)
//                                 spotOrderToProvider = {
//                                     type: BinanceOrderType.STOP_LOSS_LIMIT,
//                                     symbol: order.symbol.name,
//                                     side: order.side,
//                                     quantity: order.quantity.toString(),
//                                     price: order.price.toString(),
//                                     // stopPrice: order.priceStop.toString(),
//                                 } as NewOrderSL
//                             break;
//                     }


//                     const spotOrderEntity = await this.api?.order(spotOrderToProvider)
//                     result.externalId = spotOrderEntity.orderId.toString()
//                     result.updateTime = spotOrderEntity.updateTime

//                     break;
//                 case MarketType.futures:

//                     let futuresOrderToProvider: NewFuturesOrder = {} as NewFuturesOrder;

//                     switch (order.type) {

//                         case OrderType.MARKET:
//                             if (order.symbol && order.quantity && order.price)
//                                 futuresOrderToProvider = {
//                                     type: order.type,
//                                     symbol: order.symbol.name,
//                                     side: order.side,
//                                     quantity: order.quantity.toString(),
//                                 } as MarketNewFuturesOrder
//                             break;

//                         case OrderType.LIMIT:
//                             if (order.symbol && order.quantity && order.price)
//                                 futuresOrderToProvider = {
//                                     type: order.type,
//                                     symbol: order.symbol.name,
//                                     side: order.side,
//                                     // 'GTC' - Good Till Cancelled | 'IOC' - Immediate or Cancel | 'FOK' - Fill or Kill
//                                     timeInForce: 'GTC',
//                                     quantity: order.quantity.toString(),
//                                     price: order.price.toString(),
//                                 } as LimitNewFuturesOrder
//                             break;

//                         case OrderType.TAKE_PROFIT:
//                             if (order.symbol && order.quantity && order.price)
//                                 futuresOrderToProvider = {
//                                     type: order.type,
//                                     symbol: order.symbol.name,
//                                     side: order.side,
//                                     quantity: order.quantity.toString(),
//                                     //price: order.price.toString(),
//                                     stopPrice: order.price.toString(),
//                                 } as TakeProfitNewFuturesOrder
//                             break;

//                         case OrderType.STOP:
//                             if (order.symbol && order.quantity && order.price)
//                                 futuresOrderToProvider = {
//                                     type: order.type,
//                                     symbol: order.symbol.name,
//                                     side: order.side,
//                                     quantity: order.quantity.toString(),
//                                     //price: order.price.toString(),
//                                     stopPrice: order.price.toString(),
//                                 } as StopNewFuturesOrder
//                             break;

//                         case OrderType.TAKE_PROFIT_MARKET:
//                             if (order.symbol && order.quantity && order.price)
//                                 futuresOrderToProvider = {
//                                     type: order.type,
//                                     symbol: order.symbol.name,
//                                     side: order.side,
//                                     quantity: order.quantity.toString(),
//                                     stopPrice: order.price.toString(),
//                                     workingType: "MARK_PRICE",
//                                     priceProtect: "TRUE",
//                                     priceMatch: "NONE",
//                                     selfTradePreventionMode: "NONE",
//                                     goodTillDate: 0,
//                                     positionSide: "BOTH",
//                                     closePosition: "true",
//                                 } as TakeProfitMarketNewFuturesOrder
//                             break;

//                         case OrderType.STOP_MARKET:
//                             if (order.symbol && order.quantity && order.price)
//                                 futuresOrderToProvider = {
//                                     type: order.type,
//                                     symbol: order.symbol.name,
//                                     side: order.side,
//                                     quantity: order.quantity.toString(),
//                                     stopPrice: order.price.toString(),
//                                     workingType: "MARK_PRICE",
//                                     priceProtect: "TRUE",
//                                     priceMatch: "NONE",
//                                     selfTradePreventionMode: "NONE",
//                                     goodTillDate: 0,
//                                     positionSide: "BOTH",
//                                     closePosition: "true",
//                                 } as StopMarketNewFuturesOrder
//                             break;
//                     }

//                     let orders: Order[] = await this.getOpenOrders({ marketType: order.marketType })

//                     let futuresOrderEntity: FuturesOrder = {} as FuturesOrder

//                     if (!orders.find(q => q.symbol && q.symbol.name == futuresOrderToProvider.symbol && q.type == futuresOrderToProvider.type && q.side == futuresOrderToProvider.side)) {
//                         futuresOrderEntity = await this.api?.futuresOrder(futuresOrderToProvider)
//                     }

//                     if (futuresOrderEntity) {
//                         result.externalId = futuresOrderEntity.orderId.toString()
//                         result.updateTime = futuresOrderEntity.updateTime
//                     }
//                     break;
//             }
//         }

//         return result;
//     }



//     /**
//      * Closes an existing order by its ID.
//      * @param options - Object containing the order ID, symbol, and market type.
//      * @returns A Promise resolving to the closed order.
//      */
//     async closeOrder(options: { id: string, symbol: Symbol, marketType: MarketType }): Promise<Order> {

//         await this.ensureReady();

//         const result: Order = {} as Order;

//         // if (!this.api) {
//         //     this.logger.warn('[BinanceService] API not initialized, returning empty prices');
//         //     return result;
//         // }


//         const { id, symbol, marketType } = options

//         const orders = await this.api?.futuresOpenOrders({ symbol: symbol.name });
//         const element = orders.find(q => q.orderId == id)

//         if (!element) throw new NotFoundException(`Order with id ${id} not found`)

//         const provider = this.configService.getConfig().provider;

//         if (!provider) {
//             throw new InternalServerErrorException('Provider config is missing');
//         }

//         result.symbol = { name: element.symbol }
//         result.externalId = element.orderId.toString()
//         result.side = element.side.toString() as OrderSide
//         result.type = element.type.toString() as OrderType
//         result.price = parseFloat(element.price)
//         result.quantity = parseFloat(element.origQty)
//         result.time = element.time
//         result.updateTime = element.updateTime
//         result.source = {
//             type: OrderSourceType.provider,
//             key: this.connectorType,
//             restApiUrl: provider.restApiUrl,
//         },
//             result.useSandbox = false
//         result.marketType = marketType
//         result.connectorType = this.connectorType


//         if (element) await this.api?.futuresCancelOrder({ orderId: +id, symbol: symbol.name })

//         return result
//     }

//     /**
//      * Closes all open orders for a specific symbol and market type.
//      * @param options - Object containing the symbol and market type.
//      * @returns A Promise that resolves when all orders are closed.
//      */
//     async closeAllOrders(options: { symbol: Symbol, marketType: MarketType }): Promise<void> {

//         await this.ensureReady();

//         const { symbol, marketType } = options

//         if (marketType == MarketType.spot) {
//             await this.api?.cancelOpenOrders({ symbol: symbol.name })
//         } else {
//             await this.api?.futuresCancelAllOpenOrders({ symbol: symbol.name })
//         }

//     }


//     /**
//      * Retrieves a list of open orders for a specific symbol and market type.
//      * @param options - Object containing the optional symbol and market type.
//      * @returns A Promise resolving to an array of open orders.
//      */
//     public async getOpenOrders(options: { symbol?: Symbol, marketType: MarketType }): Promise<Order[]> {

//         let result: Order[] = []

//         // if (!this.api) {
//         //     this.logger.warn('[BinanceService] API not initialized, returning empty prices');
//         //     return result;
//         // }

//         const { symbol, marketType } = options

//         if (marketType == MarketType.spot) {

//             const ordersInProvider_Spot = await this.api?.openOrders((symbol) ? { symbol: symbol.name } : {});

//             for (let i = 0; i < ordersInProvider_Spot.length; i++) {
//                 const element = ordersInProvider_Spot[i];

//                 const config = this.configService.getConfig();
//                 const provider = config.provider;

//                 if (!provider) {
//                     throw new InternalServerErrorException('Provider config is missing');
//                 }

//                 let order: Order = {
//                     symbol: { name: element.symbol },
//                     externalId: element.orderId.toString(),
//                     side: element.side.toString() as OrderSide,
//                     type: element.type.toString() as OrderType,
//                     price: parseFloat(element.price),
//                     quantity: parseFloat(element.origQty),
//                     time: element.time,
//                     updateTime: element.updateTime,
//                     source: {
//                         type: OrderSourceType.provider,
//                         key: this.connectorType,
//                         restApiUrl: provider.restApiUrl,
//                     },
//                     useSandbox: false,
//                     marketType,
//                     connectorType: this.connectorType,
//                     closeTime: null
//                 };


//                 result.push(order);
//             }

//         } else {

//             const ordersInProvider_Futures = await this.api?.futuresOpenOrders((symbol) ? { symbol: symbol.name } : {});

//             ordersInProvider_Futures.forEach(order => {

//                 const type = order.type.toString() as OrderType
//                 let price = parseFloat(order.price)

//                 if (type == OrderType.STOP_MARKET || type == OrderType.TAKE_PROFIT_MARKET)
//                     price = parseFloat(order.stopPrice)

//                 const config = this.configService.getConfig();
//                 const provider = config.provider;

//                 if (!provider) {
//                     throw new InternalServerErrorException('Provider config is missing');
//                 }

//                 result.push({
//                     symbol: { name: order.symbol },
//                     externalId: order.orderId,
//                     side: order.side.toString() as OrderSide,
//                     type,
//                     price,
//                     quantity: parseFloat(order.origQty),
//                     time: order.time,
//                     updateTime: order.updateTime,
//                     useSandbox: false,
//                     connectorType: this.connectorType,
//                     marketType,
//                     source: {
//                         type: OrderSourceType.provider,
//                         key: this.connectorType,
//                         restApiUrl: provider.restApiUrl,
//                     },
//                     closeTime: null
//                 });

//             });
//         }

//         return result

//     }

//     /**
//      * Unsubscribes from all active subscriptions.
//      * @returns A Promise that resolves when all subscriptions are successfully unsubscribed.
//      */
//     public async unsubscribe(): Promise<void> {

//         if (this.subscription.unsubscribeAccount) this.subscription.unsubscribeAccount()
//         if (this.subscription.unsubscribeOrderBook) this.subscription.unsubscribeOrderBook()
//         if (this.subscription.unsubscribeTrade) this.subscription.unsubscribeTrade()
//         if (this.subscription.unsubscribeSymbols) this.subscription.unsubscribeSymbols()
//         if (this.subscription.unsubscribeSymbolPrices) this.subscription.unsubscribeSymbolPrices()
//         await this.delay(2000);
//     }

//     /**
//      * Subscribes to multiple data streams for specified symbols and time frames.
//      * @param marketType - The market type (e.g., spot, futures).
//      * @param symbols - Array of symbols to subscribe to.
//      * @param intervals - Array of time frames for the subscription.
//      * @returns A Promise that resolves when the subscription is active.
//      */
//     public async subscribe(marketType: MarketType, symbols: Symbol[], intervals?: TimeFrame[]): Promise<void> {

//         const config = this.configService.getConfig();

//         if (!config.provider?.connectors) {
//             throw new InternalServerErrorException('Provider connectors not configured');
//         }

//         const connector = config.provider.connectors.find(
//             (c: { connectorType: any; markets: any[]; }) =>
//                 c.connectorType === this.connectorType &&
//                 c.markets?.some((m: { marketType: any; }) => m.marketType === marketType)
//         );

//         if (!connector) {
//             throw new InternalServerErrorException(`Connector ${this.connectorType}-${marketType} not found in config`);
//         }

//         const subscriptionsConfig = connector.subscriptions || [];


//         for (const subscriptionConfig of subscriptionsConfig) {

//             // console.log('subscriptionsConfig', subscriptionConfig);
//             // console.log('subscriptionsConfig', subscriptionConfig.intervals);

//             if (!subscriptionConfig.active) continue;

//             switch (subscriptionConfig.type) {


//                 case SubscriptionType.PROVIDER_ACCOUNT_EVENT:
//                     try {
//                         this.subscription.unsubscribeAccount =
//                             await this.subscribeToAccount(
//                                 { marketType },
//                                 this.handlerForAccount
//                             );

//                         this.logger.log(
//                             `Subscribed to PROVIDER_ACCOUNT_EVENT for ${marketType} market.`
//                         );
//                     } catch (err: any) {
//                         this.logger.error(
//                             `Failed to subscribe to PROVIDER_ACCOUNT_EVENT for ${marketType} market: ${err.message}`
//                         );
//                     }
//                     break;



//                 case SubscriptionType.INSPECTOR_RISK_LIMIT_BREACH:
//                     break;
//                 case SubscriptionType.PROVIDER_MARKETDATA_CANDLE:
//                     const intervals =
//                         subscriptionConfig.intervals ??
//                         subscriptionConfig.detector?.intervals ??
//                         [];

//                     if (!intervals || intervals.length === 0) {
//                         this.logger.warn(
//                             `No intervals provided for PROVIDER_MARKETDATA_CANDLE, symbols=${symbols
//                                 .map((s) => s.name)
//                                 .join(", ")}`
//                         );
//                         continue;
//                     }

//                     for (const interval of intervals) {
//                         this.subscription.unsubscribeCandles = await this.subscribeToСandles(
//                             { marketType, symbols, interval },
//                             this.handlerForCandle
//                         );

//                         this.logger.log(
//                             `Subscribed to PROVIDER_MARKETDATA_CANDLE interval=${interval} for ${symbols
//                                 .map((s) => s.name)
//                                 .join(", ")}`
//                         );
//                     }
//                     break;


//                 case SubscriptionType.PROVIDER_ORDER_CLOSE:
//                 case SubscriptionType.PROVIDER_ORDER_CREATE:
//                     break;

//                 case SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK:
//                     this.subscription.unsubscribeOrderBook = await this.subscribeToOrderBook(
//                         { marketType, symbols },
//                         this.handlerForOrderbook
//                     );
//                     break;

//                 case SubscriptionType.PROVIDER_MARKETDATA_TRADE:
//                     this.subscription.unsubscribeTrade = await this.subscribeToTrade(
//                         { marketType, symbols },
//                         this.handlerForTrade
//                     );
//                     break;

//                 case SubscriptionType.PROVIDER_SYMBOLS:
//                     // 🚫 если это Futures — можно не отключать, просто логируем
//                     if (marketType === MarketType.futures) {
//                         this.logger.warn(
//                             `Subscribing to PROVIDER_SYMBOLS on futures market (symbols will be updated hourly)`
//                         );
//                     }

//                     try {
//                         this.subscription.unsubscribeSymbols = await this.subscribeToSymbols(
//                             { marketType },
//                             this.handlerForSymbols
//                         );


//                         this.logger.log(
//                             `Subscribed to PROVIDER_SYMBOLS for ${marketType} market. Symbols will refresh every hour.`
//                         );
//                     } catch (err: any) {
//                         this.logger.error(
//                             `Failed to subscribe to PROVIDER_SYMBOLS for ${marketType} market: ${err.message}`
//                         );
//                     }

//                     break;



//                 case SubscriptionType.PROVIDER_SYMBOL_PRICES:
//                     try {
//                         const symbols = await this.getSymbolsInfo(this.connectorType, marketType);

//                         if (!symbols || symbols.length === 0) {
//                             this.logger.warn(
//                                 `No symbols found on Binance for ${marketType} → skipping PROVIDER_SYMBOL_PRICES subscription.`,
//                             );
//                             break;
//                         }

//                         // 🔥 ограничиваем top20
//                         const limitedSymbols = symbols
//                             .filter((s) => s.name.endsWith('USDT'))
//                             .slice(0, 20);

//                         this.subscription.unsubscribeSymbolPrices =
//                             await this.subscribeToSymbolPrices(
//                                 {
//                                     marketType,
//                                     symbols: limitedSymbols.map((s) => s.name),
//                                 },
//                                 this.handlerForSymbolPrices,
//                             );

//                         this.logger.log(
//                             `Subscribed to PROVIDER_SYMBOL_PRICES with ${limitedSymbols.length} symbols for ${marketType} market (top20).`,
//                         );
//                     } catch (err: any) {
//                         this.logger.error(
//                             `Failed to fetch symbols for ${marketType} before PROVIDER_SYMBOL_PRICES: ${err.message}`,
//                         );
//                     }
//                     break;
//             }
//         }

//         await this.delay(2000);
//     }



//     public async subscribeToSymbols(
//         options: { marketType: MarketType },
//         handler: (marketType: MarketType, symbols: Symbol[]) => Promise<void>
//     ): Promise<() => void> {
//         const { marketType } = options;

//         const abortController = new AbortController();
//         const { signal } = abortController;

//         const fetchSymbolsAndProcess = async () => {
//             if (signal.aborted) return;

//             try {
//                 const raw = await this.getSymbolsInfo(this.connectorType, marketType);

//                 if (!raw || raw.length === 0) {
//                     this.logger.warn(`No symbols found for ${marketType} market`);
//                     return;
//                 }

//                 // ⚡ через адаптер
//                 const adapt = this.symbolsAdapter(marketType, handler);
//                 await adapt(raw);

//                 this.logger.log(
//                     `Fetched ${raw.length} symbols for ${marketType} market (before hash-check).`
//                 );
//             } catch (err: any) {
//                 this.logger.error(
//                     `Failed to fetch symbols for ${marketType} market: ${err.message}`
//                 );
//             }
//         };

//         // Первичное выполнение
//         await fetchSymbolsAndProcess();

//         // Затем обновление каждый час
//         const REFRESH_INTERVAL_MS = 3600000;
//         const intervalId = setInterval(() => {
//             fetchSymbolsAndProcess().catch((error) => {
//                 this.logger.error(
//                     `Error during scheduled fetch for ${marketType} market: ${error.message}`
//                 );
//             });
//         }, REFRESH_INTERVAL_MS);

//         this.logger.log(
//             `Subscribed to PROVIDER_SYMBOLS for ${marketType} market (hourly refresh).`
//         );

//         return () => {
//             clearInterval(intervalId);
//             abortController.abort();
//             this.logger.log(
//                 `Unsubscribed from PROVIDER_SYMBOLS on ${marketType} market.`
//             );
//         };
//     }


//     chunkSymbols(symbols: string[], maxPerWs = 50, maxUrlLength = 1900): string[][] {
//         const result: string[][] = [];
//         let batch: string[] = [];
//         let length = 0;

//         for (const sym of symbols) {
//             const stream = `${sym.toLowerCase()}@ticker`;
//             const extraLength = (batch.length > 0 ? 1 : 0) + stream.length;

//             if (
//                 batch.length >= maxPerWs ||
//                 length + extraLength > maxUrlLength
//             ) {
//                 result.push(batch);
//                 batch = [];
//                 length = 0;
//             }

//             batch.push(stream);
//             length += extraLength;
//         }

//         if (batch.length) result.push(batch);

//         return result;
//     }


//     public async subscribeToSymbolPrices(
//         options: { marketType: MarketType; symbols: string[] },
//         handler: (marketType: MarketType, symbolPrices: SymbolPrice) => void,
//     ): Promise<() => void> {
//         const { marketType, symbols } = options;

//         let wsUrl: string;

//         if (marketType === MarketType.spot) {
//             const stream = symbols.map((s) => `${s.toLowerCase()}@ticker`).join('/');
//             wsUrl = `wss://stream.binance.com:9443/stream?streams=${stream}`;
//         } else {
//             wsUrl = 'wss://fstream.binance.com/ws';
//         }

//         this.logger.log(
//             `Subscribing to WebSocket stream for ${marketType} market. URL: ${wsUrl}`,
//         );

//         // Создаём WebSocket соединение
//         const unsubscribeStream = await this.webSocketService.subscribeToStream(wsUrl);

//         // Навешиваем обработчик сообщений через АДАПТЕР (как в orderBook / trade)
//         this.webSocketService.onMessage(
//             wsUrl,
//             this.symbolPricesAdapter(marketType, handler),
//         );

//         // Для фьючерсов — подписка через метод SUBSCRIBE
//         if (marketType === MarketType.futures) {
//             this.webSocketService.onOpen(wsUrl, (ws) => {
//                 const params = symbols.map((s) => `${s.toLowerCase()}@ticker`);
//                 const payload = {
//                     method: 'SUBSCRIBE',
//                     params,
//                     id: Date.now(),
//                 };

//                 ws.send(JSON.stringify(payload));

//                 this.webSocketService.withSocket(wsUrl, (si) => {
//                     si.activeSubs = params;
//                 });

//                 this.logger.log(
//                     `Sent SUBSCRIBE for ${params.length} futures symbols.`,
//                 );
//             });
//         }

//         this.logger.log(
//             `Subscribed to price updates for ${symbols.length} symbols on ${marketType} market.`,
//         );

//         return () => {
//             if (marketType === MarketType.futures) {
//                 this.webSocketService.withSocket(wsUrl, (si) => {
//                     const payload = {
//                         method: 'UNSUBSCRIBE',
//                         params: symbols.map((s) => `${s.toLowerCase()}@ticker`),
//                         id: Date.now(),
//                     };

//                     si.ws.send(JSON.stringify(payload));

//                     this.logger.log(
//                         `Sent UNSUBSCRIBE for ${symbols.length} futures symbols.`,
//                     );
//                 });
//             }

//             unsubscribeStream();
//             this.logger.log(
//                 `Unsubscribed from price updates on ${marketType} market.`,
//             );
//         };
//     }



//     /**
//      * Updates the subscription collection by adding or removing symbols and intervals.
//      * @param marketType - The market type (e.g., spot, futures).
//      * @param symbols - Array of symbols to update in the subscription.
//      * @param intervals - Array of time frames to update in the subscription.
//      * @returns A Promise that resolves when the subscription collection is updated.
//      */
//     public async updateSubscribeCollection(marketType: MarketType, symbols: Symbol[], intervals?: TimeFrame[]): Promise<void> {


//         this.subscription.options = { symbols, intervals }
//         this.unsubscribe()
//         this.subscribe(marketType, symbols, intervals)

//     }


//     private async handlerForAccount(marketType: MarketType, accountEvent: AccountEvent) {
//         const subscriptionType = SubscriptionType.PROVIDER_ACCOUNT_EVENT;

//         // предотвращаем обработку дубликатов
//         if (accountEvent.eventTime === this.lastAccountAdapterEventTime) {
//             return;
//         }

//         this.lastAccountAdapterEventTime = accountEvent.eventTime;

//         const subscription: Subscription = {
//             type: subscriptionType,
//             updateMoment: parseFloat(moment().format('x')),
//             active: true,
//         };

//         const subscriptionValue: SubscriptionValue = {
//             value: accountEvent,
//             options: {
//                 connectorType: this.connectorType,
//                 marketType,
//                 key: this.providerKey ?? undefined,
//                 updateMoment: subscription.updateMoment ?? Date.now(),
//             },
//         };

//         // сохраняем в коллекцию
//         ConnectorService.addSubscription({
//             connectorType: this.connectorType,
//             marketType,
//             subscription,
//         });

//         // отдаём в Redis
//         if (this.isEmitToRedisEnabled) {
//             this.client.emit(subscriptionType, subscriptionValue);
//         }

//         // ---------------------------------------------------------------
//         // 🔥 FIX: корректная обработка symbol из аккаунта
//         // ---------------------------------------------------------------
//         const symbolName = accountEvent?.options?.symbol;

//         if (!symbolName || typeof symbolName !== "string") {
//             return; // нечего добавлять
//         }

//         // гарантируем корректную структуру options
//         if (!this.subscription.options) {
//             this.subscription.options = { symbols: [], intervals: [] };
//         }

//         const symbols = this.subscription.options.symbols;

//         // Проверяем, есть ли уже этот symbol как объект Symbol
//         const alreadyExists = symbols.some(
//             (s) => s?.name?.toUpperCase() === symbolName.toUpperCase()
//         );

//         if (!alreadyExists) {
//             // добавляем корректный объект типа Symbol
//             const normalized: Symbol = {
//                 name: symbolName,
//                 connectorType: this.connectorType,
//                 marketType,
//             };

//             symbols.push(normalized);

//             // Обновляем подписки на новые символы
//             this.updateSubscribeCollection(
//                 marketType,
//                 symbols, // теперь это массив Symbol[]
//                 this.subscription.options.intervals
//             );
//         }
//     }



//     private async handlerForOrderbook(marketType: MarketType, orderbook: OrderBook) {
//         const subscriptionType = SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK;

//         const bids = [...orderbook.bids.entries()].reverse().map(([, value]) => value);
//         const orderbookSort: OrderBook = { ...orderbook, bids };



//         const matchedSubscription = this.getMatchedSubscription(
//             this.connectorType,
//             marketType,
//             subscriptionType
//         );

//         const subscription: Subscription = {
//             type: subscriptionType,
//             updateMoment: Date.now(),
//             symbols: matchedSubscription.symbols,
//             active: true,
//         };

//         const subscriptionValue: SubscriptionValue = {
//             value: orderbookSort,
//             options: {
//                 connectorType: this.connectorType,
//                 marketType,
//                 key: this.providerKey ?? undefined,          // ✅ null → undefined
//                 updateMoment: subscription.updateMoment ?? Date.now(), // ✅ undefined → текущее время
//             },
//         };

//         ConnectorService.addSubscription({
//             connectorType: this.connectorType,
//             marketType,
//             subscription,
//         });

//         if (this.isEmitToRedisEnabled) {
//             this.client.emit(subscriptionType, subscriptionValue);
//         }
//     };




//     private async handlerForSymbols(marketType: MarketType, symbols: Symbol[]) {
//         const subscriptionType = SubscriptionType.PROVIDER_SYMBOLS;

//         const hash = this.hashSymbols(symbols);
//         if (this.lastSymbolsHash === hash) {
//             this.logger.debug(`Symbols unchanged → skip emit`);
//             return;
//         }
//         this.lastSymbolsHash = hash;

//         // 1️⃣ сохраняем в QuestDB и получаем SymbolEntity[]
//         const savedEntities = await this.symbolRepository.replaceAll(
//             symbols,
//             this.connectorType,
//             marketType,
//         );

//         // 2️⃣ конвертируем в доменную модель Symbol[]
//         const saved: Symbol[] = savedEntities.map(s => ({
//             name: s.symbol,
//             baseAsset: s.baseAsset,
//             quoteAsset: s.quoteAsset,
//             status: s.status,
//             connectorType: s.connectorType as any,
//             marketType: s.marketType as any,
//         }));

//         // 3️⃣ создаём подписку
//         const updateMoment = Date.now();

//         const subscription: Subscription = {
//             type: subscriptionType,
//             updateMoment,
//             active: true,
//         };

//         const subscriptionValue: SubscriptionValue = {
//             value: saved, // ← теперь корректный тип Symbol[]
//             options: {
//                 connectorType: this.connectorType,
//                 marketType,
//                 key: this.providerKey ?? undefined,
//                 updateMoment, // ← гарантированно number
//             },
//         };

//         ConnectorService.addSubscription({
//             connectorType: this.connectorType,
//             marketType,
//             subscription,
//         });

//         if (this.isEmitToRedisEnabled) {
//             this.client.emit(subscriptionType, subscriptionValue);
//         }

//         this.logger.log(
//             `Symbols updated for ${this.connectorType}/${marketType}, count=${saved.length}`
//         );
//     }




//     // утилита для подсчёта хэша
//     private hashSymbols(symbols: Symbol[]): string {
//         return symbols
//             .map((s) => s.name)
//             .sort()
//             .join('|');
//     }


//     private handlerForSymbolPrices(
//         marketType: MarketType,
//         raw: any, // Binance payload
//     ) {
//         const subscriptionType = SubscriptionType.PROVIDER_SYMBOL_PRICES;

//         const payload = raw.data ?? raw;

//         const normalized: SymbolPrice = {
//             symbol: { name: payload.s },

//             // основные метрики
//             price: Number(payload.c),
//             open: Number(payload.o),
//             high: Number(payload.h),
//             low: Number(payload.l),
//             volume: Number(payload.v),
//             change: Number(payload.p),
//             changePercent: Number(payload.P),
//             time: payload.E,

//             // дополнительные метрики Binance
//             weightedAvgPrice: Number(payload.w),
//             firstTradePrice: Number(payload.x),
//             lastQty: Number(payload.Q),
//             bestBidPrice: Number(payload.b),
//             bestBidQty: Number(payload.B),
//             bestAskPrice: Number(payload.a),
//             bestAskQty: Number(payload.A),
//             quoteVolume: Number(payload.q),
//             openTime: payload.O,
//             closeTime: payload.C,
//             firstTradeId: payload.F,
//             lastTradeId: payload.L,
//             tradeCount: payload.n,
//         } as any;


//         const subscription: Subscription = {
//             type: subscriptionType,
//             updateMoment: Date.now(),
//             active: true,
//         };

//         const subscriptionValue: SubscriptionValue = {
//             value: normalized,
//             options: {
//                 connectorType: this.connectorType,
//                 marketType,
//                 key: this.providerKey ?? undefined,
//                 updateMoment: subscription.updateMoment ?? Date.now(),
//             },
//         };

//         // console.log("📊 handlerForSymbolPrices", {
//         //     marketType,
//         //     first: normalized,
//         // });

//         ConnectorService.addSubscription({
//             connectorType: this.connectorType,
//             marketType,
//             subscription,
//         });

//         if (this.isEmitToRedisEnabled) {
//             this.client.emit(subscriptionType, subscriptionValue);
//         }
//     };




//     private getMatchedSubscription(
//         connectorType: ConnectorType,
//         marketType: MarketType,
//         subscriptionType: SubscriptionType
//     ): Subscription {
//         const config = this.configService.getConfig();

//         if (!config.provider?.connectors) {
//             throw new InternalServerErrorException('Provider connectors not configured');
//         }

//         const connector = config.provider.connectors.find(
//             (c: { connectorType: any; markets: any[]; }) =>
//                 c.connectorType === connectorType &&
//                 c.markets?.some((m: { marketType: any; }) => m.marketType === marketType)
//         );

//         const matchedSubscription = connector?.subscriptions?.find(
//             (s: { type: any; }) => s.type === subscriptionType
//         );

//         if (!matchedSubscription) {
//             throw new InternalServerErrorException(
//                 `Subscription not found for type: ${subscriptionType} in connector ${connectorType}-${marketType}`
//             );
//         }

//         return matchedSubscription;
//     }



//     private async handlerForTrade(marketType: MarketType, trade: Trade) {
//         const subscriptionType = SubscriptionType.PROVIDER_MARKETDATA_TRADE;



//         const subscription: Subscription = {
//             type: subscriptionType,
//             updateMoment: Date.now(),
//             symbols: this.getMatchedSubscription(this.connectorType, marketType, subscriptionType).symbols,
//             active: true
//         };


//         const subscriptionValue: SubscriptionValue = {
//             value: trade,
//             options: {
//                 connectorType: this.connectorType,
//                 marketType,
//                 key: this.providerKey ?? undefined,
//                 updateMoment: subscription.updateMoment ?? Date.now(),
//             },
//         };


//         ConnectorService.addSubscription({
//             connectorType: this.connectorType,
//             marketType,
//             subscription
//         });


//         // console.log('Emitting trade:', subscriptionValue);

//         if (this.isEmitToRedisEnabled) {

//             if (!this.client) {
//                 this.logger.error('❌ this.client is undefined in handlerForTrade');
//                 this.logger.error('Context is:', this);
//                 return;
//             }

//             this.client.emit(subscriptionType, subscriptionValue);
//         }
//     };


//     private async handlerForCandle(
//         marketType: MarketType,
//         candle: Candle
//     ) {
//         try {
//             const subscriptionType = SubscriptionType.PROVIDER_MARKETDATA_CANDLE;

//             const normalized: Candle = {
//                 ...candle,
//                 symbol: { name: String((candle.symbol as any)?.name || candle.symbol) },
//             };


//             const subscription: Subscription = {
//                 type: subscriptionType,
//                 updateMoment: Date.now(),
//                 symbols: [normalized.symbol],
//                 active: true,
//             };

//             const subscriptionValue: SubscriptionValue = {
//                 value: normalized,
//                 options: {
//                     connectorType: this.connectorType,
//                     marketType,
//                     key: this.providerKey ?? undefined,
//                     updateMoment: subscription.updateMoment ?? Date.now(),
//                 },
//             };


//             ConnectorService.addSubscription({
//                 connectorType: this.connectorType,
//                 marketType,
//                 subscription,
//             });

//             if (this.isEmitToRedisEnabled) {
//                 this.client.emit(subscriptionType, subscriptionValue);
//             }
//         } catch (err: any) {
//             this.logger.error(`Error in handlerForCandle: ${err?.message || err}`);
//         }
//     };



//     public async subscribeToСandles(
//         options: { marketType: MarketType; symbols: Symbol[]; interval: TimeFrame },
//         handler: CandleHandler
//     ) {
//         const { marketType, symbols, interval } = options;

//         // this.logger.warn(
//         //     `subscribeToСandles called with interval=${interval}, symbols=${symbols.map(s => s.name).join(',')}`
//         // );

//         const method = (marketType === MarketType.futures) ? 'futuresCandles' : 'candles';

//         // if (!this.api || !this.api.ws) {
//         //     this.logger.warn(`[BinanceService] API not initialized, cannot subscribeToOrderBook`);
//         //     return () => { };
//         // }

//         const unsubscribe = this.api?.ws[method](
//             symbols.map(s => s.name),
//             this.convertTimeFrame(interval), // <-- тут валится
//             this.candleAdapter(handler, marketType, interval),
//         );

//         return () => {
//             unsubscribe({
//                 delay: 0,
//                 fastClose: true,
//                 keepClosed: true,
//             });
//         };
//     }


//     public async subscribeToOrderBook(options: { marketType: MarketType, symbols: Symbol[] }, handler: OrderBookHandler) {
//         const { marketType, symbols } = options
//         const method = marketType === MarketType.futures ? 'futuresDepth' : 'depth';

//         // if (!this.api || !this.api.ws) {
//         //     this.logger.warn(`[BinanceService] API not initialized, cannot subscribeToOrderBook`);
//         //     return () => { };
//         // }

//         const unsubscribe = this.api?.ws[method](symbols.map(s => s.name), this.orderBookAdapter(marketType, handler));

//         return () => {
//             unsubscribe({
//                 delay: 0,
//                 fastClose: true,
//                 keepClosed: true,
//             });
//         };
//     }

//     public async subscribeToAccount(options: { marketType: MarketType }, handler: AccountEventHandler) {
//         const { marketType } = options
//         const method = marketType === MarketType.futures ? 'futuresUser' : 'user';

//         // if (!this.api || !this.api.ws) {
//         //     this.logger.warn(`[BinanceService] API not initialized, cannot subscribeToOrderBook`);
//         //     return () => { };
//         // }

//         const unsubscribe = await this.api?.ws[method](this.accountAdapter(marketType, handler));

//         return () => {
//             unsubscribe({
//                 delay: 0,
//                 fastClose: true,
//                 keepClosed: true,
//             });
//         };
//     }

//     public async subscribeToTrade(options: { marketType: MarketType, symbols: Symbol[] }, handler: TradeHandler) {
//         const { marketType, symbols } = options
//         const method = marketType === MarketType.futures ? 'futuresAggTrades' : 'aggTrades';

//         // if (!this.api || !this.api.ws) {
//         //     this.logger.warn(`[BinanceService] API not initialized, cannot subscribeToOrderBook`);
//         //     return () => { };
//         // }

//         const unsubscribe = this.api?.ws[method](symbols.map(s => s.name), this.tradeAdapter(marketType, handler));

//         return () => {
//             unsubscribe({
//                 delay: 0,
//                 fastClose: true,
//                 keepClosed: true,
//             });
//         };
//     }

//     // BinanceService.ts
//     private candleAdapter(handler: CandleHandler, marketType: MarketType, interval: TimeFrame) {
//         return async (msg: BinanceCandle) => {
//             try {
//                 const { isFinal, open, high, low, close, volume, startTime, symbol } = msg;

//                 if (!isFinal) return;

//                 // Приводим Binance → Candle
//                 const candle: Candle = {
//                     open: Number(open),
//                     high: Number(high),
//                     low: Number(low),
//                     close: Number(close),
//                     volume: Number(volume),
//                     time: startTime,
//                     symbol: { name: symbol },
//                     interval,
//                 };

//                 // Convert to domain if нужно
//                 // const candle = candleMapper.toDomainCandle(candleRaw);

//                 // передаём подписчикам
//                 await handler.call(this, marketType, candle);

//                 // === 🔥 NEW: Запись финальной свечи напрямую в QuestDB ===
//                 this.candleService.writeFinalCandle({
//                     symbol,
//                     interval,
//                     connectorType: this.connectorType,
//                     marketType,
//                     candle: {
//                         open: candle.open,
//                         high: candle.high,
//                         low: candle.low,
//                         close: candle.close,
//                         volume: candle.volume,

//                         time: candle.time,  // <-- главное изменение

//                         interval,
//                         symbol: { name: symbol },
//                     },
//                 });
//             } catch (err: any) {
//                 this.logger.error(`Error in candleAdapter: ${err?.message || err}`);
//             }
//         };
//     }






//     private accountAdapter(marketType: MarketType, handler: AccountEventHandler) {
//         return (msg: OutboundAccountInfo | ExecutionReport | AccountUpdate | OrderUpdate | AccountConfigUpdate | MarginCall | UserDataStreamEvent) => {
//             let options: any = {};

//             if (msg.eventType === 'ACCOUNT_UPDATE') {

//                 const account: Account = {
//                     connectorType: this.connectorType,
//                     marketType,
//                     assets: [],
//                     positions: [],
//                     orders: [],
//                     isActive: true,
//                     symbols: [],
//                 };

//                 msg.balances.map((item) => {
//                     const asset: Asset = {
//                         connectorType: this.connectorType,
//                         marketType,
//                         symbol: { name: item.asset },
//                         walletBalance: parseFloat(item.walletBalance),
//                         availableBalance: 0,
//                     };

//                     const index = account.assets.findIndex(q => q.symbol?.name === asset.symbol.name);
//                     if (index === -1) account.assets.push(asset);
//                     else account.assets[index] = asset;
//                 });

//                 msg.positions.map((item) => {
//                     const position: Position = {
//                         connectorType: this.connectorType,
//                         marketType,
//                         symbol: { name: item.symbol },
//                         quantity: parseFloat(item.positionAmount),
//                         entryPrice: parseFloat(item.entryPrice),
//                         initialMargin: 0,
//                         leverage: 0,
//                         side: item.positionSide === 'LONG' ? TradeSide.LONG : TradeSide.SHORT,
//                     };

//                     const IMR = 1 / (position.leverage || 1);
//                     position.initialMargin = position.quantity * position.entryPrice * IMR;
//                     position.side = position.quantity > 0 ? TradeSide.LONG : TradeSide.SHORT;

//                     const index = account.positions.findIndex(q => q.symbol?.name === position.symbol.name);
//                     if (index === -1) account.positions.push(position);
//                     else account.positions[index] = position;

//                     if (!account.symbols.find(q => q.name === position.symbol.name)) {
//                         account.symbols.push({ name: position.symbol.name });
//                     }

//                     ConnectorService.setAccount(account);
//                 });
//             }

//             if (msg.eventType === 'ORDER_TRADE_UPDATE') {
//                 options = {
//                     orderId: msg.orderId,
//                     orderTime: msg.orderTime,
//                     orderType: msg.orderType,
//                     orderStatus: msg.orderStatus,
//                     clientOrderId: msg.clientOrderId,
//                     symbol: msg.symbol,
//                     side: msg.side,
//                     quantity: msg.quantity,
//                 };
//             }

//             // ✅ ВАЖНО — handler вызывается с правильным this
//             handler.call(this, marketType, {
//                 eventType: msg.eventType,
//                 eventTime: Number(msg.eventTime),
//                 options,
//             });
//         };
//     }


//     private symbolsAdapter(
//         marketType: MarketType,
//         handler: (marketType: MarketType, symbols: Symbol[]) => Promise<void>
//     ) {
//         return async (rawSymbols: any[]) => {
//             if (!Array.isArray(rawSymbols)) {
//                 this.logger.warn(`SymbolsAdapter received invalid data: ${JSON.stringify(rawSymbols)}`);
//                 return;
//             }

//             const symbols: Symbol[] = rawSymbols.map((s) => ({
//                 name: s.symbol ?? s.s ?? s.name,
//                 baseAsset: s.baseAsset ?? s.base ?? undefined,
//                 quoteAsset: s.quoteAsset ?? s.quote ?? undefined,
//                 status: s.status ?? undefined,
//                 minPrice: s.filters?.find((f: { filterType: string; }) => f.filterType === 'PRICE_FILTER')?.minPrice,
//                 maxPrice: s.filters?.find((f: { filterType: string; }) => f.filterType === 'PRICE_FILTER')?.maxPrice,
//                 tickSize: s.filters?.find((f: { filterType: string; }) => f.filterType === 'PRICE_FILTER')?.tickSize,
//                 minQuantity: s.filters?.find((f: { filterType: string; }) => f.filterType === 'LOT_SIZE')?.minQty,
//                 stepSize: s.filters?.find((f: { filterType: string; }) => f.filterType === 'LOT_SIZE')?.stepSize,
//                 isSpotTradingAllowed: s.isSpotTradingAllowed ?? undefined,
//                 isMarginTradingAllowed: s.isMarginTradingAllowed ?? undefined,
//                 connectorType: this.connectorType,
//                 marketType,
//             }));

//             await handler.call(this, marketType, symbols);
//         };
//     }



//     private symbolPricesAdapter(
//         marketType: MarketType,
//         handler: (marketType: MarketType, symbolPrice: SymbolPrice) => void,
//     ) {
//         return (msg: any) => {
//             const data: SymbolPrice = msg.data ?? msg;

//             if (!data || !data.s || !data.c) {
//                 this.logger.warn(`Invalid symbol price message received: ${JSON.stringify(msg)}`);
//                 return;
//             }

//             handler.call(this, marketType, data);
//         };
//     }




//     private tradeAdapter(marketType: MarketType, handler: TradeHandler) {
//         return (msg: BinanceAggregatedTrade) => {
//             handler.call(
//                 this,
//                 marketType,
//                 {
//                     symbol: { name: msg.symbol },
//                     side: msg.isBuyerMaker ? TradeSide.SHORT : TradeSide.LONG,
//                     price: parseFloat(msg.price),
//                     volume: parseFloat(msg.quantity),
//                     time: msg.timestamp,
//                 }
//             );
//         };
//     }


//     private orderBookAdapter(marketType: MarketType, handler: OrderBookHandler) {
//         const self = this;

//         function migrateData(value: BinanceBidDepth, result: DepthOrder[]) {
//             const price = parseFloat(value.price);
//             const qty = parseFloat(value.quantity);
//             if (qty !== 0) result.push({ price, volume: qty });
//         }

//         return (msg: BinanceDepth) => {
//             const bids: DepthOrder[] = [];
//             const asks: DepthOrder[] = [];
//             const symbol: Symbol = { name: msg.symbol };
//             const time = msg.eventTime;

//             msg.bidDepth.forEach(item => migrateData(item, bids));
//             msg.askDepth.forEach(item => migrateData(item, asks));

//             handler.call(
//                 self,
//                 marketType,
//                 { bids, asks, symbol, time }
//             );
//         };
//     }


//     // BinanceService.ts
//     convertTimeFrame(interval: TimeFrame) {
//         switch (interval) {
//             case TimeFrame.min1: return CandleChartInterval.ONE_MINUTE; 
//             case TimeFrame.min5: return CandleChartInterval.FIVE_MINUTES;
//             case TimeFrame.min15: return CandleChartInterval.FIFTEEN_MINUTES;
//             case TimeFrame.min30: return CandleChartInterval.THIRTY_MINUTES;
//             case TimeFrame.h1: return CandleChartInterval.ONE_HOUR;
//             case TimeFrame.h2: return CandleChartInterval.TWO_HOURS;
//             case TimeFrame.h4: return CandleChartInterval.FOUR_HOURS;
//             case TimeFrame.day: return CandleChartInterval.ONE_DAY;
//             case TimeFrame.week: return CandleChartInterval.ONE_WEEK; 
//             case TimeFrame.month: return CandleChartInterval.ONE_MONTH;
//         }
//         throw new AppError(ErrorEnvironment.Provider, 'Unsupported interval');
//     }

// }