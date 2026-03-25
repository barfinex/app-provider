import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ALL_CANDLE_INTERVALS,
  ConnectorType,
  MarketType,
  TradingSymbol,
  TimeFrame,
} from '@barfinex/types';
import { ConfigService } from '@barfinex/config';

import { HistoryLoaderService } from '../history/history-loader.service';
import { SymbolHistoryService } from '../history/symbol-history.service';
import { CandleQueryService } from '../candle-query.service';
import { RequestFactoryService } from '../providers/request-factory.service';
import { CandleWarmupGateService } from '../warmup/candle-warmup-gate.service';
import { QuestDBDDLService } from '../../questdb/questdb-ddl.service';
import { QuestDBQueryService } from '../../questdb/questdb-query.service';
import { DAY, ms } from '../time/time.utils';
import { CANDLE_SUBSCRIPTIONS_UPDATED } from '../../common/constants';
import { ProviderOwnershipService } from '../../ownership/provider-ownership.service';

/** Payload when connector subscription set is updated (startup or dynamic add). */
export { CANDLE_SUBSCRIPTIONS_UPDATED };

export interface CandleSubscriptionsUpdatedPayload {
  connectorType: ConnectorType;
  marketType: MarketType;
  symbols: TradingSymbol[];
  intervals: TimeFrame[];
}

interface StoredSubscription {
  connectorType: ConnectorType;
  marketType: MarketType;
  symbols: TradingSymbol[];
  intervals: TimeFrame[];
}

interface WarmupLogMeta {
  opId: string;
  ctx: {
    symbol: string;
    tf: TimeFrame;
    connectorType: string;
    marketType: string;
  };
}

type LookbackDaysConfig = Partial<Record<TimeFrame, number>>;

@Injectable()
export class CandleSyncService implements OnModuleInit {
  private readonly logger = new Logger(CandleSyncService.name);
  private static readonly WARMUP_WORKERS = 3;
  private static readonly WARMUP_REQUEST_PACE_MS = 100;
  private static readonly WARMUP_TASK_WARN_LIMIT = 500;
  private static readonly WARMUP_INTERVALS: TimeFrame[] = [
    TimeFrame.min1,
    TimeFrame.min5,
    TimeFrame.min15,
    TimeFrame.min30,
    TimeFrame.h1,
    TimeFrame.h2,
    TimeFrame.h4,
    TimeFrame.day,
  ];
  private static readonly MARKET_QUALITY_REQUIRED_INTERVALS: TimeFrame[] = [
    TimeFrame.h1,
    TimeFrame.h4,
    TimeFrame.day,
  ];
  private readonly candleVerbose = process.env.CANDLE_VERBOSE_LOGS === 'true';
  private readonly warmupVerbose = this.candleVerbose;
  private readonly warmupIntervalLogs = this.candleVerbose;
  private readonly backfillVerbose = this.candleVerbose;
  private static readonly DEFAULT_LOOKBACK_DAYS: Record<TimeFrame, number> = {
    [TimeFrame.min1]: 30,
    [TimeFrame.min5]: 90,
    [TimeFrame.min15]: 90,
    [TimeFrame.min30]: 90,
    [TimeFrame.h1]: 120,
    [TimeFrame.h2]: 120,
    [TimeFrame.h4]: 120,
    [TimeFrame.day]: 540,
  };

  /** connectorType:marketType -> subscription set */
  private readonly state = new Map<string, StoredSubscription>();

  /** Очистка истории выполняется один раз за запуск. */
  private hasTruncatedThisRun = false;
  private hasCleanedUnreasonableTsThisRun = false;

  /**
   * Warmup guard:
   * - не запускаем backfill пока идёт warmup
   * - не запускаем 2 warmup одновременно на один и тот же key
   */
  private readonly warmupRunningKeys = new Set<string>();
  private readonly warmupQueuedKeys = new Set<string>();

