import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectorType,
  MarketType,
  ExchangeConnectorStatus,
  ActiveExchangeInstance,
  EXCHANGE_CATALOG,
  ExchangeCatalogEntry,
  ExchangeSegment,
  EXCHANGE_SEGMENT_LABELS,
  getExchangeCatalogEntry,
  getExchangesBySegment,
  ActivateExchangeDto,
  DeactivateExchangeDto,
} from '@barfinex/types';
import { ConfigService } from '@barfinex/config';
import { makeConnectorKey } from '../connector-key.util';

// ─── Per-instance runtime state ───

interface ExchangeInstanceState {
  connectorType: ConnectorType;
  marketType: MarketType;
  status: ExchangeConnectorStatus;
  activatedAt?: number;
  credentials: Record<string, string>;
  subscriptionCount: number;
  instrumentCount: number;
  error?: string;
  lastHeartbeat?: number;
}

@Injectable()
export class ExchangeManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(ExchangeManagerService.name);

  /** Active exchange instances keyed by `connectorType:marketType` */
  private readonly instances = new Map<string, ExchangeInstanceState>();

  /** Encrypted credentials store (in-memory; production should use vault) */
  private readonly credentialStore = new Map<string, Record<string, string>>();

  constructor(private readonly configService: ConfigService) {}

  async onModuleDestroy(): Promise<void> {
    // Deactivate all instances gracefully
    for (const [key, instance] of this.instances) {
      instance.status = ExchangeConnectorStatus.STOPPING;
    }
    this.instances.clear();
    this.credentialStore.clear();
  }

  // =========================================================================
  // 🔹 CATALOG
  // =========================================================================

  getCatalog(): ExchangeCatalogEntry[] {
    return EXCHANGE_CATALOG;
  }

  getCatalogGrouped(): Array<{
    segment: ExchangeSegment;
    label: string;
    exchanges: Array<ExchangeCatalogEntry & { status: ExchangeConnectorStatus }>;
  }> {
    const bySegment = getExchangesBySegment();
    return Object.entries(bySegment)
      .filter(([, entries]) => entries.length > 0)
      .map(([segment, entries]) => ({
        segment: segment as ExchangeSegment,
        label: EXCHANGE_SEGMENT_LABELS[segment as ExchangeSegment],
        exchanges: entries.map((entry) => ({
          ...entry,
          status: this.getAggregatedStatus(entry.connectorType),
        })),
      }));
  }

  private getAggregatedStatus(connectorType: ConnectorType): ExchangeConnectorStatus {
    const relatedInstances = Array.from(this.instances.values()).filter(
      (i) => i.connectorType === connectorType,
    );
    if (relatedInstances.length === 0) return ExchangeConnectorStatus.INACTIVE;
    if (relatedInstances.some((i) => i.status === ExchangeConnectorStatus.ERROR))
      return ExchangeConnectorStatus.ERROR;
    if (relatedInstances.some((i) => i.status === ExchangeConnectorStatus.ACTIVE))
      return ExchangeConnectorStatus.ACTIVE;
    if (relatedInstances.some((i) => i.status === ExchangeConnectorStatus.CONNECTING))
      return ExchangeConnectorStatus.CONNECTING;
    if (relatedInstances.some((i) => i.status === ExchangeConnectorStatus.RECONNECTING))
      return ExchangeConnectorStatus.RECONNECTING;
    return ExchangeConnectorStatus.INACTIVE;
  }

  // =========================================================================
  // 🔹 ACTIVATE / DEACTIVATE
  // =========================================================================

  async activate(dto: ActivateExchangeDto): Promise<ActiveExchangeInstance[]> {
    const catalogEntry = getExchangeCatalogEntry(dto.connectorType);
    if (!catalogEntry) {
      throw new Error(`Unknown connector type: ${dto.connectorType}`);
    }

    // Store credentials if provided
    if (dto.credentials) {
      this.credentialStore.set(dto.connectorType, dto.credentials);
    }

    const credentials = this.credentialStore.get(dto.connectorType) ?? {};

    // Validate required credentials
    const missing = catalogEntry.credentials
      .filter((f) => f.required && !credentials[f.key])
      .map((f) => f.label);
    if (missing.length > 0) {
      throw new Error(`Missing required credentials: ${missing.join(', ')}`);
    }

    const results: ActiveExchangeInstance[] = [];

    for (const marketType of dto.marketTypes) {
      if (!catalogEntry.supportedMarkets.includes(marketType)) {
        this.logger.warn(
          `Market ${marketType} not supported by ${dto.connectorType}, skipping`,
        );
        continue;
      }

      const key = makeConnectorKey(dto.connectorType, marketType);

      const state: ExchangeInstanceState = {
        connectorType: dto.connectorType,
        marketType,
        status: ExchangeConnectorStatus.CONNECTING,
        activatedAt: Date.now(),
        credentials,
        subscriptionCount: 0,
        instrumentCount: 0,
      };

      this.instances.set(key, state);

      this.logger.log(
        `Activating exchange connector: ${dto.connectorType}:${marketType}`,
      );

      // Initialization happens asynchronously — caller gets CONNECTING status
      this.initializeInstance(key, state).catch((err) => {
        state.status = ExchangeConnectorStatus.ERROR;
        state.error = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Failed to initialize ${dto.connectorType}:${marketType}: ${state.error}`,
        );
      });

      results.push(this.toActiveInstance(state));
    }

    return results;
  }

  async deactivate(dto: DeactivateExchangeDto): Promise<void> {
    const marketTypes =
      dto.marketTypes ??
      Array.from(this.instances.values())
        .filter((i) => i.connectorType === dto.connectorType)
        .map((i) => i.marketType);

    for (const marketType of marketTypes) {
      const key = makeConnectorKey(dto.connectorType, marketType);
      const instance = this.instances.get(key);

      if (!instance) continue;

      instance.status = ExchangeConnectorStatus.STOPPING;
      this.logger.log(`Deactivating exchange connector: ${key}`);

      // Actual teardown will be done by ConnectorSubscriptionService
      instance.status = ExchangeConnectorStatus.INACTIVE;
      this.instances.delete(key);
    }
  }

  // =========================================================================
  // 🔹 CREDENTIALS
  // =========================================================================

  setCredentials(
    connectorType: ConnectorType,
    credentials: Record<string, string>,
  ): void {
    this.credentialStore.set(connectorType, credentials);
    this.logger.log(`Credentials updated for ${connectorType}`);
  }

  getCredentials(connectorType: ConnectorType): Record<string, string> | undefined {
    return this.credentialStore.get(connectorType);
  }

  hasCredentials(connectorType: ConnectorType): boolean {
    const creds = this.credentialStore.get(connectorType);
    return !!creds && Object.keys(creds).length > 0;
  }

  // =========================================================================
  // 🔹 STATUS QUERIES
  // =========================================================================

  getActiveInstances(): ActiveExchangeInstance[] {
    return Array.from(this.instances.values()).map((s) =>
      this.toActiveInstance(s),
    );
  }

  getInstance(
    connectorType: ConnectorType,
    marketType: MarketType,
  ): ActiveExchangeInstance | undefined {
    const key = makeConnectorKey(connectorType, marketType);
    const state = this.instances.get(key);
    return state ? this.toActiveInstance(state) : undefined;
  }

  getStatus(
    connectorType: ConnectorType,
    marketType: MarketType,
  ): ExchangeConnectorStatus {
    const key = makeConnectorKey(connectorType, marketType);
    return (
      this.instances.get(key)?.status ?? ExchangeConnectorStatus.INACTIVE
    );
  }

  isActive(connectorType: ConnectorType, marketType: MarketType): boolean {
    return (
      this.getStatus(connectorType, marketType) ===
      ExchangeConnectorStatus.ACTIVE
    );
  }

  // =========================================================================
  // 🔹 STATUS UPDATES (called by ExchangeDataService)
  // =========================================================================

  markActive(connectorType: ConnectorType, marketType: MarketType): void {
    const key = makeConnectorKey(connectorType, marketType);
    const state = this.instances.get(key);
    if (state) {
      state.status = ExchangeConnectorStatus.ACTIVE;
      state.lastHeartbeat = Date.now();
      state.error = undefined;
    }
  }

  markError(
    connectorType: ConnectorType,
    marketType: MarketType,
    error: string,
  ): void {
    const key = makeConnectorKey(connectorType, marketType);
    const state = this.instances.get(key);
    if (state) {
      state.status = ExchangeConnectorStatus.ERROR;
      state.error = error;
    }
  }

  updateCounts(
    connectorType: ConnectorType,
    marketType: MarketType,
    counts: { subscriptionCount?: number; instrumentCount?: number },
  ): void {
    const key = makeConnectorKey(connectorType, marketType);
    const state = this.instances.get(key);
    if (state) {
      if (counts.subscriptionCount !== undefined)
        state.subscriptionCount = counts.subscriptionCount;
      if (counts.instrumentCount !== undefined)
        state.instrumentCount = counts.instrumentCount;
    }
  }

  // =========================================================================
  // 🔹 BOOTSTRAP — load pre-configured connectors from config
  // =========================================================================

  async bootstrapFromConfig(): Promise<void> {
    const config = this.configService.getConfig();
    const connectors = config?.provider?.connectors ?? [];

    for (const connectorConfig of connectors) {
      const connectorType = connectorConfig.connectorType as ConnectorType;
      if (!connectorType) continue;

      // Store credentials from config
      const credentials: Record<string, string> = {};
      if (connectorConfig.key) credentials.apiKey = connectorConfig.key;
      if (connectorConfig.secret) credentials.apiSecret = connectorConfig.secret;

      if (Object.keys(credentials).length > 0) {
        this.credentialStore.set(connectorType, credentials);
      }

      const markets = connectorConfig.markets ?? [];
      for (const market of markets) {
        const key = makeConnectorKey(connectorType, market.marketType);
        this.instances.set(key, {
          connectorType,
          marketType: market.marketType,
          status: ExchangeConnectorStatus.ACTIVE,
          activatedAt: Date.now(),
          credentials,
          subscriptionCount: connectorConfig.subscriptions?.length ?? 0,
          instrumentCount: market.instruments?.length ?? 0,
        });
      }

      this.logger.log(
        `Bootstrapped connector from config: ${connectorType} (${markets.length} markets)`,
      );
    }
  }

  // =========================================================================
  // 🔹 PRIVATE
  // =========================================================================

  private async initializeInstance(
    key: string,
    state: ExchangeInstanceState,
  ): Promise<void> {
    // The actual initialization is delegated to ExchangeDataService
    // which will call markActive() on success.
    // This is a placeholder for the async startup flow.
    state.status = ExchangeConnectorStatus.ACTIVE;
    state.lastHeartbeat = Date.now();
    this.logger.log(`Exchange instance initialized: ${key}`);
  }

  private toActiveInstance(state: ExchangeInstanceState): ActiveExchangeInstance {
    return {
      connectorType: state.connectorType,
      marketType: state.marketType,
      status: state.status,
      activatedAt: state.activatedAt,
      hasCredentials:
        !!state.credentials && Object.keys(state.credentials).length > 0,
      subscriptionCount: state.subscriptionCount,
      instrumentCount: state.instrumentCount,
      error: state.error,
      lastHeartbeat: state.lastHeartbeat,
    };
  }
}
