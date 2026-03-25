import { Injectable, OnModuleInit, Inject, Logger } from '@nestjs/common';
import axios from 'axios';
import { ClientProxy } from '@nestjs/microservices';
import {
  Order,
  OrderSide,
  MarketType,
  TimeFrame,
  CandleHandler,
  OrderBookHandler,
  TradeHandler,
  Candle,
  DepthOrder,
  TradeSide,
  ConnectorType,
  Connector,
  Account,
  AccountEventHandler,
  Asset,
  Position,
  SymbolPrice,
  SymbolSubscription,
  TradingSymbol,
  DataSource,
} from '@barfinex/types';
import { ConnectorService } from '../connector.service';

@Injectable()
export class AlpacaService implements OnModuleInit, DataSource {
  private readonly logger = new Logger(AlpacaService.name);

  private unSubscribeCollection: { [key: string]: SymbolSubscription } = {};

  delay = async (ms: number) =>
    await new Promise((resolve) => setTimeout(resolve, ms));

  constructor() {}

  subscribeToСandles(
    options: { marketType: MarketType; symbols: TradingSymbol[]; interval: TimeFrame },
    handler: CandleHandler,
  ): Promise<() => void> {
    throw new Error('Method not implemented.');
  }
  subscribeToOrderBook(
    options: { marketType: MarketType; symbols: TradingSymbol[] },
    handler: OrderBookHandler,
  ): Promise<() => void> {
    throw new Error('Method not implemented.');
  }
  subscribeToAccount(
    options: { marketType: MarketType },
    handler: AccountEventHandler,
  ): Promise<() => void> {
    throw new Error('Method not implemented.');
  }
  subscribeToTrade(
    options: { marketType: MarketType; symbols: TradingSymbol[] },
    handler: TradeHandler,
  ): Promise<() => void> {
    throw new Error('Method not implemented.');
  }
  subscribeToSymbols(
    options: { marketType: MarketType },
    handler: (marketType: MarketType, symbols: TradingSymbol[]) => void,
  ): Promise<() => void> {
    throw new Error('Method not implemented.');
  }
  subscribeToSymbolPrices(
    options: { marketType: MarketType },
    handler: (marketType: MarketType, symbolPrices: SymbolPrice) => void,
  ): Promise<() => void> {
    throw new Error('Method not implemented.');
  }
  subscribe(
    marketType: MarketType,
    symbols: TradingSymbol[],
    intervals: TimeFrame[],
  ): Promise<void> {
    throw new Error('Method not implemented.');
  }
  unsubscribe(): Promise<void> {
    throw new Error('Method not implemented.');
  }
  openOrder(order: Order): Promise<Order> {
    throw new Error('Method not implemented.');
  }
  closeOrder(options: {
    id: string;
    symbol: TradingSymbol;
    marketType: MarketType;
  }): Promise<Order> {
    throw new Error('Method not implemented.');
  }
  getPrices(
    marketType: MarketType,
    symbols: TradingSymbol[],
  ): Promise<{ [index: string]: { value: number; moment: number } }> {
    throw new Error('Method not implemented.');
  }
  getAssetsInfo(
    marketType: MarketType,
  ): Promise<{ assets: Asset[]; positions: Position[] }> {
    throw new Error('Method not implemented.');
  }
  getSymbolsInfo(
    connectorType: ConnectorType,
    marketType: MarketType,
  ): Promise<TradingSymbol[]> {
    throw new Error('Method not implemented.');
  }
  getAccountInfo(marketType: MarketType): Promise<Account> {
    throw new Error('Method not implemented.');
  }
  changeLeverage(symbol: TradingSymbol, newLeverage: number): Promise<TradingSymbol> {
    throw new Error('Method not implemented.');
  }

  async onModuleInit() {
    this.logger.log(`ModuleInit`);
  }

  async closeAllOrders(options: {
    symbol: TradingSymbol;
    marketType: MarketType;
  }): Promise<void> {
    return;
  }

  public async getOpenOrders(options: {
    symbol: TradingSymbol;
    detectorSysname: string;
    marketType: MarketType;
  }): Promise<Order[]> {
    return [];
  }

  public async updateSubscribeCollection(
    marketType: MarketType,
    symbols: TradingSymbol[],
    intervals: TimeFrame[],
  ): Promise<void> {
    return;
  }

  unregisterEvents(symbol: TradingSymbol) {
    return null;
  }

  async registerEvents(symbol: TradingSymbol) {
    return null;
  }

  public async placeOrder(order: Order, options: Connector): Promise<Order> {
    return order;
  }

  public prepareLots(lots: number, instrumentId: string) {
    return null;
  }
}