  /** 🔒 Глобальный lock — только один warmup во всей системе одновременно */
  private warmupGlobalRunning = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly historyLoader: HistoryLoaderService,
    private readonly symbolHistory: SymbolHistoryService,
    private readonly candleQuery: CandleQueryService,
    private readonly requestFactory: RequestFactoryService,
    private readonly warmupGate: CandleWarmupGateService,
    private readonly ddlService: QuestDBDDLService,
    private readonly questDbQueryService: QuestDBQueryService,
    private readonly ownershipService: ProviderOwnershipService,
  ) {}

  private warmupLog(message: string): void {
    if (this.warmupVerbose) this.logger.log(message);
  }

  private warmupDebug(message: string): void {
    if (this.warmupVerbose) this.logger.debug(message);
  }

  private backfillLog(message: string): void {
    if (this.backfillVerbose) this.logger.log(message);
  }

  private backfillDebug(message: string): void {
    if (this.backfillVerbose) this.logger.debug(message);
  }

  private parsePositiveInt(value: unknown): number | null {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const i = Math.trunc(n);
    return i > 0 ? i : null;
  }

  private configLookbackByInterval(interval: TimeFrame): number | null {
    const cfg = this.configService.getConfig()?.provider?.candleSync;
    const map = (cfg?.lookbackDays ?? {}) as LookbackDaysConfig;
    const fromMap = this.parsePositiveInt(map[interval]);
    if (fromMap != null) return fromMap;
    return this.parsePositiveInt(cfg?.warmupDays);
  }

  private getLookbackDays(interval: TimeFrame): number {
    return (
      this.configLookbackByInterval(interval) ??
      CandleSyncService.DEFAULT_LOOKBACK_DAYS[interval]
    );
  }

  private getOverlapCandles(): number {
    const cfgValue = this.parsePositiveInt(
      this.configService.getConfig()?.provider?.candleSync?.overlapCandles,
    );
    if (cfgValue != null) return Math.min(5, cfgValue);
    return 2;
  }

  private expectedCandlesCount(
    interval: TimeFrame,
    fromMs: number,
    toMs: number,
  ): number {
    const intervalMs = ms(interval);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;
    if (toMs < fromMs) return 0;
    const alignedTo = Math.floor(toMs / intervalMs) * intervalMs;
    if (alignedTo < fromMs) return 0;
    return Math.floor((alignedTo - fromMs) / intervalMs) + 1;
  }

  async onModuleInit(): Promise<void> {
    const clearHistoryOnStartup =
      this.configService.getConfig()?.provider?.candleSync
        ?.clearHistoryOnStartup === true;

    if (!clearHistoryOnStartup || this.hasTruncatedThisRun) return;

    try {
      await this.candleQuery.truncateCandles();
      this.hasTruncatedThisRun = true;
      this.logger.log(
        'Candles table truncated (clearHistoryOnStartup). Warmup will run when subscriptions are ready.',
      );
    } catch (err) {
      this.logger.error(
        'Failed to truncate candles table (clearHistoryOnStartup)',
        err as any,
      );
    }
  }

  private isConnectorSupported(connectorType: ConnectorType): boolean {
    return (
      connectorType === ConnectorType.binance ||
      connectorType === ConnectorType.alpaca
    );
  }

  private createWarmupOpId(): string {
    return `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`.toUpperCase();
  }

  private warmupPrefix(meta: WarmupLogMeta): string {
    const { opId, ctx } = meta;
    return `[warmup:${opId}] [ctx symbol=${ctx.symbol} tf=${String(
      ctx.tf,
    )} connectorType=${ctx.connectorType} marketType=${ctx.marketType}]`;
  }

  private filterWarmupSymbols(symbols: TradingSymbol[]): TradingSymbol[] {
    const skip = new Set<string>(['USDT', 'BUSD', 'USDC', 'FDUSD', 'TUSD']);
    return symbols.filter((s) => {
      const name = (typeof s === 'string' ? s : s.name || '').toUpperCase();
      if (skip.has(name)) return false;
      if (name.length < 6) return false;
      return true;
    });
  }

  private sleep(msDelay: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, msDelay));
  }

  @OnEvent(CANDLE_SUBSCRIPTIONS_UPDATED)
  async onSubscriptionsUpdated(
    payload: CandleSubscriptionsUpdatedPayload,
  ): Promise<void> {
    if (!payload?.symbols?.length || !payload?.intervals?.length) {
      this.logger.warn(
        `Candle sync skipped: no symbols or intervals (symbols=${
          payload?.symbols?.length ?? 0
        }, intervals=${payload?.intervals?.length ?? 0})`,
      );
      return;
    }

    const { connectorType, marketType, symbols, intervals } = payload;

    if (!this.isConnectorSupported(connectorType)) {
      this.logger.debug(
        `Candle sync skipped for unsupported connector: ${connectorType}`,
      );
      return;
    }

    const symbolsFiltered = this.filterWarmupSymbols(symbols);
    if (symbolsFiltered.length < symbols.length) {
      this.logger.debug(
        `Warmup: skipped ${
          symbols.length - symbolsFiltered.length
        } non-tradeable symbols (e.g. USDT alone)`,
      );
    }

    const supportedIntervals = intervals.filter((tf) =>
      ALL_CANDLE_INTERVALS.includes(tf),
    );
    if (supportedIntervals.length < intervals.length) {
      const dropped = intervals.filter(
        (tf) => !ALL_CANDLE_INTERVALS.includes(tf),
      );
      this.logger.warn(
        `Candle sync: dropping unsupported intervals (e.g. week) intervals=${dropped.join(
          ',',
        )} supported=${ALL_CANDLE_INTERVALS.join(',')}`,
      );
    }

    const key = `${connectorType}:${marketType}`;

    this.state.set(key, {
      connectorType,
      marketType,
      symbols: [...symbolsFiltered],
      intervals: supportedIntervals.length
        ? supportedIntervals
        : [TimeFrame.min1],
    });

    if (this.warmupRunningKeys.has(key)) {
      this.warmupQueuedKeys.add(key);
      this.logger.log(`Warmup already running for ${key}. Queued rerun.`);
      return;
    }

    this.startWarmupForKey(key).catch((err) => {
      this.logger.error(`Warmup failed for ${key}`, err as any);
    });
  }

  private async startWarmupForKey(key: string): Promise<void> {
    const sub = this.state.get(key);
    if (!sub) return;

    const { connectorType, marketType, symbols, intervals } = sub;
    if (
      !this.ownershipService.isActiveOwnerForConnectorMarket(
        connectorType,
        marketType,
      )
    ) {
      this.logger.warn(`Warmup skipped: no ownership for scope=${key}`);
      this.warmupGate.setWarmupCompleted(true);
      return;
    }

    // 🔒 Ждём если другой warmup уже идёт
    while (this.warmupGlobalRunning) {
      await new Promise((r) => setTimeout(r, 200));
    }

    this.warmupGlobalRunning = true;
    this.warmupRunningKeys.add(key);
    this.warmupQueuedKeys.delete(key);
    this.warmupGate.setWarmupCompleted(false);
    this.warmupGate.setWarmupRunning(
      String(connectorType),
      String(marketType),
      true,
    );

    try {
      this.logger.log(
        `Subscriptions updated: ${key}, symbols=${symbols.length}, intervals=${intervals.length}. Starting warmup.`,
      );

      await this.runWarmup(connectorType, marketType, symbols, intervals);
    } finally {
      this.warmupGate.setWarmupRunning(
        String(connectorType),
        String(marketType),
        false,
      );
      this.warmupRunningKeys.delete(key);
      this.warmupGlobalRunning = false;
    }

    if (this.warmupQueuedKeys.has(key)) {
      this.logger.log(
        `Warmup queued rerun detected for ${key}. Restarting warmup.`,
      );
      await this.startWarmupForKey(key);
    }
  }

  /**
   * One (symbol, interval) warmup task.
   */
  private async warmupOneSymbolInterval(
    connectorType: ConnectorType,
    marketType: MarketType,
    s: TradingSymbol,
    interval: TimeFrame,
    requestFn:
      | ((
          from: number,
          to: number,
          symbol: string,
          interval: TimeFrame,
        ) => Promise<unknown>)
      | null,
    now: number,
    lookbackDays: number,
  ): Promise<void> {
    const symbolName = typeof s === 'string' ? s : s.name;
    const ctx = {
      symbol: symbolName,
      tf: interval,
      connectorType: String(connectorType),
      marketType: String(marketType),
    } as const;
    const meta: WarmupLogMeta = {
      opId: this.createWarmupOpId(),
      ctx,
    };
    const logPrefix = this.warmupPrefix(meta);

    try {
      const coverage = await this.candleQuery.loadSeriesCoverage({
        symbol: ctx.symbol,
        connectorType: ctx.connectorType,
        marketType: ctx.marketType,
        interval: ctx.tf,
        logMeta: meta,
      });
      const lastTs = coverage.maxTsMs;
      const firstTs = coverage.minTsMs;
      const lookbackFrom = Math.max(0, now - lookbackDays * DAY);
      const expectedCount = this.expectedCandlesCount(
        ctx.tf,
        lookbackFrom,
        now,
      );

      if (lastTs != null && requestFn) {
        if (
          firstTs != null &&
          (firstTs > lookbackFrom || coverage.count < expectedCount)
        ) {
          const backfillTo = Math.max(lookbackFrom, firstTs - ms(ctx.tf));
          this.warmupLog(
            `${logPrefix} coverage check: expected=${expectedCount}, actual=${
              coverage.count
            }, firstTs=${new Date(
              firstTs,
            ).toISOString()}, targetFrom=${new Date(
              lookbackFrom,
            ).toISOString()} -> backfill older range`,
          );
          if (lookbackFrom <= backfillTo) {
            const backfilled = await this.symbolHistory.loadForSymbol({
              connectorType: ctx.connectorType,
              marketType: ctx.marketType,
              symbol: ctx.symbol,
              interval: ctx.tf,
              from: lookbackFrom,
              to: backfillTo,
              requestFn,
              logMeta: meta,
            });
            this.warmupLog(
              `${logPrefix} older-range backfill done, candles=${backfilled.length}`,
            );
          }
        }

        const intervalMs = ms(ctx.tf);
        const overlapCandles = this.getOverlapCandles();
        const from = Math.max(
          lookbackFrom,
          lastTs - overlapCandles * intervalMs,
        );
        if (from >= now) {
          this.warmupDebug(`${logPrefix} already up to date, skip`);
          return;
        }
        const candles = await this.symbolHistory.loadForSymbol({
          connectorType: ctx.connectorType,
          marketType: ctx.marketType,
          symbol: ctx.symbol,
          interval: ctx.tf,
          from,
          to: now,
          requestFn,
          minTimeExclusive: Math.max(0, lastTs - overlapCandles * intervalMs),
          logMeta: meta,
        });
        this.warmupLog(
          `${logPrefix} extended from ${new Date(
            lastTs,
          ).toISOString()}, candles=${candles.length}`,
        );
      } else {
        const candles = await this.historyLoader.getHistory({
          connectorType: ctx.connectorType as ConnectorType,
          marketType: ctx.marketType as MarketType,
          symbols: [s],
          interval: ctx.tf,
          days: lookbackDays,
          gapDays: 0,
          logMeta: meta,
        });
        this.warmupLog(
          `${logPrefix} history loaded, candles=${candles.length}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `${logPrefix} skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async runWarmup(
    connectorType: ConnectorType,
    marketType: MarketType,
    symbols: TradingSymbol[],
    intervals: TimeFrame[],
    warmupDaysOverride?: number, // legacy compatibility; prefer per-interval lookback
  ): Promise<void> {
    if (!this.hasCleanedUnreasonableTsThisRun) {
      await this.candleQuery.cleanupUnreasonableCandles();
      this.hasCleanedUnreasonableTsThisRun = true;
    }

    await this.questDbQueryService.ensureWalHealthy('candles');

    const now = Date.now();
    let requestFn:
      | ((
          from: number,
          to: number,
          symbol: string,
          interval: TimeFrame,
        ) => Promise<unknown>)
      | null = null;
    try {
      requestFn = this.requestFactory.create(connectorType, marketType);
    } catch {
      requestFn = null;
    }

    const warmupIntervals = Array.from(
      new Set<TimeFrame>([
        ...intervals.filter((interval) =>
          CandleSyncService.WARMUP_INTERVALS.includes(interval),
        ),
        ...CandleSyncService.MARKET_QUALITY_REQUIRED_INTERVALS,
      ]),
    );
    if (warmupIntervals.length === 0) {
      this.logger.warn(
        `[CandleWarmup] skipped_no_warmup_intervals configured=${
          intervals.join(',') || 'none'
        } allowed=${CandleSyncService.WARMUP_INTERVALS.join(',')}`,
      );
      this.warmupGate.setWarmupCompleted(true);
      return;
    }

    const tasks: Array<{
      symbol: TradingSymbol;
      interval: TimeFrame;
      lookbackDays: number;
    }> = [];

    for (const interval of warmupIntervals) {
      const lookbackDays =
        warmupDaysOverride != null
          ? warmupDaysOverride
          : this.getLookbackDays(interval);
      if (this.warmupIntervalLogs || this.warmupVerbose) {
        this.logger.log(
          `[Warmup] lookbackDays=${lookbackDays} interval=${interval} connector=${connectorType} market=${marketType}`,
        );
      }
      for (const s of symbols) {
        tasks.push({ symbol: s, interval, lookbackDays });
      }
    }

    const totalTasks = tasks.length;
    const workers = Math.max(1, CandleSyncService.WARMUP_WORKERS);
    this.logger.log(
      `[CandleWarmup] queue_size=${totalTasks} workers=${workers}`,
    );
    if (totalTasks > CandleSyncService.WARMUP_TASK_WARN_LIMIT) {
      this.logger.warn(
        `[CandleWarmupProtection] task_count_exceeds_limit tasks=${totalTasks} limit=${CandleSyncService.WARMUP_TASK_WARN_LIMIT}`,
      );
    }

    let nextTaskIndex = 0;
    let progress = 0;
    const runWorker = async (): Promise<void> => {
      while (true) {
        const taskIndex = nextTaskIndex;
        nextTaskIndex += 1;
        if (taskIndex >= totalTasks) return;

        const task = tasks[taskIndex];
        const symbolName =
          typeof task.symbol === 'string' ? task.symbol : task.symbol.name;
        progress += 1;
        this.logger.log(
          `[CandleWarmup] symbol=${symbolName} interval=${task.interval} task=${progress}/${totalTasks}`,
        );

        await this.warmupOneSymbolInterval(
          connectorType,
          marketType,
          task.symbol,
          task.interval,
          requestFn,
          now,
          task.lookbackDays,
        );
        await this.sleep(CandleSyncService.WARMUP_REQUEST_PACE_MS);
      }
    };

    const workerCount = Math.min(workers, Math.max(1, totalTasks));
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    this.logger.log(
      `Warmup done: ${connectorType}:${marketType}, ${symbols.length} symbols, ${warmupIntervals.length} intervals`,
    );
    this.warmupGate.setWarmupCompleted(true);
    this.logger.log(
      `[Warmup] Key completed: ${connectorType}:${marketType} symbols=${symbols.length} intervals=${warmupIntervals.length}`,
    );
  }

  /** Block until HTTP history warmup for current key has completed. */
  async waitForWarmupCompletion(): Promise<void> {
    while (!this.warmupGate.isWarmupCompleted()) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  isWarmupCompleted(): boolean {
    return this.warmupGate.isWarmupCompleted();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async runBackfill(): Promise<void> {
    if (this.state.size === 0) return;

    await this.ddlService.tryResumeCandlesWal();

    if (this.warmupRunningKeys.size > 0) {
      this.logger.debug(
        `Backfill skipped: warmup in progress (${this.warmupRunningKeys.size} keys running)`,
      );
      return;
    }

    const now = Date.now();
    for (const [, sub] of this.state) {
      const { connectorType, marketType, symbols, intervals } = sub;
      const safeIntervals = intervals.filter((tf) =>
        ALL_CANDLE_INTERVALS.includes(tf),
      );
      if (safeIntervals.length === 0) continue;

      let requestFn: (
        from: number,
        to: number,
        symbol: string,
        interval: TimeFrame,
      ) => Promise<unknown>;
      try {
        requestFn = this.requestFactory.create(connectorType, marketType);
      } catch {
        continue;
      }

      for (const interval of safeIntervals) {
        const lookbackDays = this.getLookbackDays(interval);
        const overlapCandles = this.getOverlapCandles();
        const intervalMs = ms(interval);
        this.backfillLog(
          `[Backfill] lookbackDays=${lookbackDays} interval=${interval} connector=${connectorType} market=${marketType}`,
        );

        for (const s of symbols) {
          const symbolName = typeof s === 'string' ? s : s.name;
          if (!symbolName) continue;

          try {
            this.backfillLog(
              `HISTORY_BACKFILL_START symbol=${symbolName} interval=${interval} connector=${connectorType} market=${marketType}`,
            );
            const lastTs = await this.candleQuery.loadLastTimestamp({
              symbol: symbolName,
              connectorType: String(connectorType),
              marketType: String(marketType),
              interval,
            });

            const from =
              lastTs == null
                ? now - lookbackDays * DAY
                : Math.max(0, lastTs - overlapCandles * intervalMs);

            if (from > now) continue;

            await this.symbolHistory.loadForSymbol({
              connectorType,
              marketType,
              symbol: symbolName,
              interval,
              from,
              to: now,
              requestFn,
              minTimeExclusive:
                lastTs != null
                  ? Math.max(0, lastTs - overlapCandles * intervalMs)
                  : undefined,
            });

            this.backfillDebug(
              `Backfill ${symbolName} ${interval}: from ${new Date(
                from,
              ).toISOString()} to now`,
            );
            this.backfillLog(
              `HISTORY_BACKFILL_COMPLETE symbol=${symbolName} interval=${interval} connector=${connectorType} market=${marketType}`,
            );
          } catch (err) {
            this.logger.warn(
              `Backfill failed ${symbolName} ${interval}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
    }
  }
}
