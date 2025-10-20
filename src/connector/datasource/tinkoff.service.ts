import { ConsoleLogger, Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Order, OrderSide, MarketType, TimeFrame, CandleHandler, OrderBookHandler, TradeHandler, Candle, DepthOrder, TradeSide, ConnectorType, Connector, Account, AccountEventHandler, Asset, Position, SymbolPrice, SymbolSubscription, Symbol, DataSource } from '@barfinex/types';


@Injectable()
export class TinkoffService implements OnModuleInit, DataSource {

    private readonly logger = new Logger(TinkoffService.name);

    private unSubscribeCollection: { [key: string]: SymbolSubscription } = {}

    delay = async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms));

    constructor() { }

    subscribeToСandles(options: { marketType: MarketType; symbols: Symbol[]; interval: TimeFrame; }, handler: CandleHandler): Promise<() => void> {
        throw new Error("Method not implemented.");
    }
    subscribeToOrderBook(options: { marketType: MarketType; symbols: Symbol[]; }, handler: OrderBookHandler): Promise<() => void> {
        throw new Error("Method not implemented.");
    }
    subscribeToAccount(options: { marketType: MarketType; }, handler: AccountEventHandler): Promise<() => void> {
        throw new Error("Method not implemented.");
    }
    subscribeToTrade(options: { marketType: MarketType; symbols: Symbol[]; }, handler: TradeHandler): Promise<() => void> {
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
    openOrder(order: Order): Promise<Order> {
        throw new Error("Method not implemented.");
    }
    closeOrder(options: { id: string; symbol: Symbol; marketType: MarketType; }): Promise<Order> {
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

    async closeAllOrders(options: { symbol: Symbol, marketType: MarketType }): Promise<void> {
        // return null;
    }

    public async getOpenOrders(options: { symbol: Symbol, detectorSysname: string, marketType: MarketType }): Promise<Order[]> {
        return [];

    }

    public async updateSubscribeCollection(marketType: MarketType, symbols: Symbol[]) {
        // return null;
    }

    unregisterEvents(symbol: Symbol) {

        return null;
    }

    async registerEvents(symbol: Symbol) {
        return null;
    }

    public async placeOrder(order: Order, options: Connector): Promise<Order> {
        return {} as Order;
    }

    public prepareLots(lots: number, instrumentId: string) {
        return null;
    }

}