import { Injectable, OnModuleInit, Inject, Logger } from "@nestjs/common";
import axios from 'axios';
import { ClientProxy } from '@nestjs/microservices';
import { Order, OrderSide, MarketType, TimeFrame, CandleHandler, OrderBookHandler, TradeHandler, Candle, DepthOrder, TradeSide, ConnectorType, Connector, Account, AccountEventHandler, Asset, Position, SymbolPrice, Symbol, DataSource } from '@barfinex/types';
import { ConnectorService } from "../connector.service";

@Injectable()
export class DexGuruService implements OnModuleInit, DataSource {
    private readonly logger = new Logger(DexGuruService.name);
    private readonly BASE_URL = 'https://api.dex.guru/v1';
    private pollingIntervalId: NodeJS.Timeout | null = null;
    private readonly chain = 'ethereum'; // Используем сеть Ethereum для примера

    constructor(
        @Inject('PROVIDER_SERVICE') private readonly client: ClientProxy
    ) { }
    subscribeToAccount(options: { marketType: MarketType; }, handler: AccountEventHandler): Promise<() => void> {
        throw new Error("Method not implemented.");
    }
    subscribeToSymbols(options: { marketType: MarketType; }, handler: (marketType: MarketType, symbols: Symbol[]) => void): Promise<() => void> {
        throw new Error("Method not implemented.");
    }
    subscribeToSymbolPrices(options: { marketType: MarketType; }, handler: (marketType: MarketType, symbolPrices: SymbolPrice) => void): Promise<() => void> {
        throw new Error("Method not implemented.");
    }
    subscribe(marketType: MarketType, symbols: Symbol[], intervals: TimeFrame[]): Promise<void> {
        throw new Error("Method not implemented.");
    }
    unsubscribe(): Promise<void> {
        throw new Error("Method not implemented.");
    }
    updateSubscribeCollection(marketType: MarketType, symbols: Symbol[], intervals: TimeFrame[]): Promise<void> {
        throw new Error("Method not implemented.");
    }
    openOrder(order: Order): Promise<Order> {
        throw new Error("Method not implemented.");
    }
    closeOrder(options: { id: string; symbol: Symbol; marketType: MarketType; }): Promise<Order> {
        throw new Error("Method not implemented.");
    }
    closeAllOrders(options: { symbol: Symbol; marketType: MarketType; }): Promise<void> {
        throw new Error("Method not implemented.");
    }
    getOpenOrders(options: { symbol?: Symbol; marketType: MarketType; }): Promise<Order[]> {
        throw new Error("Method not implemented.");
    }
    getPrices(marketType: MarketType, symbols: Symbol[]): Promise<{ [index: string]: { value: number; moment: number; }; }> {
        throw new Error("Method not implemented.");
    }
    getAssetsInfo(marketType: MarketType): Promise<{ assets: Asset[]; positions: Position[]; }> {
        throw new Error("Method not implemented.");
    }
    getSymbolsInfo(connectorType: ConnectorType, marketType: MarketType): Promise<Symbol[]> {
        throw new Error("Method not implemented.");
    }
    getAccountInfo(marketType: MarketType): Promise<Account> {
        throw new Error("Method not implemented.");
    }
    changeLeverage(symbol: Symbol, newLeverage: number): Promise<Symbol> {
        throw new Error("Method not implemented.");
    }

    async onModuleInit() {
        this.logger.log(`ModuleInit`);
    }

    // Получение текущей цены токена с DEX.guru
    async getTokenPrice(tokenAddress: string): Promise<number> {
        const url = `${this.BASE_URL}/tokens/${tokenAddress}-${this.chain}`;
        const response = await axios.get(url);
        return response.data.priceUSD;
    }

    // Получение процентного изменения цены токена за последние 24 часа
    async getTokenPriceChange(tokenAddress: string): Promise<number> {
        const priceStart = await this.getTokenPrice24hAgo(tokenAddress);
        const priceCurrent = await this.getTokenPrice(tokenAddress);
        return ((priceCurrent - priceStart) / priceStart) * 100;
    }

    // Получение цены токена 24 часа назад
    async getTokenPrice24hAgo(tokenAddress: string): Promise<number> {
        const url = `${this.BASE_URL}/tokens/${tokenAddress}-${this.chain}?interval=24h`;
        const response = await axios.get(url);
        return response.data.priceUSD;
    }

    // Симуляция торговли токеном (DEX.guru не предоставляет API для торговли)
    async simulateTrade(tokenAddress: string, price: number, volume: number): Promise<void> {
        console.log(`Симуляция сделки на DEX.guru: Токен: ${tokenAddress}, Цена: ${price}, Объем: ${volume}`);
    }

    // Подписка на обновления свечей




    // Метод для подписки на обновления свечей
    public async subscribeToСandles(options: { marketType: MarketType, symbols: Symbol[], interval: TimeFrame }, handler: CandleHandler) {
        const { marketType, symbols, interval } = options
        const fetchCandleData = async () => {
            try {
                for (const symbol of options.symbols) {
                    const response = await axios.get(`${this.BASE_URL}/candles`, {
                        params: {
                            token: symbol,
                            interval, // интервал свечей
                        },
                    });
                    const candles = response.data;
                    if (candles && candles.length) {
                        handler(marketType, candles[candles.length - 1]); // Отправляем последнюю свечу
                    }
                }
            } catch (error) {
                console.error("Error fetching candle data:", error);
            }
        };

        // Стартуем периодический запрос данных
        fetchCandleData();
        this.pollingIntervalId = setInterval(fetchCandleData, this.getIntervalMs(interval));

        // Возвращаем функцию для отписки
        return () => {
            if (this.pollingIntervalId) {
                clearInterval(this.pollingIntervalId);
                this.pollingIntervalId = null;
            }
            console.log("Unsubscribed from candles:", options.symbols);
        };
    }


