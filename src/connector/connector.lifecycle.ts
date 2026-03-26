// connector.lifecycle.ts
import {
  Injectable,
  Logger,
  forwardRef,
  Inject,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  ConnectorType,
  MarketType,
  SubscriptionType,
  TimeFrame,
  Instrument,
  ALL_CANDLE_INTERVALS,
} from '@barfinex/types';
import { ConfigService } from '@barfinex/config';

import { ConnectorRegistry } from './connector.registry';
import { ConnectorBuilder } from './connector.builder';
import { ConnectorSubscriptionService } from './connector.subscription.service';
import { DetectorService } from '../detector/detector.service';
import { KeyService } from '@barfinex/key';
import { AccountService } from '../account/account.service';
import { ProviderOwnershipService } from '../ownership/provider-ownership.service';
import { InstrumentShardService } from '../ownership/instrument-shard.service';
import { ownershipScopeKey } from '../ownership/ownership.types';
import { ProviderBootstrapService } from '../runtime/provider-bootstrap.service';
import { ExchangeManagerService } from './exchange-manager/exchange-manager.service';

/** Initial delay (ms) for ownership claim retry. */
const OWNERSHIP_CLAIM_RETRY_INITIAL_MS = 5_000;
/** Max delay (ms) for ownership claim retry (exponential backoff cap). */
const OWNERSHIP_CLAIM_RETRY_MAX_MS = 30_000;

/** Slot we failed to claim at startup; retry will re-run claim and subscribe on success. */
interface PendingOwnershipSlot {
  connectorType: ConnectorType;
  marketType: MarketType;
  instruments: Instrument[];
  intervals: TimeFrame[];
}

