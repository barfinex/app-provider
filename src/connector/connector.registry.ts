// connector.registry.ts
import {
    Connector,
    Account,
    Detector,
    Subscription,
    SubscriptionType,
    ConnectorType,
    MarketType,
} from '@barfinex/types';
import { makeConnectorKey } from './connector-key.util';

export class ConnectorRegistry {
    static connectors: { [key: string]: Connector } = {};
    static accounts: Account[];
    static detectors: Detector[];
    static key: string;

    // =========================================================================
    // 🔹 CONNECTORS
    // =========================================================================

    static getAllConnectors(): Connector[] {
        return Object.values(this.connectors);
    }

    static getConnector(options: {
        connectorType: ConnectorType;
        marketType?: MarketType;
    }): Connector | undefined {
        if (!options.marketType) {
            console.warn(`No marketType provided for connector ${options.connectorType}`);
            return undefined;
        }

        const key = makeConnectorKey(options.connectorType, options.marketType);
        return this.connectors[key];
    }

    static setConnector(options: {
        connectorType: ConnectorType;
        marketType: MarketType;
        connector: Connector;
    }): void {
        const key = makeConnectorKey(options.connectorType, options.marketType);
        this.connectors[key] = options.connector;
    }

    // =========================================================================
    // 🔹 ACCOUNTS
    // =========================================================================

    static setAccounts(accounts: Account[]): void {
        this.accounts = accounts;
    }

    static getAllAccounts(): Account[] {
        return this.accounts;
    }

    static getAccount(
        connectorType: ConnectorType,
        marketType: MarketType,
    ): Account {
        const account = this.accounts.find(
            q => q.connectorType === connectorType && q.marketType === marketType,
        );

        if (!account) {
            throw new Error(`Account not found for ${connectorType}/${marketType}`);
        }

        return account;
    }

    static setAccount(account: Account): void {
        const index = this.accounts.findIndex(
            q =>
                q.connectorType === account.connectorType &&
                q.marketType === account.marketType,
        );

        if (index > -1) this.accounts[index] = account;
        else this.accounts.push(account);
    }

    // =========================================================================
    // 🔹 DETECTORS
    // =========================================================================

    static setDetectors(detectors: Detector[]): void {
        this.detectors = detectors;
    }

    static getAllDetectors(): Detector[] {
        return this.detectors;
    }

    // =========================================================================
    // 🔹 SUBSCRIPTIONS
    // =========================================================================

    static addSubscription(options: {
        connectorType: ConnectorType;
        marketType: MarketType;
        subscription: Subscription;
    }): void {
        const key = makeConnectorKey(options.connectorType, options.marketType);
        const connector = this.connectors[key];

        if (!connector) {
            console.warn(`[ConnectorRegistry] addSubscription skipped — connector not found: ${key}`);
            return;
        }

        if (!connector.subscriptions) {
            connector.subscriptions = [];
        }

        const subscriptionIndex =
            connector.subscriptions.findIndex(
                q => q.type === options.subscription.type,
            );

        if (subscriptionIndex === -1) {
            connector.subscriptions.push(options.subscription);
        } else {
            connector.subscriptions[subscriptionIndex] =
                options.subscription;
        }
    }

    static getSubscription(options: {
        connectorType: ConnectorType;
        marketType: MarketType;
        subscriptionType: SubscriptionType;
    }): Subscription {
        const key = makeConnectorKey(options.connectorType, options.marketType);
        const connector = this.connectors[key];

        if (!connector) {
            throw new Error(`[ConnectorRegistry] Connector not found: ${key}`);
        }

        if (!connector.subscriptions || connector.subscriptions.length === 0) {
            throw new Error(
                `[ConnectorRegistry] No subscriptions for connector: ${key}`,
            );
        }

        const subscription = connector.subscriptions.find(
            q => q.type === options.subscriptionType,
        );

        if (!subscription) {
            throw new Error(
                `[ConnectorRegistry] Subscription not found for ${options.subscriptionType} on ${key}`,
            );
        }

        return subscription;
    }
}
