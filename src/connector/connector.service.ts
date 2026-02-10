// connector.service.ts (без изменений логики; как у тебя)
import {
    BadRequestException,
    Injectable,
    OnModuleInit,
    OnModuleDestroy,
} from '@nestjs/common';

import {
    Asset,
    Connector,
    Order,
    TimeFrame,
    Position,
    ConnectorType,
    MarketType,
    Symbol,
    OrderSource,
    Subscription,
    SubscriptionType,
    Account,
    Detector,
} from '@barfinex/types';

import { ConnectorRegistry } from './connector.registry';
import { ConnectorBuilder } from './connector.builder';
import { ConnectorReadService } from './connector.read.service';
import { ConnectorTradeService } from './connector.trade.service';
import { ConnectorSubscriptionService } from './connector.subscription.service';
import { ConnectorLifecycle } from './connector.lifecycle';

@Injectable()
export class ConnectorService
    implements OnModuleInit, OnModuleDestroy {

    constructor(
        private readonly readService: ConnectorReadService,
        private readonly tradeService: ConnectorTradeService,
        private readonly subscriptionService: ConnectorSubscriptionService,
        private readonly lifecycle: ConnectorLifecycle,
        private readonly builder: ConnectorBuilder,
    ) { }

    // =========================================================================
    // 🔹 LIFECYCLE
    // =========================================================================

    async onModuleInit(): Promise<void> {
        // await this.lifecycle.onModuleInit();
    }

    async onModuleDestroy(): Promise<void> {
        // await this.lifecycle.onModuleDestroy();
    }

    // =========================================================================
    // 🔹 STATIC-LIKE ACCESS (через Registry)
    // =========================================================================

    /** backward compatibility */
    get key(): string | undefined {
        return ConnectorRegistry.key;
    }

    getAllConnectors(): Connector[] {
        return ConnectorRegistry.getAllConnectors();
    }

    getAllAccounts(): Account[] {
        return ConnectorRegistry.getAllAccounts();
    }

    // =========================================================================
    // 🔁 BACKWARD COMPATIBILITY STATIC API
    // =========================================================================

    static addSubscription(options: {
        connectorType: ConnectorType;
        marketType: MarketType;
        subscription: Subscription;
    }): void {
        ConnectorRegistry.addSubscription(options);
    }

    static getSubscription(options: {
        connectorType: ConnectorType;
        marketType: MarketType;
        subscriptionType: SubscriptionType;
    }): Subscription {
        return ConnectorRegistry.getSubscription(options);
    }

    static setAccount(account: Account): void {
        ConnectorRegistry.setAccount(account);
    }

    static getAccount(
        connectorType: ConnectorType,
        marketType: MarketType,
    ): Account {
        return ConnectorRegistry.getAccount(connectorType, marketType);
    }

    static setAccounts(accounts: Account[]): void {
        ConnectorRegistry.setAccounts(accounts);
    }

    // =========================================================================
    // 🔹 READ
    // =========================================================================

    async getAssetsInfo(
        connectorType: ConnectorType,
        marketType: MarketType,
    ): Promise<{ assets: Asset[]; positions: Position[] }> {
        return this.readService.getAssetsInfo(connectorType, marketType);
    }

    async getSymbolsInfo(
        connectorType: ConnectorType,
        marketType: MarketType,
    ): Promise<Symbol[]> {
        return this.readService.getSymbolsInfo(connectorType, marketType);
    }

    async getAccountInfo(
        connectorType: ConnectorType,
        marketType: MarketType,
    ) {
        return this.readService.getAccountInfo(connectorType, marketType);
    }

    async getPrices(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbols: Symbol[],
    ) {
        return this.readService.getPrices(
            connectorType,
            marketType,
            symbols,
        );
    }

    async all(): Promise<Connector[]> {
        return this.readService.all();
    }

    async get(options: {
        connectorType: ConnectorType;
        marketType?: MarketType;
    }): Promise<Connector> {
        return this.readService.get(options);
    }

    // =========================================================================
    // 🔹 TRADE
    // =========================================================================

    async changeLeverage(
        connectorType: ConnectorType,
        symbol: Symbol,
        newLeverage: number,
    ): Promise<Symbol> {
        return this.tradeService.changeLeverage(
            connectorType,
            symbol,
            newLeverage,
        );
    }

    async openOrder(order: Order): Promise<Order> {
        return this.tradeService.openOrder(order);
    }

    async closeOrder(order: Order): Promise<Order> {
        return this.tradeService.closeOrder(order);
    }

    async closeAllOrders(options: {
        symbol: Symbol;
        connectorType: ConnectorType;
        marketType: MarketType;
    }): Promise<void> {
        return this.tradeService.closeAllOrders(options);
    }

    async getOpenOrders(options: {
        symbol: Symbol;
        source: OrderSource;
        connectorType: ConnectorType;
        marketType: MarketType;
    }): Promise<Order[]> {
        return this.tradeService.getOpenOrders(options);
    }

    async getAllOpenOrders(options: {
        connectorType: ConnectorType;
        marketType: MarketType;
    }): Promise<Order[]> {
        return this.tradeService.getAllOpenOrders(options);
    }

    // =========================================================================
    // 🔹 SUBSCRIPTIONS
    // =========================================================================

    async subscribeCollection(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbols: Symbol[],
        intervals: TimeFrame[],
    ) {
        return this.subscriptionService.subscribeCollection(
            connectorType,
            marketType,
            symbols,
            intervals,
        );
    }

    async unsubscribeCollection(
        connectorType: ConnectorType,
    ) {
        return this.subscriptionService.unsubscribeCollection(
            connectorType,
        );
    }

    async updateSubscribeCollection(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbols: Symbol[],
        intervals?: TimeFrame[],
    ) {
        return this.subscriptionService.updateSubscribeCollection(
            connectorType,
            marketType,
            symbols,
            intervals,
        );
    }

    // =========================================================================
    // 🔹 DETECTORS (backward compatibility)
    // =========================================================================

    getAllDetectors(): Detector[] {
        return ConnectorRegistry.getAllDetectors();
    }

    // =========================================================================
    // 🔹 LEGACY / MISC
    // =========================================================================

    async createMessage(content: string): Promise<string> {
        return content;
    }

    // =========================================================================
    // 🔹 BUILDER
    // =========================================================================

    async getConnectorsList(): Promise<Connector[]> {
        return this.builder.getConnectorsList();
    }
}