@Injectable()
export class ConnectorLifecycle implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConnectorLifecycle.name);

  /** Scopes skipped at startup due to failed claim; retried with exponential backoff until claimed or destroy. */
  private readonly pendingOwnershipSlots = new Map<
    string,
    PendingOwnershipSlot
  >();
  private ownershipRetryTimeout: ReturnType<typeof setTimeout> | null = null;
  private ownershipRetryAttempt = 0;

  constructor(
    private readonly keyService: KeyService,

    // private readonly accountService: AccountService,

    @Inject(forwardRef(() => DetectorService))
    private readonly detectorService: DetectorService,

    @Inject(forwardRef(() => AccountService))
    private readonly accountService: AccountService,

    private readonly builder: ConnectorBuilder,
    private readonly subscriptionService: ConnectorSubscriptionService,
    private readonly configService: ConfigService,
    private readonly ownershipService: ProviderOwnershipService,
    private readonly instrumentShardService: InstrumentShardService,
    private readonly bootstrap: ProviderBootstrapService,
    private readonly exchangeManager: ExchangeManagerService,
  ) {}

  private addPendingOwnershipSlot(
    connectorType: ConnectorType,
    marketType: MarketType,
    instruments: Instrument[],
    intervals: TimeFrame[],
  ): void {
    const key = ownershipScopeKey({ connectorType, marketType });
    if (this.pendingOwnershipSlots.has(key)) return;
    this.pendingOwnershipSlots.set(key, {
      connectorType,
      marketType,
      instruments,
      intervals,
    });
    this.logger.debug(
      `[ConnectorLifecycle] added pending ownership slot scope=${key} (will retry periodically)`,
    );
  }

  private scheduleOwnershipClaimRetry(): void {
    if (this.destroyed || this.pendingOwnershipSlots.size === 0) return;
    if (this.ownershipRetryTimeout != null) return;

    const delayMs = Math.min(
      OWNERSHIP_CLAIM_RETRY_INITIAL_MS *
        Math.pow(2, Math.min(this.ownershipRetryAttempt, 8)),
      OWNERSHIP_CLAIM_RETRY_MAX_MS,
    );
    this.ownershipRetryAttempt += 1;
    this.logger.debug(
      `[ConnectorLifecycle] scheduling ownership claim retry in ${delayMs}ms (attempt=${this.ownershipRetryAttempt})`,
    );
    this.ownershipRetryTimeout = setTimeout(() => {
      this.ownershipRetryTimeout = null;
      this.runOwnershipClaimRetry()
        .catch((e) =>
          this.logger.warn(
            `[ConnectorLifecycle] ownership claim retry failed: ${
              (e as Error)?.message
            }`,
          ),
        )
        .finally(() => {
          if (this.pendingOwnershipSlots.size > 0 && !this.destroyed) {
            this.scheduleOwnershipClaimRetry();
          }
        });
    }, delayMs);
  }

  private async runOwnershipClaimRetry(): Promise<void> {
    if (this.destroyed || this.pendingOwnershipSlots.size === 0) return;

    for (const [key, slot] of Array.from(
      this.pendingOwnershipSlots.entries(),
    )) {
      if (this.destroyed) break;
      const { connectorType, marketType, instruments, intervals } = slot;
      let claimed = false;
      let symbolsToSubscribe: Instrument[] = instruments;

      if (this.instrumentShardService.isEnabled()) {
        const localShardIds = this.instrumentShardService.getLocalShardIds();
        const claimedShardIds: number[] = [];
        for (const shardId of localShardIds) {
          const scope = { connectorType, marketType, shardId };
          const claimResult = await this.ownershipService.claim(scope);
          if (claimResult.success) claimedShardIds.push(shardId);
        }
        claimed = claimedShardIds.length > 0;
        symbolsToSubscribe = instruments.filter((s) =>
          claimedShardIds.includes(this.instrumentShardService.getShardId(s.symbol)),
        );
      } else {
        const scope = { connectorType, marketType };
        const claimResult = await this.ownershipService.claim(scope);
        claimed = claimResult.success;
      }

      if (claimed && symbolsToSubscribe.length > 0) {
        const balanceStats = this.accountService.getBalanceStats(
          connectorType,
          marketType,
        );
        await this.subscriptionService.updateSubscribeCollection(
          connectorType,
          marketType,
          symbolsToSubscribe,
          intervals,
          balanceStats,
        );
        this.pendingOwnershipSlots.delete(key);
        this.logger.log(
          `[ConnectorLifecycle] ownership claim retry succeeded scope=${key}, subscribed`,
        );
      }
    }
  }

  // =========================================================================
  // 🔹 MODULE INIT
  // =========================================================================

  private initialized = false;
  private destroyed = false;
  private destroyInFlight: Promise<void> | null = null;

  async onModuleInit(): Promise<void> {
    if (this.initialized) {
      this.logger.warn('ConnectorLifecycle already initialized — skip');
      return;
    }

    this.logger.log('ModuleInit start');

    try {
      // =========================================================================
      // 1) ИНИЦИАЛИЗАЦИЯ КЛЮЧА
      // =========================================================================
      this.keyService.initializeKey();
      ConnectorRegistry.key = this.keyService.key;
      this.logger.debug(`Initialized key: ${ConnectorRegistry.key}`);

      // Bootstrap ExchangeManager from config (register pre-configured connectors)
      await this.exchangeManager.bootstrapFromConfig();

      // =========================================================================
      // 2) ЗАГРУЗКА АККАУНТОВ (КРИТИЧЕСКИ ВАЖНО)
      // =========================================================================
      this.logger.log('Loading accounts...');
      await this.accountService.getAll(); // ⬅️ ЕДИНСТВЕННОЕ МЕСТО
      this.logger.log('Accounts loaded');

      // =========================================================================
      // 3) ПОСТРОЕНИЕ CONNECTORS (ИЗ АККАУНТОВ)
      // =========================================================================
      const connectors = await this.builder.getConnectorsList();
      this.logger.debug(`Initial connectors count: ${connectors.length}`);

      ConnectorRegistry.connectors = {};

      connectors.forEach((connector) => {
        for (const market of connector.markets ?? []) {
          ConnectorRegistry.setConnector({
            connectorType: connector.connectorType,
            marketType: market.marketType,
            connector,
          });
        }

        this.logger.log(
          `Registered connector: ${connector.connectorType}, markets=${
            connector.markets?.length ?? 0
          }`,
        );
      });

      // =========================================================================
      // 4) ИНТЕРВАЛЫ (из конфига candleSync.intervals или все по умолчанию)
      // =========================================================================
      const fromConfig =
        this.configService.getConfig()?.provider?.candleSync?.intervals;
      const validValues = new Set<string>(ALL_CANDLE_INTERVALS as string[]);
      const intervals: TimeFrame[] =
        Array.isArray(fromConfig) && fromConfig.length > 0
          ? ((fromConfig as string[]).filter((v) => {
              if (validValues.has(v)) return true;
              this.logger.warn(
                `Ignoring unsupported candle interval from config: "${v}"`,
              );
              return false;
            }) as TimeFrame[])
          : [...ALL_CANDLE_INTERVALS];
      this.logger.debug(`Intervals: ${intervals.join(', ')}`);

      // =========================================================================
      // 5) ЗАГРУЗКА ДЕТЕКТОРОВ
      // =========================================================================
      ConnectorRegistry.setDetectors(
        await this.detectorService.getAllDetectorsByProviderKey(
          ConnectorRegistry.key,
        ),
      );

      this.logger.debug(
        `Detectors count: ${ConnectorRegistry.detectors?.length ?? 0}`,
      );

      // PHASE 1 complete: fast path done
      this.bootstrap.markConnectorsRegistered();
      this.bootstrap.markDetectorsLoaded();

      // PHASE 2 (slow): ownership claim + subscription setup. Dev = background; Prod = await.
      const isDev =
        String(process.env.NODE_ENV || '').toLowerCase() !== 'production';
      if (isDev) {
        this.logger.log(
          'Deferring subscription/ownership to background (dev) so HTTP server can bind.',
        );
        setImmediate(() =>
          this.runSubscriptionAndOwnershipPhase(intervals).catch((e) =>
            this.logger.warn(
              `ConnectorLifecycle deferred init failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            ),
          ),
        );
        return;
      }

      await this.runSubscriptionAndOwnershipPhase(intervals);
    } catch (error) {
      this.logger.error('ConnectorLifecycle initialization failed', error);
      throw error;
    } finally {
      // 🔥 КРИТИЧЕСКИ ВАЖНО — ТОЛЬКО ЗДЕСЬ
      this.initialized = true;
    }
  }

  /**
   * Runs ownership claim and subscription updates for all connectors/markets.
   * In dev this is run in background after HTTP server binds; in prod it runs during onModuleInit.
   */
  private async runSubscriptionAndOwnershipPhase(
    intervals: TimeFrame[],
  ): Promise<void> {
    // =========================================================================
    // 6) ПОДПИСКИ (accounts + detectors)
    // =========================================================================
    const allConnectors = Object.values(ConnectorRegistry.connectors);

    // 🔥 ДОБАВЛЕНО: дедуп по connectorType (НЕ УДАЛЯЕТ существующий код)
    const uniqueConnectorsMap = new Map<
      string,
      (typeof allConnectors)[number]
    >();
    for (const connector of allConnectors) {
      if (!uniqueConnectorsMap.has(connector.connectorType)) {
        uniqueConnectorsMap.set(connector.connectorType, connector);
      }
    }
    const uniqueConnectors = Array.from(uniqueConnectorsMap.values());

    for (const connector of uniqueConnectors) {
      this.logger.log(
        `Connector ${connector.connectorType}, markets=${
          connector.markets?.length ?? 0
        }`,
      );

      for (const market of connector.markets) {
        const instruments: Instrument[] = [];

        this.logger.log(
          `Market: ${market.marketType}, symbols=${
            market.instruments?.length ?? 0
          }`,
        );

        // -----------------------------------------------------------------
        // 6.1) SYMBOLS ИЗ АККАУНТОВ (ГЛАВНЫЙ ИСТОЧНИК)
        // -----------------------------------------------------------------
        market.instruments?.forEach((symbol) => {
          if (!instruments.find((q) => q.symbol === symbol.symbol)) {
            instruments.push(symbol);
          }
        });

        // -----------------------------------------------------------------
        // 6.2) SYMBOLS ИЗ ДЕТЕКТОРОВ
        // -----------------------------------------------------------------
        const detectorsCollection = ConnectorRegistry.detectors.filter(
          (detector) =>
            detector.providers?.some((provider) =>
              provider.connectors?.some(
                (c) =>
                  c.connectorType === connector.connectorType &&
                  c.markets?.some((m) => m.marketType === market.marketType),
              ),
            ),
        );

        this.logger.debug(
          `Detectors for ${market.marketType}: ${detectorsCollection.length}`,
        );

        detectorsCollection.forEach((detector) => {
          detector.instruments.forEach((symbol) => {
            if (!instruments.find((q) => q.symbol === symbol.symbol)) {
              instruments.push(symbol);
              this.logger.debug(
                `Added detector symbol: ${symbol.symbol} (detector ${detector.key})`,
              );
            }
          });
        });

        // -----------------------------------------------------------------
        // 6.3) SYMBOLS ИЗ КОНФИГУРАЦИИ ПОДПИСОК MARKET DATA
        // -----------------------------------------------------------------
        const configuredStreamSymbols = this.collectConfiguredMarketDataSymbols(
          connector.connectorType,
          market.marketType,
        );
        configuredStreamSymbols.forEach((symbolName) => {
          if (!instruments.find((q) => q.symbol === symbolName)) {
            instruments.push({ symbol: symbolName });
            this.logger.debug(
              `Added configured stream symbol: ${symbolName} (connector ${connector.connectorType})`,
            );
          }
        });

        // -----------------------------------------------------------------
        // 6.4) DEFAULT SYMBOL (BTCUSDT)
        // -----------------------------------------------------------------
        const defaultSymbol = 'BTCUSDT';
        if (!instruments.find((q) => q.symbol === defaultSymbol)) {
          instruments.push({ symbol: defaultSymbol });
          this.logger.warn(
            `Added default symbol: ${defaultSymbol} (connector ${connector.connectorType})`,
          );
        }

        // -----------------------------------------------------------------
        // 6.5) CLAIM OWNERSHIP THEN ОБНОВЛЕНИЕ ПОДПИСОК
        // -----------------------------------------------------------------
        if (instruments.length > 0) {
          const connectorType = connector.connectorType;
          const marketType = market.marketType;
          let claimed = false;
          let symbolsToSubscribe: Instrument[] = instruments;

          if (this.instrumentShardService.isEnabled()) {
            const localShardIds = this.instrumentShardService.getLocalShardIds();
            const claimedShardIds: number[] = [];
            for (const shardId of localShardIds) {
              const scope = { connectorType, marketType, shardId };
              const claimResult = await this.ownershipService.claim(scope);
              if (claimResult.success) {
                claimedShardIds.push(shardId);
              } else {
                this.logger.debug(
                  `Shard scope ${ownershipScopeKey(scope)} not claimed: ${
                    claimResult.reason ?? 'unknown'
                  }`,
                );
              }
            }
            claimed = claimedShardIds.length > 0;
            symbolsToSubscribe = instruments.filter((s) =>
              claimedShardIds.includes(
                this.instrumentShardService.getShardId(s.symbol),
              ),
            );
            if (claimed && symbolsToSubscribe.length > 0) {
              this.logger.log(
                `Symbol sharding: connector=${connectorType} market=${marketType} claimedShards=[${claimedShardIds.join(
                  ',',
                )}] symbols=${symbolsToSubscribe.length}`,
              );
            }
            if (!claimed) {
              this.addPendingOwnershipSlot(
                connectorType,
                marketType,
                instruments,
                intervals,
              );
            }
          } else {
            const scope = { connectorType, marketType };
            const claimResult = await this.ownershipService.claim(scope);
            claimed = claimResult.success;
            if (!claimed) {
              this.logger.warn(
                `Skipping subscription: no ownership for scope=${ownershipScopeKey(
                  scope,
                )} reason=${claimResult.reason ?? 'unknown'}`,
              );
              this.addPendingOwnershipSlot(
                connectorType,
                marketType,
                instruments,
                intervals,
              );
            }
          }

          if (claimed && symbolsToSubscribe.length > 0) {
            const balanceStats = this.accountService.getBalanceStats(
              connectorType,
              marketType,
            );
            this.logger.log(
              `Updating subscription: connector=${connectorType}, market=${marketType}, symbols=${symbolsToSubscribe
                .map((s) => s.symbol)
                .join(', ')}`,
            );

            await this.subscriptionService.updateSubscribeCollection(
              connectorType,
              marketType,
              symbolsToSubscribe,
              intervals,
              balanceStats,
            );
          } else if (!claimed) {
            continue;
          }
        }
      }
    }

    // Listen for ownership loss -> unsubscribe and drain
    this.ownershipService.onStateChange((scope, state) => {
      if (state === 'DRAINING') {
        this.logger.log(
          `ProviderOwnership draining scope=${scope.connectorType}:${scope.marketType} -> unsubscribe connector`,
        );
        this.subscriptionService
          .unsubscribeCollection(scope.connectorType as ConnectorType)
          .catch((e) =>
            this.logger.warn(
              `Unsubscribe on drain failed: ${(e as Error)?.message}`,
            ),
          );
      }
    });

    // Exponential backoff retry for scopes skipped at startup (e.g. scope owned by another instance; self-healing)
    this.scheduleOwnershipClaimRetry();

    this.bootstrap.markOwnershipClaimed();
    this.bootstrap.markSubscriptionsReady();
    this.bootstrap.markRuntimeReady();

    this.logger.log('ModuleInit complete');
  }

  // =========================================================================
  // 🔹 MODULE DESTROY
  // =========================================================================

  async onModuleDestroy(): Promise<void> {
    if (this.destroyInFlight) {
      await this.destroyInFlight;
      return;
    }

    if (this.destroyed) {
      this.logger.warn(
        '[ConnectorLifecycle] ModuleDestroy already executed; skip duplicate call',
      );
      return;
    }
    this.destroyInFlight = (async () => {
      this.destroyed = true;
      if (this.ownershipRetryTimeout != null) {
        clearTimeout(this.ownershipRetryTimeout);
        this.ownershipRetryTimeout = null;
      }
      this.pendingOwnershipSlots.clear();
      this.logger.log('[ConnectorLifecycle] ModuleDestroy start');

      const allConnectors = Object.values(ConnectorRegistry.connectors);
      const intervals: TimeFrame[] = [TimeFrame.min1];

      this.logger.debug(
        `[ConnectorLifecycle] destroy intervals=${intervals.join(',')}`,
      );

      ConnectorRegistry.setDetectors(
        await this.detectorService.getAllDetectorsByProviderKey(
          ConnectorRegistry.key,
        ),
      );

      this.logger.debug(
        `[ConnectorLifecycle] destroy detectors=${JSON.stringify(
          ConnectorRegistry.detectors.map((d) => ({
            key: d.key,
            symbols: d.instruments?.length,
          })),
        )}`,
      );

      // ✅ GUARDED unsubscribe: один раз на connectorType; release ownership first
      const unsubscribed = new Set<ConnectorType>();

      allConnectors.forEach((connector) => {
        this.logger.debug(
          `[ConnectorLifecycle] destroy connector=${connector.connectorType} markets=${connector.markets?.length}`,
        );

        connector.markets.forEach((market) => {
          this.logger.debug(
            `[ConnectorLifecycle] destroy marketType=${market.marketType} symbols=${market.instruments?.length}`,
          );

          if (market.instruments && market.instruments.length > 0) {
            this.logger.debug(
              `[ConnectorLifecycle] destroy unsubscribe connector=${connector.connectorType} source=market-symbols`,
            );

            if (!unsubscribed.has(connector.connectorType)) {
              const ct = connector.connectorType;
              const mt = market.marketType;
              const tracked = this.ownershipService
                .getTrackedScopes()
                .filter((s) => s.connectorType === ct && s.marketType === mt);
              for (const scope of tracked) {
                this.ownershipService
                  .release(scope)
                  .then(() => {})
                  .catch((e) =>
                    this.logger.warn(
                      `[ConnectorLifecycle] release ownership failed: ${
                        (e as Error)?.message
                      }`,
                    ),
                  );
              }
              this.subscriptionService.unsubscribeCollection(
                connector.connectorType,
              );
              unsubscribed.add(connector.connectorType);
            }
          }

          ConnectorRegistry.detectors.forEach((detector) => {
            const { instruments } = detector;

            this.logger.debug(
              `[ConnectorLifecycle] destroy detector=${detector.key} symbols=${instruments?.length}`,
            );

            if (instruments.length > 0) {
              this.logger.debug(
                `[ConnectorLifecycle] destroy unsubscribe connector=${connector.connectorType} source=detector-symbols`,
              );

              if (!unsubscribed.has(connector.connectorType)) {
                this.subscriptionService.unsubscribeCollection(
                  connector.connectorType,
                );
                unsubscribed.add(connector.connectorType);
              }
            }
          });
        });
      });

      this.logger.log(
        `[ConnectorLifecycle] ModuleDestroy complete unsubscribed=${
          Array.from(unsubscribed).join(',') || 'none'
        }`,
      );
    })();

    await this.destroyInFlight;
  }

  private collectConfiguredMarketDataSymbols(
    connectorType: ConnectorType,
    marketType: MarketType,
  ): string[] {
    const runtimeConfig = this.configService.getConfig() as {
      provider?: {
        connectors?: Array<{
          connectorType?: ConnectorType | string;
          subscriptions?: Array<{
            type?: SubscriptionType | string;
            active?: boolean;
            symbols?: string[];
          }>;
        }>;
      };
    };
    const configuredConnector = (runtimeConfig.provider?.connectors ?? []).find(
      (connector) =>
        String(connector?.connectorType || '').toLowerCase() ===
        String(connectorType).toLowerCase(),
    );
    const streams = new Set<SubscriptionType | string>([
      SubscriptionType.PROVIDER_MARKETDATA_TRADE,
      SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK,
      SubscriptionType.PROVIDER_MARKETDATA_CANDLE,
      SubscriptionType.PROVIDER_INSTRUMENT_PRICES,
    ]);
    const collected = new Set<string>();
    for (const subscription of configuredConnector?.subscriptions ?? []) {
      if (!subscription?.active) continue;
      if (!streams.has(subscription.type || '')) continue;
      for (const rawSymbol of subscription.symbols ?? []) {
        const normalized = String(rawSymbol || '')
          .trim()
          .toUpperCase();
        if (!normalized) continue;
        collected.add(normalized);
      }
    }
    if (collected.size > 0) {
      this.logger.debug(
        `[ConnectorLifecycle] configured marketdata symbols market=${marketType} count=${collected.size}`,
      );
    }
    return Array.from(collected);
  }
}
