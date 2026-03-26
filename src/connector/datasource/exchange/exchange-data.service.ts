// exchange-data.service.ts
import {
  forwardRef,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';

import {
  DataSource,
  MarketType,
  TimeFrame,
  Instrument,
  SubscriptionType,
  Candle,
  Trade,
  OrderBook,
  AccountEvent,
  InstrumentPrice,
  Subscription,
  SubscriptionValue,
  ConnectorType,
  LiquidityMapScope,
} from '@barfinex/types';

import { ConfigService } from '@barfinex/config';
import { ConnectorService } from '../../connector.service';
import { CandleService } from '../../../candle/candle.service';
import { InstrumentRepository } from '../../../instrument/instrument.repository';
import { TradeRepository } from '../../../questdb/repositories/trade.repository';
import { RawTradeRepository } from '../../../questdb/repositories/raw-trade.repository';
import { OrderBookRepository } from '../../../questdb/repositories/orderbook.repository';
import { OrderbookTopRepository } from '../../../questdb/repositories/orderbook-top.repository';
import { OrderbookSnapshotsRepository } from '../../../questdb/repositories/orderbook-snapshots.repository';
import { OrderbookFeaturesRepository } from '../../../questdb/repositories/orderbook-features.repository';
import { EventSinkRepository } from '../../../questdb/event-sink/event-sink.repository';
import { HorizontalVolumeProfileRepository } from '../../../questdb/repositories/horizontal-volume-profile.repository';
import { LiquidityMapRepository } from '../../../questdb/repositories/liquidity-map.repository';

import {
  BinanceClientService,
  BinanceWsManager,
  BinanceAccountApi,
  BinanceMarketApi,
  BinanceOrderApi,
  createCandleAdapter,
  createTradeAdapter,
  createOrderBookAdapter,
  createAccountAdapter,
  createInstrumentsAdapter,
  createInstrumentPricesAdapter,
} from '@barfinex/exchange-binance';
import { ExchangeRedisService } from './core/exchange-redis.service';
import { ExchangeSubscriptionService } from './ws/exchange-subscription.service';
import {
  MarketDataSnapshot,
  MarketQualityEngine,
  MarketValidationResult,
  MarketTrend,
} from '@barfinex/market-quality';
import {
  HorizontalVolumeProfileService,
  HorizontalVolumeProfileTickResult,
} from './horizontal-volume-profile.service';
import { LiquidityMapService } from './liquidity-map.service';
import { ProviderOwnershipService } from '../../../ownership/provider-ownership.service';
import { InstrumentShardService } from '../../../ownership/instrument-shard.service';
import { ProviderMetricsService } from '../../../runtime/provider-metrics.service';
import { TradingDiagnosticsService } from '@barfinex/diagnostics';

const PROVIDER_DIAGNOSTICS_THROTTLE_MS = Math.max(
  2_000,
  Number(process.env.PROVIDER_DIAGNOSTICS_THROTTLE_MS ?? 5_000),
);

@Injectable()
// export class ExchangeDataService implements DataSource {
export class ExchangeDataService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExchangeDataService.name);
  private readonly accountPayloadWarnSizeBytes = 100_000;
  private readonly ingestStatsLogIntervalMs = Math.max(
    1_000,
    Number(process.env.PROVIDER_INGEST_STATS_LOG_INTERVAL_MS || 5_000),
  );
  private readonly streamCardinalityWarnThreshold = 1_000;

  private readonly connectorType: ConnectorType;
  private readonly isEmitToRedisEnabled = true;
  private readonly marketQualityEngine = new MarketQualityEngine();
  private readonly marketQualitySnapshots = new Map<
    string,
    MarketDataSnapshot
  >();
  private readonly marketQualityReports = new Map<
    string,
    MarketValidationResult
  >();
  private readonly marketQualitySummaryIntervalMs = Math.max(
    10_000,
    Number(process.env.PROVIDER_MARKET_QUALITY_SUMMARY_INTERVAL_MS || 60_000),
  );
  private readonly runtimeTradesLimitPerSymbol = Math.max(
    50,
    Number(process.env.PROVIDER_RUNTIME_TRADES_LIMIT_PER_SYMBOL || 500),
  );
  private marketQualitySummaryInterval: NodeJS.Timeout | null = null;
  private readonly marketQualityLastWarnTs = new Map<string, number>();
  private readonly marketQualityLastEvalTs = new Map<string, number>();
  private static readonly QUALITY_EVAL_THROTTLE_MS = 5_000;
  private readonly runtimeTradesBySymbol = new Map<
    string,
    Array<{
      id: string;
      time: number;
      price: number;
      size: number;
      side: 'buy' | 'sell';
      tradeId?: string;
      isBuyerMaker?: boolean;
    }>
  >();
  private lastDiagnosticLogAt = new Map<string, number>();

  private lastSymbolsHash: string | null = null;
  private lastAccountEventTime = 0;
  private readonly accountStreamDisabledMarkets = new Set<MarketType>();
  private readonly spotAccountStreamEnabled =
    process.env.EXCHANGE_SPOT_ACCOUNT_STREAM_ENABLED === 'true';
  private ingestStatsWindowStartedAt = Date.now();
  private tradesIngestedInWindow = 0;
  private orderbookEventsInWindow = 0;
  private tradeRowsWrittenInWindow = 0;
  private orderbookRowsWrittenInWindow = 0;
  private rawTradesEnqueuedInWindow = 0;
  private orderbookTopRowsInWindow = 0;
  private lastOrderbookSnapshotAtBySymbol = new Map<string, number>();
  /** Per-symbol last depth and spread for replenishment/depletion and spread-widening signals. */
  private lastOrderbookStateBySymbol = new Map<
    string,
    { totalDepth: number; spreadBps: number }
  >();
  private readonly orderbookSnapshotIntervalMs = Math.max(
    1000,
    Number(process.env.PROVIDER_ORDERBOOK_SNAPSHOT_INTERVAL_MS ?? 5_000),
  );

  private subscription: {
    options?: { instruments: Instrument[]; intervals?: TimeFrame[] };
    unsubscribeAccount?: () => void;
    unsubscribeOrderBook?: () => void;
    unsubscribeTrade?: () => void;
    unsubscribeInstrumentPrices?: () => void;
    unsubscribeInstruments?: () => void;
    unsubscribeCandles?: Array<() => void>;
  } = {};

  /** Per-market unsubscribe functions so updateSubscribeCollection can tear down only one market. */
  private readonly marketSubscriptions = new Map<
    MarketType,
    {
      unsubscribeAccount?: () => void;
      unsubscribeOrderBook?: () => void;
      unsubscribeTrade?: () => void;
      unsubscribeInstrumentPrices?: () => void;
      unsubscribeInstruments?: () => void;
      unsubscribeCandles?: Array<() => void>;
    }
  >();

  constructor(
    private readonly configService: ConfigService,
    private readonly instrumentRepository: InstrumentRepository,
    private readonly tradeRepository: TradeRepository,
    private readonly rawTradeRepository: RawTradeRepository,
    private readonly orderBookRepository: OrderBookRepository,
    private readonly orderbookTopRepository: OrderbookTopRepository,
    private readonly orderbookSnapshotsRepository: OrderbookSnapshotsRepository,
    private readonly orderbookFeaturesRepository: OrderbookFeaturesRepository,
    private readonly eventSinkRepository: EventSinkRepository,
    private readonly horizontalVolumeProfileRepository: HorizontalVolumeProfileRepository,
    private readonly liquidityMapRepository: LiquidityMapRepository,

    @Inject(forwardRef(() => CandleService))
    private readonly candleService: CandleService,

    private readonly client: BinanceClientService,
    private readonly redis: ExchangeRedisService,
    private readonly subscriptions: ExchangeSubscriptionService,
    private readonly ws: BinanceWsManager,

    private readonly accountApi: BinanceAccountApi,
    private readonly marketApi: BinanceMarketApi,
    private readonly orderApi: BinanceOrderApi,
    private readonly horizontalVolumeProfileService: HorizontalVolumeProfileService,
    private readonly liquidityMapService: LiquidityMapService,
    private readonly ownershipService: ProviderOwnershipService,
    private readonly instrumentShardService: InstrumentShardService,
    private readonly providerMetrics: ProviderMetricsService,
    @Optional()
    @Inject(TradingDiagnosticsService)
    private readonly diagnostics: TradingDiagnosticsService | null,
  ) {
    // Resolve connectorType from config (first configured connector)
    const connectors = this.configService.getConfig()?.provider?.connectors ?? [];
    const first = connectors[0];
    if (!first?.connectorType) { throw new Error('No connector configured in provider config'); }
    this.connectorType = first.connectorType as ConnectorType;
  }

  // =========================================================================
  // READY
  // =========================================================================
  onModuleInit(): void {
    this.marketQualitySummaryInterval = setInterval(() => {
      this.logMarketQualitySummary();
    }, this.marketQualitySummaryIntervalMs);
    this.marketQualitySummaryInterval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.marketQualitySummaryInterval) {
      clearInterval(this.marketQualitySummaryInterval);
      this.marketQualitySummaryInterval = null;
    }
    this.marketQualitySnapshots.clear();
    this.marketQualityReports.clear();
    this.marketQualityLastWarnTs.clear();
    this.marketQualityLastEvalTs.clear();
    this.runtimeTradesBySymbol.clear();
    this.lastDiagnosticLogAt.clear();
  }

  /**
   * Remove all cached state for a symbol that is no longer actively subscribed.
   */
  clearSymbolState(symbol: string): void {
    const key = String(symbol || '')
      .trim()
      .toUpperCase();
    if (!key) return;
    this.marketQualitySnapshots.delete(key);
    this.marketQualityReports.delete(key);
    this.marketQualityLastWarnTs.delete(key);
    this.marketQualityLastEvalTs.delete(key);
    this.runtimeTradesBySymbol.delete(key);
    this.lastDiagnosticLogAt.delete(`${key}:provider_trades`);
    this.lastDiagnosticLogAt.delete(`${key}:provider_orderbook`);
    this.lastDiagnosticLogAt.delete(`${key}:provider_candles`);
    this.lastOrderbookSnapshotAtBySymbol.delete(key);
    this.lastOrderbookStateBySymbol.delete(key);
    for (const mt of [MarketType.spot, MarketType.futures]) {
      this.horizontalVolumeProfileService.clearSymbolState(
        key,
        this.connectorType,
        mt,
      );
      this.liquidityMapService.clearSymbolState(key, this.connectorType, mt);
    }
  }

  async ensureReady(): Promise<void> {
    await this.client.ensureReady();
  }

  getMarketQualityReport(
    symbol: string,
    snapshotOverride?: MarketDataSnapshot,
  ): MarketValidationResult | null {
    const normalized = String(symbol || '')
      .trim()
      .toUpperCase();
    if (!normalized) return null;
    const liveSnapshot = this.marketQualitySnapshots.get(normalized);
    const snapshotForEvaluation = snapshotOverride ?? liveSnapshot;
    if (snapshotForEvaluation) {
      const report = this.marketQualityEngine.evaluateMarketDataQuality(
        normalized,
        snapshotForEvaluation,
      );
      this.marketQualityReports.set(normalized, report);
      return report;
    }
    return (
      this.marketQualityReports.get(normalized) ??
      this.marketQualityEngine.getLatest(normalized)
    );
  }

  getMarketQualitySnapshot(symbol: string): MarketDataSnapshot | null {
    const normalized = String(symbol || '')
      .trim()
      .toUpperCase();
    if (!normalized) return null;
    const snapshot = this.marketQualitySnapshots.get(normalized) ?? null;
    if (snapshot) this.normalizeCrossedOrderbook(snapshot);
    return snapshot;
  }

  /** Symbols that currently have a market quality snapshot (for data-quality overview/symbol list). */
  getInstrumentsWithMarketQualitySnapshots(): string[] {
    return Array.from(this.marketQualitySnapshots.keys()).sort();
  }

  getRecentRuntimeTrades(
    symbol: string,
    limit = 50,
  ): Array<{
    id: string;
    time: number;
    price: number;
    size: number;
    side: 'buy' | 'sell';
    tradeId?: string;
    isBuyerMaker?: boolean;
  }> {
    const normalized = String(symbol || '')
      .trim()
      .toUpperCase();
    if (!normalized) return [];
    const rows = this.runtimeTradesBySymbol.get(normalized) ?? [];
    const boundedLimit = Math.max(
      1,
      Math.min(500, Math.floor(Number(limit) || 50)),
    );
    return rows.slice(Math.max(0, rows.length - boundedLimit)).reverse();
  }

  private pushRuntimeTrade(
    symbol: string,
    trade: {
      id: string;
      time: number;
      price: number;
      size: number;
      side: 'buy' | 'sell';
      tradeId?: string;
      isBuyerMaker?: boolean;
    },
  ): void {
    const normalized = String(symbol || '')
      .trim()
      .toUpperCase();
    if (!normalized) return;
    const rows = this.runtimeTradesBySymbol.get(normalized) ?? [];
    rows.push(trade);
    const overflow = rows.length - this.runtimeTradesLimitPerSymbol;
    if (overflow > 0) {
      rows.splice(0, overflow);
    }
    this.runtimeTradesBySymbol.set(normalized, rows);
  }

  getLiquidityMapSnapshot(
    symbol: string,
    scope: LiquidityMapScope,
    marketType: MarketType = MarketType.futures,
  ) {
    const normalized = String(symbol || '')
      .trim()
      .toUpperCase();
    if (!normalized) return null;
    return this.liquidityMapService.getSnapshot({
      symbol: normalized,
      connectorType: this.connectorType,
      marketType,
      scope,
    });
  }

  private get api() {
    return this.client.api;
  }

  // =========================================================================
  // ACCOUNT EVENT (dedup + dynamic symbols)
  // =========================================================================
  private async handleAccountEvent(
    marketType: MarketType,
    event: AccountEvent,
  ): Promise<void> {
    if (event.eventTime === this.lastAccountEventTime) return;
    this.lastAccountEventTime = event.eventTime;

    await this.emit(SubscriptionType.PROVIDER_ACCOUNT_EVENT, marketType, event);
    this.eventSinkRepository.emit('account.update', {
      category: 'connector',
      action: 'update',
      connectorType: this.connectorType,
      marketType,
      timestamp: Number(event.eventTime) || Date.now(),
      data: event,
    });

    const symbolName = event.options?.symbol;
    if (!symbolName || typeof symbolName !== 'string') return;

    if (!this.subscription.options) {
      this.subscription.options = { instruments: [], intervals: [] };
    }

    const exists = this.subscription.options.instruments.some(
      (s) => s?.symbol?.toUpperCase() === symbolName.toUpperCase(),
    );

    if (!exists) {
      // сохраняем как доменный Instrument
      this.subscription.options.instruments.push({
        symbol: symbolName,
        connectorType: this.connectorType,
        marketType,
      });

      await this.updateSubscribeCollection(
        marketType,
        this.subscription.options.instruments,
        this.subscription.options.intervals,
      );
    }
  }

  // =========================================================================
  // REST — delegation
  // =========================================================================
  getAssetsInfo(marketType: MarketType) {
    return this.accountApi.getAssetsInfo(marketType);
  }

  getAccountInfo(marketType: MarketType) {
    return this.accountApi.getAccountInfo(marketType);
  }

  changeLeverage(instrument: Instrument, leverage: number) {
    return this.accountApi.changeLeverage(instrument, leverage);
  }

  getInstrumentsInfo(connectorType: ConnectorType, marketType: MarketType) {
    return this.marketApi.getInstrumentsInfo(connectorType, marketType);
  }

  validateInstruments(
    marketType: MarketType,
    symbols: string[],
  ): { validInstruments: string[]; removedInstruments: string[] } {
    return this.client.validateExchangeInstruments(marketType, symbols);
  }

  validateSymbolObjects(
    marketType: MarketType,
    instruments: Instrument[],
  ): { validInstruments: Instrument[]; removedInstruments: string[] } {
    const names = instruments.map((s) => s?.symbol ?? '');
    const { validInstruments: validNames, removedInstruments } =
      this.client.validateExchangeInstruments(marketType, names);
    const validNameSet = new Set(validNames);
    const dedup = new Set<string>();
    const validInstruments = instruments.filter((s) => {
      const name = String(s?.symbol ?? '')
        .trim()
        .toUpperCase();
      if (!name || !validNameSet.has(name) || dedup.has(name)) return false;
      dedup.add(name);
      return true;
    });
    return { validInstruments, removedInstruments };
  }

  openOrder(order: any) {
    return this.orderApi.openOrder(order);
  }

  closeOrder(options: any) {
    return this.orderApi.closeOrder(options);
  }

  closeAllOrders(options: any) {
    return this.orderApi.closeAllOrders(options);
  }

  getOpenOrders(options: any) {
    return this.orderApi.getOpenOrders(options);
  }

  // =========================================================================
  // SUBSCRIBE / UNSUBSCRIBE
  // =========================================================================
  async unsubscribe(): Promise<void> {
    // аккуратно вызываем только функции отписок
    if (this.subscription.unsubscribeAccount)
      this.subscription.unsubscribeAccount();
    if (this.subscription.unsubscribeOrderBook)
      this.subscription.unsubscribeOrderBook();
    if (this.subscription.unsubscribeTrade)
      this.subscription.unsubscribeTrade();
    if (this.subscription.unsubscribeInstrumentPrices)
      this.subscription.unsubscribeInstrumentPrices();
    if (this.subscription.unsubscribeInstruments)
      this.subscription.unsubscribeInstruments();
    if (this.subscription.unsubscribeCandles?.length) {
      for (const unsubscribeCandle of this.subscription.unsubscribeCandles) {
        unsubscribeCandle();
      }
      this.subscription.unsubscribeCandles = [];
    }
    // Also clean per-market tracking
    for (const [mt, sub] of this.marketSubscriptions) {
      this.tearDownMarketSub(sub);
    }
    this.marketSubscriptions.clear();
  }

  private unsubscribeMarket(marketType: MarketType): void {
    const sub = this.marketSubscriptions.get(marketType);
    if (sub) {
      this.tearDownMarketSub(sub);
      this.marketSubscriptions.delete(marketType);
    }
  }

  private tearDownMarketSub(
    sub: NonNullable<ReturnType<typeof this.marketSubscriptions.get>>,
  ): void {
    if (sub.unsubscribeAccount) sub.unsubscribeAccount();
    if (sub.unsubscribeOrderBook) sub.unsubscribeOrderBook();
    if (sub.unsubscribeTrade) sub.unsubscribeTrade();
    if (sub.unsubscribeInstrumentPrices) sub.unsubscribeInstrumentPrices();
    if (sub.unsubscribeInstruments) sub.unsubscribeInstruments();
    if (sub.unsubscribeCandles?.length) {
      for (const fn of sub.unsubscribeCandles) fn();
      sub.unsubscribeCandles = [];
    }
  }

  async subscribe(
    marketType: MarketType,
    instruments: Instrument[],
    intervals?: TimeFrame[],
  ): Promise<void> {
    const config = this.configService.getConfig();

    const connector = config.provider?.connectors?.find(
      (c: any) =>
        c.connectorType === this.connectorType &&
        c.markets?.some((m: any) => m.marketType === marketType),
    );

    if (!connector) {
      throw new InternalServerErrorException(
        `Connector ${this.connectorType}-${marketType} not found`,
      );
    }

    // фиксируем текущую коллекцию подписок (нужно для динамического расширения)
    this.subscription.options = { instruments, intervals };
    const marketSub: NonNullable<
      ReturnType<typeof this.marketSubscriptions.get>
    > = {};
    this.marketSubscriptions.set(marketType, marketSub);
    for (const symbol of instruments) {
      this.horizontalVolumeProfileService.ensureSymbol({
        symbol: symbol.symbol,
        connectorType: this.connectorType,
        marketType,
      });
    }
    const estimatedStreams = this.estimateActiveStreamCardinality(
      instruments.length,
      Math.max(1, intervals?.length ?? 0),
      connector.subscriptions ?? [],
    );
    if (estimatedStreams >= this.streamCardinalityWarnThreshold) {
      this.logger.warn(
        `[EXCHANGE WS] high stream cardinality estimate streams=${estimatedStreams} symbols=${
          instruments.length
        } intervals=${Math.max(
          1,
          intervals?.length ?? 0,
        )} market=${marketType} sharding_recommended=true`,
      );
    }

    for (const sub of connector.subscriptions ?? []) {
      if (!sub.active) continue;

      try {
        switch (sub.type) {
          case SubscriptionType.PROVIDER_ACCOUNT_EVENT:
            if (
              marketType === MarketType.spot &&
              !this.spotAccountStreamEnabled
            ) {
              if (!this.accountStreamDisabledMarkets.has(marketType)) {
                this.accountStreamDisabledMarkets.add(marketType);
                this.logger.log(
                  'Spot account stream is disabled (EXCHANGE_SPOT_ACCOUNT_STREAM_ENABLED!=true); market-data streams stay active.',
                );
              }
              break;
            }
            if (this.accountStreamDisabledMarkets.has(marketType)) {
              this.logger.debug(
                `Account stream disabled for [${marketType}] due to previous HTTP 410.`,
              );
              break;
            }
            try {
              const unsub = await this.ws.subscribeToAccount(
                { marketType },
                createAccountAdapter(
                  { connectorType: this.connectorType },
                  this.handleAccountEvent.bind(this) as any,
                )(marketType),
              );
              this.subscription.unsubscribeAccount = unsub;
              marketSub.unsubscribeAccount = unsub;
            } catch (accountErr: any) {
              const status = accountErr?.response?.status;
              if (status === 410) {
                this.accountStreamDisabledMarkets.add(marketType);
                this.logger.log(
                  `Account stream deprecated for [${marketType}] (HTTP 410). Disabling further attempts; candles/trades continue.`,
                );
              } else {
                this.logger.warn(
                  `Account stream unavailable [${marketType}] (HTTP ${
                    status ?? 'error'
                  }). Candles/trades will still work.`,
                );
              }
            }
            break;

          case SubscriptionType.PROVIDER_MARKETDATA_TRADE: {
            const unsub = await this.ws.subscribeToTrade(
              { marketType, instruments },
              createTradeAdapter(
                this.handlerForTrade.bind(this),
              )(marketType),
            );
            this.subscription.unsubscribeTrade = unsub;
            marketSub.unsubscribeTrade = unsub;
            break;
          }

          case SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK: {
            const unsub = await this.ws.subscribeToOrderBook(
              { marketType, instruments },
              createOrderBookAdapter(
                this.handlerForOrderBook.bind(this),
              )(marketType),
            );
            this.subscription.unsubscribeOrderBook = unsub;
            marketSub.unsubscribeOrderBook = unsub;
            break;
          }

          case SubscriptionType.PROVIDER_MARKETDATA_CANDLE: {
            this.subscription.unsubscribeCandles = [];
            marketSub.unsubscribeCandles = [];
            for (const interval of intervals ?? []) {
              const unsubscribeCandle = await this.ws.subscribeToCandles(
                { marketType, instruments, interval },
                createCandleAdapter({
                  marketType,
                  interval,
                  connectorType: this.connectorType,
                  handler: this.handlerForCandle.bind(this),
                  logger: this.logger,
                }),
              );
              this.subscription.unsubscribeCandles.push(unsubscribeCandle);
              marketSub.unsubscribeCandles.push(unsubscribeCandle);
            }
            break;
          }

          case SubscriptionType.PROVIDER_INSTRUMENTS: {
            const symbolsHandler = createInstrumentsAdapter({
              connectorType: this.connectorType,
              marketType,
              logger: this.logger,
              handler: this.handlerForInstruments.bind(this),
            });

            const unsub = await this.ws.subscribeToInstruments(
              { marketType },
              symbolsHandler,
            );
            this.subscription.unsubscribeInstruments = unsub;
            marketSub.unsubscribeInstruments = unsub;
            break;
          }

          case SubscriptionType.PROVIDER_INSTRUMENT_PRICES: {
            const unsub = await this.ws.subscribeToInstrumentPrices(
              {
                marketType,
                symbols: instruments.map((s) => s.symbol),
              },
              createInstrumentPricesAdapter(
                this.logger,
                this.handlerForInstrumentPrices.bind(this),
              )(marketType),
            );
            this.subscription.unsubscribeInstrumentPrices = unsub;
            marketSub.unsubscribeInstrumentPrices = unsub;
            break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const is410 =
          typeof (err as any)?.response?.status === 'number' &&
          (err as any).response.status === 410;
        this.logger.warn(
          `Subscription failed [${sub.type}] market=${marketType}: ${msg}${
            is410 ? ' (endpoint may be deprecated)' : ''
          }`,
        );
        // не пробрасываем — продолжаем остальные подписки (свечи, трейды и т.д.)
      }
    }
  }

  async updateSubscribeCollection(
    marketType: MarketType,
    instruments: Instrument[],
    intervals?: TimeFrame[],
  ): Promise<void> {
    this.unsubscribeMarket(marketType);

    await new Promise((r) => setTimeout(r, 300));

    await this.subscribe(marketType, instruments, intervals);
  }

  // =========================================================================
  // HANDLERS (ДОЛЖНЫ БЫТЬ Promise<void>)
  // =========================================================================
  private async handlerForTrade(
    marketType: MarketType,
    trade: Trade,
  ): Promise<void> {
    const symbol = String(trade.instrument?.symbol ?? '').toUpperCase();
    if (
      !this.instrumentShardService.isSymbolInLocalShard(
        symbol,
        this.connectorType,
        marketType,
      )
    ) {
      return;
    }
    const scope = this.instrumentShardService.getScopeForSymbol(
      symbol,
      this.connectorType,
      marketType,
    );
    const token = this.ownershipService.getFencingToken(scope);
    if (!this.ownershipService.assertOwnership(scope, token)) {
      return;
    }
    this.tradesIngestedInWindow += 1;
    this.providerMetrics.recordTrade(symbol);
    this.logIngestSummaryIfDue();
    const snapshot = this.getOrCreateMarketSnapshot(symbol);
    const profileUpdate = this.applyTradeToSnapshot(
      snapshot,
      marketType,
      trade,
    );
    const liquidityMap = this.liquidityMapService.onTrade({
      symbol,
      connectorType: this.connectorType,
      marketType,
      trade,
      referencePrice: Number(snapshot.orderbook.mid || trade.price || 0),
      profileSummary: snapshot.trades.horizontalVolumeProfileSummary as
        | import('@barfinex/types').HorizontalVolumeProfileSummary
        | null
        | undefined,
    });
    if (Object.keys(liquidityMap).length > 0) {
      snapshot.trades.liquidityMap = liquidityMap;
    }
    const report = this.evaluateAndTrackMarketQuality(symbol, snapshot);
    if (report.critical) {
      return;
    }
    if (
      this.diagnostics &&
      this.shouldLogDiagnostic(symbol, 'provider_trades')
    ) {
      const t = snapshot.trades;
      this.diagnostics.logProviderTrades({
        symbol,
        tradeCount: Number(t?.tradeCount ?? 0),
        volume: Number(t?.totalVolume ?? 0) || Number(trade.volume ?? 0),
      });
    }
    await this.emit(
      SubscriptionType.PROVIDER_MARKETDATA_TRADE,
      marketType,
      trade,
    );
    const ingestTs = Date.now();
    const eventTs = Math.trunc(Number(trade.time ?? ingestTs));
    const price = Number(trade.price ?? 0);
    const volume = Number(trade.volume ?? 0);
    const symbolStr = trade.instrument?.symbol ?? '';
    const sideStr = String(trade.side ?? '');
    this.pushRuntimeTrade(symbol, {
      id: String(
        trade.tradeId ?? `${eventTs}-${Math.random().toString(36).slice(2, 8)}`,
      ),
      time: eventTs,
      price,
      size: volume,
      side: String(trade.side ?? '').toUpperCase() === 'LONG' ? 'buy' : 'sell',
      tradeId: trade.tradeId,
      isBuyerMaker: trade.isBuyerMaker,
    });

    try {
      this.rawTradeRepository.enqueueRawTrade({
        connectorType: this.connectorType,
        marketType,
        symbol: symbolStr,
        tradeId: trade.tradeId,
        price,
        qty: volume,
        side: sideStr,
        aggressorSide:
          trade.isBuyerMaker === true
            ? 'SELL'
            : trade.isBuyerMaker === false
            ? 'BUY'
            : undefined,
        isBuyerMaker: trade.isBuyerMaker,
        eventTs,
        ingestTs,
        ts: eventTs,
      });
      this.rawTradesEnqueuedInWindow += 1;
      this.tradeRepository.enqueueBatch([
        {
          keys: { symbol: symbolStr, side: sideStr },
          fields: { price, volume },
          timestampNs: BigInt(eventTs) * 1_000_000n,
        },
      ]);
      this.tradeRowsWrittenInWindow += 1;
      this.logger.debug(
        `[TRADE_PIPELINE] symbol=${symbolStr} tradeId=${
          trade.tradeId ?? 'n/a'
        } action=write status=ok`,
      );
    } catch (err) {
      this.logger.warn(
        `[TRADE_PIPELINE] symbol=${symbolStr} action=write status=failed error=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    this.logIngestSummaryIfDue();
    if (profileUpdate.shouldPersist && profileUpdate.summary) {
      const summary = profileUpdate.summary;
      this.horizontalVolumeProfileRepository.enqueueSummary({
        symbol,
        connectorType: this.connectorType,
        marketType,
        summary: { ...summary, scope: 'provider_runtime' as const },
        levels: profileUpdate.levels,
      });
    }
    const persistRows = this.liquidityMapService.consumePersistRows();
    for (const row of persistRows) {
      this.liquidityMapRepository.enqueueSnapshot({
        symbol: row.symbol,
        connectorType: row.connectorType,
        marketType: row.marketType,
        snapshot: row.snapshot,
      });
    }
  }

  private async handlerForOrderBook(
    marketType: MarketType,
    orderbook: OrderBook,
  ): Promise<void> {
    const symbol = String(orderbook.instrument?.symbol ?? '').toUpperCase();
    if (
      !this.instrumentShardService.isSymbolInLocalShard(
        symbol,
        this.connectorType,
        marketType,
      )
    ) {
      return;
    }
    const scope = this.instrumentShardService.getScopeForSymbol(
      symbol,
      this.connectorType,
      marketType,
    );
    const token = this.ownershipService.getFencingToken(scope);
    if (!this.ownershipService.assertOwnership(scope, token)) {
      return;
    }
    this.orderbookEventsInWindow += 1;
    this.providerMetrics.recordOrderbook(symbol);
    this.logIngestSummaryIfDue();
    const snapshot = this.getOrCreateMarketSnapshot(symbol);
    this.applyOrderbookToSnapshot(snapshot, orderbook);
    const liquidityMap = this.liquidityMapService.onOrderBook({
      symbol,
      connectorType: this.connectorType,
      marketType,
      orderbook,
      profileSummary: snapshot.trades.horizontalVolumeProfileSummary as
        | import('@barfinex/types').HorizontalVolumeProfileSummary
        | null
        | undefined,
      referencePrice: Number(snapshot.orderbook.mid || 0),
    });
    if (Object.keys(liquidityMap).length > 0) {
      snapshot.trades.liquidityMap = liquidityMap;
    }
    const report = this.evaluateAndTrackMarketQuality(symbol, snapshot);
    if (report.critical) {
      return;
    }
    if (
      this.diagnostics &&
      this.shouldLogDiagnostic(symbol, 'provider_orderbook')
    ) {
      const ob = snapshot.orderbook;
      this.diagnostics.logProviderOrderbook({
        symbol,
        bid: Number(ob?.bestBid ?? 0),
        ask: Number(ob?.bestAsk ?? 0),
        spread: Number(ob?.spread ?? 0),
        depth: Number(
          ob?.depth ??
            (orderbook.bids?.length ?? 0) + (orderbook.asks?.length ?? 0),
        ),
      });
    }
    await this.emit(
      SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK,
      marketType,
      orderbook,
    );
    const writeSymbol = orderbook.instrument?.symbol ?? '';
    const bookTs = Math.trunc(Number(orderbook.time ?? Date.now()));
    const tsNs = BigInt(bookTs) * 1_000_000n;
    const topN = 20;
    const bids = (orderbook.bids ?? []).slice(0, topN);
    const asks = (orderbook.asks ?? []).slice(0, topN);
    const rows = [
      ...bids.map((level) => ({
        keys: { symbol: writeSymbol, side: 'bid' as const },
        fields: {
          price: Number(level.price ?? 0),
          volume: Number(level.volume ?? 0),
        },
        timestampNs: tsNs,
      })),
      ...asks.map((level) => ({
        keys: { symbol: writeSymbol, side: 'ask' as const },
        fields: {
          price: Number(level.price ?? 0),
          volume: Number(level.volume ?? 0),
        },
        timestampNs: tsNs,
      })),
    ];
    if (rows.length > 0) {
      try {
        this.orderBookRepository.enqueueBatch(rows);
        this.orderbookRowsWrittenInWindow += rows.length;
        const bestBid = bids.length > 0 ? Number(bids[0].price ?? 0) : 0;
        const bestAsk = asks.length > 0 ? Number(asks[0].price ?? 0) : 0;
        const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;
        const midPrice =
          bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
        const spreadBps =
          midPrice > 0 && spread > 0 ? (spread / midPrice) * 10_000 : undefined;
        const bidVol = bids.reduce((s, l) => s + Number(l.volume ?? 0), 0);
        const askVol = asks.reduce((s, l) => s + Number(l.volume ?? 0), 0);
        const depthImbalance =
          bidVol + askVol > 0
            ? (bidVol - askVol) / (bidVol + askVol)
            : undefined;
        this.orderbookTopRepository.enqueueTop({
          connectorType: this.connectorType,
          marketType,
          symbol: writeSymbol,
          bestBid,
          bestAsk,
          spread,
          spreadBps,
          midPrice,
          bidDepthTopN: bidVol,
          askDepthTopN: askVol,
          depthImbalance,
          lastBookTs: bookTs,
          ts: bookTs,
        });
        this.orderbookTopRowsInWindow += 1;
        const vol1 =
          bids.slice(0, 1).reduce((s, l) => s + Number(l.volume ?? 0), 0) +
          asks.slice(0, 1).reduce((s, l) => s + Number(l.volume ?? 0), 0);
        const vol5 =
          bids.slice(0, 5).reduce((s, l) => s + Number(l.volume ?? 0), 0) +
          asks.slice(0, 5).reduce((s, l) => s + Number(l.volume ?? 0), 0);
        const vol10 =
          bids.slice(0, 10).reduce((s, l) => s + Number(l.volume ?? 0), 0) +
          asks.slice(0, 10).reduce((s, l) => s + Number(l.volume ?? 0), 0);
        const totalDepth = bidVol + askVol;
        const bidPressure = totalDepth > 0 ? bidVol / totalDepth : 0.5;
        const askPressure = totalDepth > 0 ? askVol / totalDepth : 0.5;
        const microprice =
          totalDepth > 0 && bestBid > 0 && bestAsk > 0
            ? (bestBid * askVol + bestAsk * bidVol) / totalDepth
            : midPrice;
        const prev = this.lastOrderbookStateBySymbol.get(writeSymbol);
        const depthChangeThreshold = 0.2;
        let replenishmentSignal = 0;
        let depletionSignal = 0;
        let spreadWideningSignal = 0;
        if (prev) {
          if (
            prev.totalDepth > 0 &&
            totalDepth >= prev.totalDepth * (1 + depthChangeThreshold)
          )
            replenishmentSignal = 1;
          if (
            prev.totalDepth > 0 &&
            totalDepth <= prev.totalDepth * (1 - depthChangeThreshold)
          )
            depletionSignal = 1;
          const currBps = spreadBps ?? 0;
          if (
            Number.isFinite(prev.spreadBps) &&
            Number.isFinite(currBps) &&
            currBps > prev.spreadBps
          )
            spreadWideningSignal = 1;
        }
        this.lastOrderbookStateBySymbol.set(writeSymbol, {
          totalDepth,
          spreadBps: spreadBps ?? 0,
        });
        this.orderbookFeaturesRepository.enqueueFeatures({
          connectorType: this.connectorType,
          marketType,
          symbol: writeSymbol,
          spreadBps: spreadBps ?? 0,
          depthImbalance: depthImbalance ?? 0,
          microprice,
          liquidityTop1: vol1,
          liquidityTop5: vol5,
          liquidityTop10: vol10,
          bidPressure,
          askPressure,
          replenishmentSignal,
          depletionSignal,
          spreadWideningSignal,
          ts: bookTs,
        });
        const now = Date.now();
        const lastSnap = this.lastOrderbookSnapshotAtBySymbol.get(symbol) ?? 0;
        if (now - lastSnap >= this.orderbookSnapshotIntervalMs) {
          this.lastOrderbookSnapshotAtBySymbol.set(symbol, now);
          this.orderbookSnapshotsRepository.enqueueSnapshot({
            connectorType: this.connectorType,
            marketType,
            symbol: writeSymbol,
            depthLevels: topN,
            snapshotJson: JSON.stringify({
              b: bids.map((l) => [Number(l.price), Number(l.volume)]),
              a: asks.map((l) => [Number(l.price), Number(l.volume)]),
              ts: bookTs,
            }),
            ts: bookTs,
          });
        }
        const persistRows = this.liquidityMapService.consumePersistRows();
        for (const row of persistRows) {
          this.liquidityMapRepository.enqueueSnapshot({
            symbol: row.symbol,
            connectorType: row.connectorType,
            marketType: row.marketType,
            snapshot: row.snapshot,
          });
        }
      } catch (err) {
        this.logger.warn(
          `[ORDERBOOK_PIPELINE] symbol=${writeSymbol} action=feature-write status=failed error=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      this.logIngestSummaryIfDue();
    }
  }

  private async handlerForCandle(
    marketType: MarketType,
    candle: Candle,
  ): Promise<void> {
    const symbol = String(candle.instrument?.symbol ?? '').toUpperCase();
    if (
      !this.instrumentShardService.isSymbolInLocalShard(
        symbol,
        this.connectorType,
        marketType,
      )
    ) {
      return;
    }
    const scope = this.instrumentShardService.getScopeForSymbol(
      symbol,
      this.connectorType,
      marketType,
    );
    const token = this.ownershipService.getFencingToken(scope);
    if (!this.ownershipService.assertOwnership(scope, token)) {
      return;
    }
    const snapshot = this.getOrCreateMarketSnapshot(symbol);
    this.applyCandleToSnapshot(snapshot, candle);
    const report = this.evaluateAndTrackMarketQuality(symbol, snapshot);
    if (report.critical) {
      return;
    }
    if (
      this.diagnostics &&
      this.shouldLogDiagnostic(symbol, 'provider_candles')
    ) {
      this.diagnostics.logProviderCandles({
        symbol,
        interval: candle.interval ?? 'h1',
        count: 1,
      });
    }
    await this.emit(
      SubscriptionType.PROVIDER_MARKETDATA_CANDLE,
      marketType,
      candle,
    );
  }

  private shouldLogDiagnostic(symbol: string, stage: string): boolean {
    const key = `${symbol}:${stage}`;
    const now = Date.now();
    const last = this.lastDiagnosticLogAt.get(key) ?? 0;
    if (now - last < PROVIDER_DIAGNOSTICS_THROTTLE_MS) return false;
    this.lastDiagnosticLogAt.set(key, now);
    return true;
  }

  private async handlerForInstruments(
    marketType: MarketType,
    instruments: Instrument[],
  ): Promise<void> {
    const hash = instruments
      .map((s) => s.symbol)
      .sort()
      .join('|');
    if (hash === this.lastSymbolsHash) return;
    this.lastSymbolsHash = hash;

    await this.emit(SubscriptionType.PROVIDER_INSTRUMENTS, marketType, instruments);
  }

  private async handlerForInstrumentPrices(
    marketType: MarketType,
    price: InstrumentPrice,
  ): Promise<void> {
    await this.emit(SubscriptionType.PROVIDER_INSTRUMENT_PRICES, marketType, price);
  }

  // =========================================================================
  // EMIT (возвращает Promise<void>, чтобы совпадать с CandleHandler)
  // =========================================================================
  private async emit(
    type: SubscriptionType,
    marketType: MarketType,
    value: any,
  ): Promise<void> {
    const subscription: Subscription = {
      type,
      updateMoment: Date.now(),
      active: true,
    };

    const payload: SubscriptionValue = {
      value,
      options: {
        connectorType: this.connectorType,
        marketType,
        updateMoment: subscription.updateMoment!,
      },
    };

    if (type === SubscriptionType.PROVIDER_ACCOUNT_EVENT) {
      let sizeBytes = 0;
      try {
        sizeBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      } catch {
        sizeBytes = 0;
      }
      if (sizeBytes > this.accountPayloadWarnSizeBytes) {
        const valueAsAny = value as Record<string, unknown> | undefined;
        const positions = Array.isArray(valueAsAny?.positions)
          ? valueAsAny.positions.length
          : 0;
        const assets = Array.isArray(valueAsAny?.balances)
          ? valueAsAny.balances.length
          : 0;
        this.logger.warn(
          `[PayloadSizeWarning] channel=${String(
            type,
          )} size_bytes=${sizeBytes} positions=${positions} assets=${assets}`,
        );
      }
    }

    // ConnectorService.addSubscription({
    //     connectorType: this.connectorType,
    //     marketType,
    //     subscription,
    // });

    if (this.isEmitToRedisEnabled) {
      this.redis.emit(type, payload);
      // STEP 7 — Optional: log emission for pipeline debugging (set EVENTBUS_DEBUG=true or SOCKET_BRIDGE_DEBUG=true)
      if (
        process.env.EVENTBUS_DEBUG === 'true' ||
        process.env.SOCKET_BRIDGE_DEBUG === 'true'
      ) {
        const symbolHint =
          type === SubscriptionType.PROVIDER_INSTRUMENTS
            ? `symbols#${Array.isArray(value) ? value.length : 0}`
            : (value as any)?.instrument?.symbol ?? (value as any)?.instrument ?? '—';
        console.log('[Provider WS] emitting', type, symbolHint);
      }
    }
  }

  private logIngestSummaryIfDue(force = false): void {
    const now = Date.now();
    const elapsedMs = now - this.ingestStatsWindowStartedAt;
    if (!force && elapsedMs < this.ingestStatsLogIntervalMs) return;
    const elapsedSec = Math.max(1, elapsedMs / 1000);
    const trades = this.tradesIngestedInWindow;
    const orderbook = this.orderbookEventsInWindow;
    const tradeRows = this.tradeRowsWrittenInWindow;
    const orderbookRows = this.orderbookRowsWrittenInWindow;
    const rawTrades = this.rawTradesEnqueuedInWindow;
    const obTop = this.orderbookTopRowsInWindow;

    this.ingestStatsWindowStartedAt = now;
    this.tradesIngestedInWindow = 0;
    this.orderbookEventsInWindow = 0;
    this.tradeRowsWrittenInWindow = 0;
    this.orderbookRowsWrittenInWindow = 0;
    this.rawTradesEnqueuedInWindow = 0;
    this.orderbookTopRowsInWindow = 0;

    if (
      trades + orderbook + tradeRows + orderbookRows + rawTrades + obTop ===
      0
    )
      return;

    this.logger.log(
      `[INGEST] trades_ingested_per_sec=${(trades / elapsedSec).toFixed(1)} ` +
        `orderbook_events_per_sec=${(orderbook / elapsedSec).toFixed(1)} ` +
        `raw_trades_enqueued_per_sec=${(rawTrades / elapsedSec).toFixed(1)} ` +
        `orderbook_top_per_sec=${(obTop / elapsedSec).toFixed(1)} ` +
        `questdb_trade_rows_per_sec=${(tradeRows / elapsedSec).toFixed(1)} ` +
        `questdb_orderbook_rows_per_sec=${(orderbookRows / elapsedSec).toFixed(
          1,
        )} ` +
        `window_ms=${elapsedMs}`,
    );
  }

  private estimateActiveStreamCardinality(
    instrumentsCount: number,
    intervalsCount: number,
    subscriptions: Array<{ type?: SubscriptionType; active?: boolean }>,
  ): number {
    if (instrumentsCount <= 0) return 0;
    let estimate = 0;
    for (const subscription of subscriptions) {
      if (!subscription?.active) continue;
      switch (subscription.type) {
        case SubscriptionType.PROVIDER_MARKETDATA_CANDLE:
          estimate += instrumentsCount * Math.max(1, intervalsCount);
          break;
        case SubscriptionType.PROVIDER_MARKETDATA_TRADE:
        case SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK:
        case SubscriptionType.PROVIDER_INSTRUMENT_PRICES:
          estimate += instrumentsCount;
          break;
        case SubscriptionType.PROVIDER_INSTRUMENTS:
        case SubscriptionType.PROVIDER_ACCOUNT_EVENT:
          estimate += 1;
          break;
        default:
          break;
      }
    }
    return estimate;
  }

  private evaluateAndTrackMarketQuality(
    symbol: string,
    snapshot: MarketDataSnapshot,
  ): MarketValidationResult {
    const now = Date.now();
    const lastEval = this.marketQualityLastEvalTs.get(symbol) ?? 0;
    const cached = this.marketQualityReports.get(symbol);
    if (cached && now - lastEval < ExchangeDataService.QUALITY_EVAL_THROTTLE_MS) {
      return cached;
    }
    this.marketQualityLastEvalTs.set(symbol, now);
    const runtimeSnapshot: MarketDataSnapshot = {
      ...snapshot,
      candlesCountH1: undefined,
      candlesCountH4: undefined,
      candlesCountD1: undefined,
    };
    const report = this.marketQualityEngine.evaluateMarketDataQuality(
      symbol,
      runtimeSnapshot,
    );
    this.marketQualityReports.set(symbol, report);
    if (!report.valid) {
      const lastWarn = this.marketQualityLastWarnTs.get(symbol) ?? 0;
      if (now - lastWarn >= this.marketQualitySummaryIntervalMs) {
        this.marketQualityLastWarnTs.set(symbol, now);
        this.logger.warn(
          `[MarketQuality][Provider] symbol=${
            report.symbol
          } healthScore=${report.healthScore.toFixed(2)} ` +
            `orderbook=${report.orderbookStatus} trades=${report.tradeStatus} candles=${report.candleStatus} ` +
            `freshness=${report.freshnessStatus} reasons=${
              report.reasons.join('|') || 'n/a'
            }`,
        );
      }
    }
    return report;
  }

  /** If orderbook is crossed (bid >= ask), synthesize valid bid/ask from mid or last trade. */
  private normalizeCrossedOrderbook(snapshot: MarketDataSnapshot): void {
    const ob = snapshot.orderbook;
    if (ob.bestBid > 0 && ob.bestAsk > 0 && ob.bestBid < ob.bestAsk) return; // already valid
    const lastTrade = Number(
      snapshot.trades?.lastTrade?.price ?? snapshot.trades?.vwap ?? 0,
    );
    const mid = ob.mid > 0 ? ob.mid : lastTrade > 0 ? lastTrade : 0;
    if (mid <= 0) return;
    const syntheticSpread = mid * 0.0001; // 0.01% synthetic spread
    ob.bestBid = mid - syntheticSpread / 2;
    ob.bestAsk = mid + syntheticSpread / 2;
    ob.mid = mid;
    ob.spread = syntheticSpread;
    ob.spreadPct = 0.01;
  }

  private getOrCreateMarketSnapshot(symbol: string): MarketDataSnapshot {
    const normalized = String(symbol || '')
      .trim()
      .toUpperCase();
    const existing = this.marketQualitySnapshots.get(normalized);
    if (existing) return existing;
    const now = Date.now();
    const snapshot: MarketDataSnapshot = {
      symbol: normalized,
      orderbook: {
        bestBid: 0,
        bestAsk: 0,
        mid: 0,
        spread: 0,
        spreadPct: Number.POSITIVE_INFINITY,
        bids: [],
        asks: [],
        depth: 0,
        imbalance: 0,
        bidWalls: [],
        askWalls: [],
      },
      trades: {
        tradeCount: 0,
        buyVolume: 0,
        sellVolume: 0,
        aggressiveBuyVolume: 0,
        aggressiveSellVolume: 0,
        avgTradeSize: 0,
        maxTradeSize: 0,
        vwap: 0,
        totalVolume: 0,
        totalNotional: 0,
      },
      candles: { h1: [], h4: [], d1: [] },
      derivedMetrics: {
        volatility: 0,
        liquidity: 0,
        trend: 'unknown',
        regime: 'unknown',
      },
      timestamps: {
        orderbookTimestamp: now,
        tradeTimestamp: now,
        candleTimestamp: now,
        candleEventTimestamp: now,
      },
    };
    this.marketQualitySnapshots.set(normalized, snapshot);
    return snapshot;
  }

  private applyOrderbookToSnapshot(
    snapshot: MarketDataSnapshot,
    orderbook: OrderBook,
  ): void {
    const snapshotDepthLevels = 200;
    const bidUpdates = (orderbook.bids ?? []).map((level) => ({
      price: Number(level.price ?? 0),
      volume: Number(level.volume ?? 0),
    }));
    const askUpdates = (orderbook.asks ?? []).map((level) => ({
      price: Number(level.price ?? 0),
      volume: Number(level.volume ?? 0),
    }));
    const mergedBids = this.mergeOrderbookSide(
      snapshot.orderbook.bids,
      bidUpdates,
      true,
      snapshotDepthLevels,
    );
    const mergedAsks = this.mergeOrderbookSide(
      snapshot.orderbook.asks,
      askUpdates,
      false,
      snapshotDepthLevels,
    );

    let bestBid = mergedBids.length > 0 ? mergedBids[0]!.price : 0;
    let bestAsk = mergedAsks.length > 0 ? mergedAsks[0]!.price : 0;
    let coherentBids = mergedBids;
    let coherentAsks = mergedAsks;

    // Guard against transient crossed books from out-of-order deltas.
    if (bestBid > 0 && bestAsk > 0 && bestBid >= bestAsk) {
      const previousBestBid = Number(snapshot.orderbook.bestBid ?? 0);
      const previousBestAsk = Number(snapshot.orderbook.bestAsk ?? 0);
      coherentBids = mergedBids.filter((level) => level.price < bestAsk);
      coherentAsks = mergedAsks.filter((level) => level.price > bestBid);
      if (coherentBids.length === 0 && previousBestBid > 0) {
        coherentBids = [{ price: previousBestBid, volume: 1 }];
      }
      if (coherentAsks.length === 0 && previousBestAsk > 0) {
        coherentAsks = [{ price: previousBestAsk, volume: 1 }];
      }
      bestBid = coherentBids.length > 0 ? coherentBids[0]!.price : 0;
      bestAsk = coherentAsks.length > 0 ? coherentAsks[0]!.price : 0;

      // After correction still crossed — skip this update entirely, keep previous snapshot
      if (bestBid > 0 && bestAsk > 0 && bestBid >= bestAsk) {
        this.logger.debug(
          `[ORDERBOOK_SKIP] crossed_after_correction bid=${bestBid} ask=${bestAsk}; keeping previous snapshot`,
        );
        return;
      }
    }

    const mid =
      bestBid > 0 && bestAsk > 0 && bestAsk > bestBid
        ? (bestBid + bestAsk) / 2
        : 0;
    const spread =
      bestBid > 0 && bestAsk > 0 && bestAsk > bestBid ? bestAsk - bestBid : 0;
    const spreadPct = mid > 0 ? (spread / mid) * 100 : Number.POSITIVE_INFINITY;
    const bidVolume = coherentBids.reduce(
      (acc, level) => acc + Math.max(0, level.volume),
      0,
    );
    const askVolume = coherentAsks.reduce(
      (acc, level) => acc + Math.max(0, level.volume),
      0,
    );
    const denom = bidVolume + askVolume;
    const boundedBidLevels =
      mid > 0
        ? coherentBids.filter(
            (level) => level.price >= mid * 0.5 && level.price <= mid * 1.5,
          )
        : coherentBids;
    const boundedAskLevels =
      mid > 0
        ? coherentAsks.filter(
            (level) => level.price >= mid * 0.5 && level.price <= mid * 1.5,
          )
        : coherentAsks;

    snapshot.orderbook.bestBid = bestBid;
    snapshot.orderbook.bestAsk = bestAsk;
    snapshot.orderbook.mid = mid;
    snapshot.orderbook.spread = spread;
    snapshot.orderbook.spreadPct = spreadPct;
    snapshot.orderbook.bids = boundedBidLevels.slice(0, snapshotDepthLevels);
    snapshot.orderbook.asks = boundedAskLevels.slice(0, snapshotDepthLevels);
    snapshot.orderbook.depth =
      snapshot.orderbook.bids.length + snapshot.orderbook.asks.length;
    snapshot.orderbook.imbalance =
      denom > 0 ? (bidVolume - askVolume) / denom : 0;
    snapshot.orderbook.bidWalls = snapshot.orderbook.bids
      .slice()
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 3);
    snapshot.orderbook.askWalls = snapshot.orderbook.asks
      .slice()
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 3);
    const orderbookTimestamp = Number(orderbook.time ?? Date.now());
    snapshot.timestamps.orderbookTimestamp = Math.min(
      Date.now(),
      Number.isFinite(orderbookTimestamp) && orderbookTimestamp > 0
        ? orderbookTimestamp
        : Date.now(),
    );
    this.refreshDerivedMetrics(snapshot);
  }

  private mergeOrderbookSide(
    currentLevels: Array<{ price: number; volume: number }>,
    updates: Array<{ price: number; volume: number }>,
    isBid: boolean,
    maxLevels: number,
  ): Array<{ price: number; volume: number }> {
    const levelsByPrice = new Map<number, number>();
    for (const level of currentLevels ?? []) {
      const price = Number(level?.price ?? NaN);
      const volume = Number(level?.volume ?? NaN);
      if (!(price > 0) || !(volume > 0)) continue;
      levelsByPrice.set(price, volume);
    }
    for (const update of updates ?? []) {
      const price = Number(update?.price ?? NaN);
      const volume = Number(update?.volume ?? NaN);
      if (!(price > 0) || !Number.isFinite(volume)) continue;
      if (volume <= 0) {
        levelsByPrice.delete(price);
      } else {
        levelsByPrice.set(price, volume);
      }
    }
    return Array.from(levelsByPrice.entries())
      .map(([price, volume]) => ({ price, volume }))
      .sort((a, b) => (isBid ? b.price - a.price : a.price - b.price))
      .slice(0, maxLevels);
  }

  private applyTradeToSnapshot(
    snapshot: MarketDataSnapshot,
    marketType: MarketType,
    trade: Trade,
  ): HorizontalVolumeProfileTickResult {
    const price = Number(trade.price ?? 0);
    const volume = Number(trade.volume ?? 0);
    const tradeTimestamp = Number(trade.time ?? Date.now());
    const isBuy = String(trade.side ?? '').toUpperCase() === 'LONG';
    snapshot.trades.tradeCount += 1;
    snapshot.trades.buyVolume += isBuy ? Math.max(0, volume) : 0;
    snapshot.trades.sellVolume += isBuy ? 0 : Math.max(0, volume);
    snapshot.trades.aggressiveBuyVolume += isBuy ? Math.max(0, volume) : 0;
    snapshot.trades.aggressiveSellVolume += isBuy ? 0 : Math.max(0, volume);
    snapshot.trades.maxTradeSize = Math.max(
      snapshot.trades.maxTradeSize,
      Math.max(0, volume),
    );
    snapshot.trades.totalVolume =
      Number(snapshot.trades.totalVolume ?? 0) + Math.max(0, volume);
    snapshot.trades.totalNotional =
      Number(snapshot.trades.totalNotional ?? 0) + Math.max(0, price * volume);
    const totalVolume = Number(snapshot.trades.totalVolume ?? 0);
    snapshot.trades.avgTradeSize =
      snapshot.trades.tradeCount > 0
        ? totalVolume / snapshot.trades.tradeCount
        : 0;
    snapshot.trades.vwap =
      totalVolume > 0
        ? Number(snapshot.trades.totalNotional ?? 0) / totalVolume
        : 0;
    snapshot.trades.lastTrade = {
      price,
      volume,
      timestamp: tradeTimestamp,
    };
    const profileUpdate = this.horizontalVolumeProfileService.onTrade({
      symbol: snapshot.symbol,
      connectorType: this.connectorType,
      marketType,
      trade,
      referencePrice: Number(snapshot.orderbook.mid ?? price),
    });
    if (profileUpdate.summary) {
      const s = profileUpdate.summary;
      snapshot.trades.horizontalVolumeProfileSummary = {
        scope: 'provider_runtime',
        bucketSize: Number(s.bucketSize),
        bucketPrecision: Number(s.bucketPrecision),
        windowStart: Number(s.windowStart),
        windowEnd: Number(s.windowEnd),
        updatedAt: Number(s.updatedAt),
        tradeCount: Number(s.tradeCount),
        buyVolume: Number(s.buyVolume),
        sellVolume: Number(s.sellVolume),
        totalVolume: Number(s.totalVolume),
        deltaVolume: Number(s.deltaVolume),
        pocPrice: s.pocPrice,
        valueAreaLow: s.valueAreaLow,
        valueAreaHigh: s.valueAreaHigh,
        nearestHighVolumeNodeAbove: s.nearestHighVolumeNodeAbove,
        nearestHighVolumeNodeBelow: s.nearestHighVolumeNodeBelow,
        nearestLowVolumeNodeAbove: s.nearestLowVolumeNodeAbove,
        nearestLowVolumeNodeBelow: s.nearestLowVolumeNodeBelow,
        profileSkew: Number(s.profileSkew),
        concentrationScore: Number(s.concentrationScore),
        localImbalance: Number(s.localImbalance),
        buySellDeltaAtCurrentRegion: Number(s.buySellDeltaAtCurrentRegion),
        distanceToPocBps: s.distanceToPocBps,
      };
      snapshot.trades.horizontalVolumeProfileLevels = profileUpdate.levels;
    }
    snapshot.timestamps.tradeTimestamp = Math.min(
      Date.now(),
      Number.isFinite(tradeTimestamp) && tradeTimestamp > 0
        ? tradeTimestamp
        : Date.now(),
    );
    this.refreshDerivedMetrics(snapshot);
    return profileUpdate;
  }

  private applyCandleToSnapshot(
    snapshot: MarketDataSnapshot,
    candle: Candle,
  ): void {
    const interval = String(candle.interval ?? TimeFrame.h1).toLowerCase();
    const point = {
      time: Number(candle.time ?? Date.now()),
      open: Number(candle.open ?? 0),
      high: Number(candle.high ?? 0),
      low: Number(candle.low ?? 0),
      close: Number(candle.close ?? 0),
      volume: Number(candle.volume ?? 0),
    };
    const key: 'h1' | 'h4' | 'd1' = interval.includes('h4')
      ? 'h4'
      : interval.includes('day') || interval.includes('d1')
      ? 'd1'
      : 'h1';
    const bucket = snapshot.candles[key];
    const idx = bucket.findIndex((row) => Number(row.time) === point.time);
    if (idx >= 0) {
      bucket[idx] = point;
    } else {
      bucket.push(point);
      bucket.sort((a, b) => a.time - b.time);
      if (bucket.length > 300) {
        bucket.splice(0, bucket.length - 300);
      }
    }
    snapshot.timestamps.candleTimestamp = point.time;
    snapshot.timestamps.candleEventTimestamp = Date.now();
    this.refreshDerivedMetrics(snapshot);
  }

  private refreshDerivedMetrics(snapshot: MarketDataSnapshot): void {
    const closes = snapshot.candles.h1
      .map((c) => Number(c.close ?? NaN))
      .filter((value) => Number.isFinite(value) && value > 0);
    let volatility = 0;
    if (closes.length >= 3) {
      const returns: number[] = [];
      for (let i = 1; i < closes.length; i += 1) {
        const prev = closes[i - 1]!;
        const curr = closes[i]!;
        returns.push((curr - prev) / prev);
      }
      const mean =
        returns.reduce((acc, value) => acc + value, 0) / returns.length;
      const variance =
        returns.reduce((acc, value) => acc + Math.pow(value - mean, 2), 0) /
        returns.length;
      volatility = Math.sqrt(Math.max(0, variance));
    }
    const spreadPct = Number(
      snapshot.orderbook.spreadPct ?? Number.POSITIVE_INFINITY,
    );
    const depth = Number(snapshot.orderbook.depth ?? 0);
    const depthScore = depth > 0 ? Math.min(1, depth / 100) : 0;
    const spreadScore = Number.isFinite(spreadPct)
      ? 1 - Math.min(1, spreadPct / 0.5)
      : 0;
    const liquidity = Math.max(
      0,
      Math.min(1, depthScore * 0.35 + spreadScore * 0.65),
    );
    const trend = this.resolveTrend(snapshot);
    const regime =
      liquidity < 0.2 ? 'breakout' : volatility < 0.003 ? 'range' : 'trend';

    snapshot.derivedMetrics.volatility = volatility;
    snapshot.derivedMetrics.liquidity = liquidity;
    snapshot.derivedMetrics.trend = trend;
    snapshot.derivedMetrics.regime = regime;
  }

  private resolveTrend(snapshot: MarketDataSnapshot): MarketTrend {
    const h1 = snapshot.candles.h1;
    if (h1.length < 3) return 'unknown';
    const last = Number(h1[h1.length - 1]?.close ?? NaN);
    const prev = Number(h1[h1.length - 3]?.close ?? NaN);
    if (!Number.isFinite(last) || !Number.isFinite(prev) || prev <= 0)
      return 'unknown';
    if (last > prev) return 'up';
    if (last < prev) return 'down';
    return 'mixed';
  }

  private logMarketQualitySummary(): void {
    const activeFromSubscriptions =
      this.subscription.options?.instruments?.map((symbol) => symbol?.symbol) ?? [];
    const subscribedSymbols = new Set<string>(
      activeFromSubscriptions
        .map((symbol) => String(symbol || '').toUpperCase())
        .filter(Boolean),
    );
    const activeSymbols = new Set<string>([
      ...subscribedSymbols,
      ...Array.from(this.marketQualitySnapshots.keys()),
    ]);
    if (activeSymbols.size === 0) return;

    this.logger.log('[MarketQualitySummary]');
    for (const symbol of activeSymbols) {
      const snapshot = this.marketQualitySnapshots.get(symbol);
      if (!snapshot) continue;
      const report = this.marketQualityEngine.evaluateMarketDataQuality(symbol);
      this.marketQualityReports.set(symbol, report);
      this.logger.log(
        `[MarketQualitySummary] ${symbol} health=${report.healthScore.toFixed(
          2,
        )} orderbook=${report.orderbookStatus} trades=${
          report.tradeStatus
        } candles=${report.candleStatus}`,
      );
    }

    // Sweep stale symbols not in active subscriptions
    if (subscribedSymbols.size > 0) {
      for (const key of this.marketQualitySnapshots.keys()) {
        if (!subscribedSymbols.has(key)) {
          this.clearSymbolState(key);
        }
      }
    }
  }

  // =========================================================================
  // READ — PRICES
  // =========================================================================
  async getPrices(
    marketType: MarketType,
    instruments: Instrument[],
  ): Promise<{ [index: string]: { value: number; moment: number } }> {
    await this.client.ensureReady();

    const result: { [index: string]: { value: number; moment: number } } = {};

    let exchangePrices: { [index: string]: string } = {};
    let exchangeTime = Date.now();

    switch (marketType) {
      case MarketType.spot:
        exchangeTime = await this.client.api.time();
        exchangePrices = await this.client.api.prices();
        break;

      case MarketType.futures:
        exchangeTime = await this.client.api.futuresTime();
        exchangePrices = await this.client.api.futuresPrices();
        break;
    }

    for (const symbol of instruments) {
      const price = exchangePrices[symbol.symbol];
      if (price) {
        result[symbol.symbol] = {
          value: Number(price),
          moment: exchangeTime,
        };
      }
    }

    return result;
  }

  // =========================================================================
  // READ — HISTORY
  // =========================================================================
  async getHistory(options: {
    marketType: MarketType;
    instruments: Instrument[];
    interval: TimeFrame;
    days: number;
    gapDays?: number;
  }): Promise<Candle[]> {
    const { marketType, instruments, interval, days, gapDays = 0 } = options;

    return this.candleService.getHistory({
      connectorType: this.connectorType,
      marketType,
      instruments,
      interval,
      days,
      gapDays,
    });
  }
}