    // Преобразование интервала в миллисекунды
    private getIntervalMs(interval: TimeFrame): number {
        switch (interval) {
            case TimeFrame.min1:
                return 60 * 1000;
            case TimeFrame.min5:
                return 5 * 60 * 1000;
            case TimeFrame.min15:
                return 15 * 60 * 1000;
            case TimeFrame.h1:
                return 60 * 60 * 1000;
            case TimeFrame.day:
                return 24 * 60 * 60 * 1000;
            default:
                throw new Error(`Unsupported interval: ${interval}`);
        }
    }



    // async subscribeToСandles(options: Connector, handler: CandleHandler, interval: TimeFrame) {
    //     // console.log(`Подписка на свечи для символов: ${symbols.join(', ')} с интервалом: ${interval}`);

    //     const symbols = options.symbols

    //     // Это симуляция, так как API DEX.guru не поддерживает подписки на свечи
    //     setInterval(async () => {
    //         const url = `${this.BASE_URL}/tokens/${symbols[0]}-${this.chain}/candles?interval=${this.convertTimeFrame(interval)}`;
    //         const response = await axios.get(url);
    //         const candleData = response.data[0]; // Получаем первую свечу (пример)

    //         const candle: Candle = {
    //             o: candleData.open,
    //             h: candleData.high,
    //             l: candleData.low,
    //             c: candleData.close,
    //             v: candleData.volume,
    //             time: candleData.timestamp,
    //             interval: interval,
    //             symbol: symbols[0]
    //         };

    //         handler(candle);
    //     }, 60000); // Симулируем обновление свечей каждую минуту

    //     return () => {
    //         // this.assets.delete(this.getInstrumentId(options));

    //         unsubscribe({
    //             delay: 0,
    //             fastClose: true,
    //             keepClosed: true,
    //         });
    //     };

    // }

    // Преобразование TimeFrame в интервал DEX.guru
    private convertTimeFrame(interval: TimeFrame): string {
        switch (interval) {
            case TimeFrame.min1: return '1m';
            case TimeFrame.min5: return '5m';
            case TimeFrame.min15: return '15m';
            case TimeFrame.min30: return '30m';
            case TimeFrame.h1: return '1h';
            case TimeFrame.h4: return '4h';
            case TimeFrame.day: return '1d';
            default: throw new Error('Unsupported time frame');
        }
    }

    // Метод для подписки на ордербук
    public async subscribeToOrderBook(options: { marketType: MarketType, symbols: Symbol[] }, handler: OrderBookHandler) {
        const { marketType, symbols } = options

        const fetchOrderBookData = async () => {
            try {
                for (const symbol of symbols) {
                    const response = await axios.get(`${this.BASE_URL}/orderbook`, {
                        params: {
                            token: symbol,
                            market_type: marketType, // передаем тип рынка
                        },
                    });
                    const orderBook = response.data;
                    if (orderBook) {
                        handler(marketType, orderBook); // Передаем полученные данные в обработчик
                    }
                }
            } catch (error) {
                console.error("Error fetching order book data:", error);
            }
        };

        // Стартуем периодический запрос данных
        fetchOrderBookData();
        this.pollingIntervalId = setInterval(fetchOrderBookData, 2000); // Интервал обновления 2 секунды

        // Возвращаем функцию для отписки
        return () => {
            if (this.pollingIntervalId) {
                clearInterval(this.pollingIntervalId);
                this.pollingIntervalId = null;
            }
            console.log("Unsubscribed from order book:", symbols);
        };
    }


    // Метод для подписки на трейды
    public async subscribeToTrade(options: { marketType: MarketType, symbols: Symbol[] }, handler: TradeHandler) {
        const { marketType, symbols } = options

        const fetchTradeData = async () => {
            try {
                for (const symbol of symbols) {
                    const response = await axios.get(`${this.BASE_URL}/trades`, {
                        params: {
                            token: symbol,
                            market_type: marketType, // передаем тип рынка
                        },
                    });
                    const trades = response.data;
                    if (trades && trades.length) {
                        trades.forEach((trade: any) => handler(marketType, trade)); // Обработка всех трейдов
                    }
                }
            } catch (error) {
                console.error("Error fetching trade data:", error);
            }
        };

        // Стартуем периодический запрос данных
        fetchTradeData();
        this.pollingIntervalId = setInterval(fetchTradeData, 2000); // Интервал обновления 2 секунды

        // Возвращаем функцию для отписки
        return () => {
            if (this.pollingIntervalId) {
                clearInterval(this.pollingIntervalId);
                this.pollingIntervalId = null;
            }
            console.log("Unsubscribed from trades:", symbols);
        };
    }

    // Размещение ордера (реальная торговля не поддерживается DEX.guru, это симуляция)
    async placeOrder(order: Order): Promise<Order> {
        console.log(`Размещение ордера: ${JSON.stringify(order)}`);

        // Симулируем выполнение ордера с задержкой
        await new Promise((resolve) => setTimeout(resolve, 3000)); // Задержка 3 секунды

        // Возвращаем ордер как выполненный
        return {
            ...order,
            externalId: '12345', // Пример идентификатора
            updateTime: Date.now(),
            price: order.price,
            quantity: order.quantity
        };
    }
}