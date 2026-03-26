import { Injectable, Logger } from '@nestjs/common';
import {
  Connector,
  ConnectorMarket,
  Asset,
  Position,
  Order,
} from '@barfinex/types';
import { ConnectorRegistry } from './connector.registry';

/**
 * Runtime-safe Connector:
 * — массивы всегда инициализированы
 * — никаких optional внутри engine
 */
type RuntimeConnector = Omit<
  Connector,
  'assets' | 'positions' | 'orders' | 'markets' | 'subscriptions'
> & {
  assets: Asset[];
  positions: Position[];
  orders: Order[];
  markets: ConnectorMarket[];
  subscriptions: NonNullable<Connector['subscriptions']>;
};

@Injectable()
export class ConnectorBuilder {
  private readonly logger = new Logger(ConnectorBuilder.name);

  // =========================================================================
  // 🔹 GENERIC DEDUP
  // =========================================================================
  private dedupByKey<T>(items: readonly T[], key: (item: T) => string): T[] {
    const map = new Map<string, T>();
    for (const item of items) {
      map.set(key(item), item);
    }
    return Array.from(map.values());
  }

  // =========================================================================
  // 🔹 BUILD CONNECTORS (PURE, IDEMPOTENT, ENGINE-GRADE)
  // =========================================================================
  async getConnectorsList(): Promise<Connector[]> {
    const accounts = ConnectorRegistry.accounts ?? [];

    if (accounts.length === 0) {
      this.logger.warn('No accounts in ConnectorRegistry');
      return [];
    }

    const connectors = new Map<string, RuntimeConnector>();

    for (const account of accounts) {
      if (!account.connectorType || !account.marketType) continue;

      const connectorKey = account.connectorType;

      // =============================================================
      // INIT CONNECTOR (runtime-normalized)
      // =============================================================
      if (!connectors.has(connectorKey)) {
        connectors.set(connectorKey, {
          connectorType: account.connectorType,
          isActive: account.isActive ?? false,
          markets: [],
          assets: [],
          positions: [],
          orders: [],
          subscriptions: [],
        });
      }

      const connector = connectors.get(connectorKey)!;
      connector.isActive ||= account.isActive ?? false;

      // =============================================================
      // MARKETS + SYMBOLS
      // =============================================================
      let market = connector.markets.find(
        (m) => m.marketType === account.marketType,
      );

      if (!market) {
        market = {
          marketType: account.marketType,
          instruments: [],
        };
        connector.markets.push(market);
      }

      market.instruments = this.dedupByKey(
        [...market.instruments, ...(account.instruments ?? [])],
        (s) => s.symbol,
      );

      // =============================================================
      // ASSETS
      // =============================================================
      connector.assets = this.dedupByKey(
        [...connector.assets, ...(account.assets ?? [])],
        (a) => `${a.marketType}:${a.instrument?.symbol}`,
      );

      // =============================================================
      // POSITIONS
      // =============================================================
      connector.positions = this.dedupByKey(
        [...connector.positions, ...(account.positions ?? [])],
        (p) => `${p.marketType}:${p.instrument?.symbol}:${p.side}`,
      );

      // =============================================================
      // ORDERS
      // =============================================================
      connector.orders = this.dedupByKey(
        [...connector.orders, ...(account.orders ?? [])],
        (o) => `${o.marketType}:${o.externalId}`,
      );
    }

    // ⬇️ возвращаем как Connector (DTO-friendly)
    return Array.from(connectors.values());
  }
}
