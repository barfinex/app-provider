import { Injectable, Logger } from '@nestjs/common';
import {
  QuestDBWriteService,
  ILPWriteOptions,
} from '../questdb/questdb-write.service';
import { QuestDBDDLService } from '../questdb/questdb-ddl.service';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import { CandleWarmupGateService } from './warmup/candle-warmup-gate.service';
import { ConsoleWarmupProgressService } from './warmup/console-warmup-progress.service';
import { Candle, TimeFrame } from '@barfinex/types';
import { LiveCandle } from './candle-cache.service';
import {
  isInvalidOhlc,
  validateHistoryCandle,
  candleToLogRow,
} from './candle-validation';

export interface CandleWrite
  extends Omit<Candle, 'symbol' | 'time' | 'interval'> {
  symbol: string;
  connectorType: string;
  marketType: string;
  interval: TimeFrame;
  ts: number; // ms
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

@Injectable()
export class CandleWriterService {
  private readonly logger = new Logger(CandleWriterService.name);
  private readonly warmupVerbose = process.env.CANDLE_VERBOSE_LOGS === 'true';
  private readonly CHANNEL = 'candles' as const;
  private readonly seriesLocks = new Map<string, Promise<void>>();

  /** Adaptive chunk size bounds for history TCP streaming. */
  private static readonly CHUNK_MAX = 120;
  private static readonly CHUNK_MIN = 60;

  /** Adaptive delay bounds (ms) between chunks. */
  private static readonly BASE_DELAY_MS = 40;
  private static readonly MAX_DELAY_MS = 150;

  /** WAL lag zones for adaptive flow control. */
  private static readonly WAL_SAFE_LAG = 50;
  private static readonly WAL_YELLOW_LAG = 100;
  private static readonly WAL_RED_LAG = 150;
  private static readonly WAL_RECOVERY_LAG = 70;
  /** Max wait (ms) in red zone before proceeding with conservative chunk/delay (avoids stuck at 0/s when lag never drops). */
  private static readonly RED_ZONE_CATCHUP_TIMEOUT_MS = 3_000;

  /** Min interval (ms) between RESUME WAL calls to avoid spam. */
  private static readonly RESUME_WAL_THROTTLE_MS = 5_000;
  /** Small cooldown after RESUME before next suspended re-check. */
  private static readonly RESUME_WAL_COOLDOWN_MS = 1_200;
  /** Require repeated suspended states before RESUME. */
  private static readonly SUSPENDED_STREAK_FOR_RESUME = 2;

  /**
   * Нижняя граница адекватного timestamp (мс), чтобы не писать 1970/ts=0/отрицательные даты.
   * 2000-01-01 UTC
   */
  private static readonly MIN_REASONABLE_TS_MS = 946684800000;

  /** Last time we triggered RESUME WAL (for throttling). */
  private lastResumeAt = 0;

  constructor(
    private readonly writer: QuestDBWriteService,
    private readonly ddlService: QuestDBDDLService,
    private readonly questDbQueryService: QuestDBQueryService,
    private readonly warmupGate: CandleWarmupGateService,
    private readonly warmupProgress: ConsoleWarmupProgressService,
  ) {}

  private async withSeriesLock<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.seriesLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prev.then(() => gate);
    this.seriesLocks.set(key, chain);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.seriesLocks.get(key) === chain) {
        this.seriesLocks.delete(key);
      }
    }
  }

  // ================================================================
  // helpers
  // ================================================================
  private createWarmupOpId(): string {
    return `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`.toUpperCase();
  }

  private esc(value: string): string {
    return value.replace(/'/g, "''");
  }

  private toSqlNumber(value: number): string {
    if (!Number.isFinite(value)) return '0';
    return String(value);
  }

  private warmupPrefix(meta: WarmupLogMeta): string {
    const { opId, ctx } = meta;
    return `[warmup:${opId}] [ctx symbol=${ctx.symbol} tf=${String(
      ctx.tf,
    )} connectorType=${ctx.connectorType} marketType=${ctx.marketType}]`;
  }

  private warmupLog(message: string): void {
    if (this.warmupVerbose) this.logger.log(message);
  }

  private warmupDebug(message: string): void {
    if (this.warmupVerbose) this.logger.debug(message);
  }

  /**
   * Dedupe history candles by composite key (time + dimensions).
   * Важно: у тебя сейчас дедуп по одному `time`, но warmup может писать
   * разные series (connectorType/marketType/interval/symbol). В текущем методе
   * это не мешает, т.к. args уже фиксированы, но дубликаты по времени реально
   * встречаются из REST (и/или пересечения диапазонов) → WAL rollback.
   *
   * Здесь делаем стабильный dedupe: оставляем последнюю запись для одинакового key.
   */
  private dedupeHistoryCandles(
    candles: Candle[],
    symbol: string,
    interval: TimeFrame,
    connectorType: string,
    marketType: string,
  ): { deduped: Candle[]; removed: number } {
    const sorted = [...candles].sort((a, b) => a.time - b.time);

    // key = series + time (на всякий случай, чтобы метод был безопасным
    // даже если когда-нибудь будет переиспользован не строго на одном symbol/interval)
    const map = new Map<string, Candle>();
    for (const c of sorted) {
      // time в ms
      const key = `${symbol}|${String(
        interval,
      )}|${connectorType}|${marketType}|${c.time}`;
      map.set(key, c);
    }

    const deduped = Array.from(map.values()).sort((a, b) => a.time - b.time);
    return { deduped, removed: sorted.length - deduped.length };
  }

  // ================================================================
  // 1) Realtime single candle
  // ================================================================
  writeCandle(
    symbol: string,
    tf: TimeFrame,
    candle: LiveCandle,
    connectorType: string,
    marketType: string,
  ) {
    if (!candle) return;
    if (isInvalidOhlc(candle)) return;
    if (!Number.isFinite(candle.start)) return;
    if (!this.warmupGate.isWarmupCompleted()) return;
    if (this.warmupGate.isAnyWarmupRunning()) return;
    if (this.warmupGate.isWarmupRunning(connectorType, marketType)) return;

    // 🔒 защита от 1970 / ts=0 / отрицательных дат
    const tsMs = Math.trunc(candle.start);

    if (
      !Number.isFinite(tsMs) ||
      tsMs < CandleWriterService.MIN_REASONABLE_TS_MS
    ) {
      this.logger.warn(
        `[candles] writeCandle skipped invalid timestamp | symbol=${symbol} interval=${tf} ts=${candle.start}`,
      );
      return;
    }

    if (
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close) ||
      !Number.isFinite(candle.volume)
    ) {
      return;
    }

    const line: ILPWriteOptions = {
      table: 'candles',
      keys: { symbol, interval: tf, connectorType, marketType },
      fields: {
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      },
      timestampNs: BigInt(tsMs) * 1_000_000n,
    };

    this.writer.write(this.CHANNEL, line);
    const seriesKey = `${symbol}:${String(tf)}:${connectorType}:${marketType}`;
    if (this.warmupVerbose) {
      this.logger.log(
        `[CANDLE_PIPELINE] symbol=${symbol} interval=${String(
          tf,
        )} ts=${tsMs} source=realtime action=insert reason=normal seriesKey=${seriesKey}`,
      );
    }
  }

  // ================================================================
  // 2) Final candle
  // ================================================================
  writeFinalCandle(
    symbol: string,
    tf: TimeFrame,
    candle: Candle,
    connectorType: string,
    marketType: string,
  ) {
    if (!candle) return;
    if (isInvalidOhlc(candle)) return;
    if (!Number.isFinite(candle.time)) return;
    if (!this.warmupGate.isWarmupCompleted()) return;
    if (this.warmupGate.isAnyWarmupRunning()) return;
    if (this.warmupGate.isWarmupRunning(connectorType, marketType)) return;

    // 🔒 защита от 1970 / ts=0 / отрицательных дат
    const tsMs = Math.trunc(candle.time);

    if (
      !Number.isFinite(tsMs) ||
      tsMs < CandleWriterService.MIN_REASONABLE_TS_MS
    ) {
      this.logger.warn(
        `[candles] writeFinalCandle skipped invalid timestamp | symbol=${symbol} interval=${tf} ts=${candle.time}`,
      );
      return;
    }

    if (
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close) ||
      !Number.isFinite(candle.volume)
    ) {
      return;
    }

    const line: ILPWriteOptions = {
      table: 'candles',
      keys: { symbol, interval: tf, connectorType, marketType },
      fields: {
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      },
      timestampNs: BigInt(tsMs) * 1_000_000n,
    };

    this.writer.write(this.CHANNEL, line);
    const seriesKeyFinal = `${symbol}:${String(
      tf,
    )}:${connectorType}:${marketType}`;
    if (this.warmupVerbose) {
      this.logger.log(
        `[CANDLE_PIPELINE] symbol=${symbol} interval=${String(
          tf,
        )} ts=${tsMs} source=realtime action=insert reason=normal seriesKey=${seriesKeyFinal}`,
      );
    }
  }

  async upsertFinalCandle(
    symbol: string,
    tf: TimeFrame,
    candle: Candle,
    connectorType: string,
    marketType: string,
  ): Promise<void> {
    if (!candle) return;
    if (isInvalidOhlc(candle)) return;
    if (!Number.isFinite(candle.time)) return;
    if (!this.warmupGate.isWarmupCompleted()) return;
    if (this.warmupGate.isAnyWarmupRunning()) return;
    if (this.warmupGate.isWarmupRunning(connectorType, marketType)) return;

    const tsMs = Math.trunc(candle.time);
    if (
      !Number.isFinite(tsMs) ||
      tsMs < CandleWriterService.MIN_REASONABLE_TS_MS
    )
      return;

    const lockKey = `${connectorType}:${marketType}:${symbol}:${String(tf)}`;
    await this.withSeriesLock(lockKey, async () => {
      const symbolSql = this.esc(symbol);
      const intervalSql = this.esc(String(tf));
      const connectorTypeSql = this.esc(connectorType);
      const marketTypeSql = this.esc(marketType);
      const tsIso = new Date(tsMs).toISOString();
      const openSql = this.toSqlNumber(Number(candle.open));
      const highSql = this.toSqlNumber(Number(candle.high));
      const lowSql = this.toSqlNumber(Number(candle.low));
      const closeSql = this.toSqlNumber(Number(candle.close));
      const volumeSql = this.toSqlNumber(Number(candle.volume));

      const existsSql = `
        SELECT count() AS cnt
        FROM candles
        WHERE symbol='${symbolSql}'
          AND connectorType='${connectorTypeSql}'
          AND marketType='${marketTypeSql}'
          AND interval='${intervalSql}'
          AND ts = timestamp '${tsIso}'
      `;
      const rows = await this.questDbQueryService.queryAsObjects(existsSql);
      const existsCount = Number(rows?.[0]?.cnt ?? 0);
      const exists = existsCount > 0;

      if (exists && existsCount > 1) {
        const collapseSql = `
          DELETE FROM candles
          WHERE symbol='${symbolSql}'
            AND connectorType='${connectorTypeSql}'
            AND marketType='${marketTypeSql}'
            AND interval='${intervalSql}'
            AND ts = timestamp '${tsIso}'
        `;
        await this.questDbQueryService.query(collapseSql);
        const insertSingleSql = `
          INSERT INTO candles (
            symbol,
            interval,
            connectorType,
            marketType,
            open,
            high,
            low,
            close,
            volume,
            ts
          ) VALUES (
            '${symbolSql}',
            '${intervalSql}',
            '${connectorTypeSql}',
            '${marketTypeSql}',
            ${openSql},
            ${highSql},
            ${lowSql},
            ${closeSql},
            ${volumeSql},
            timestamp '${tsIso}'
          )
        `;
        await this.questDbQueryService.query(insertSingleSql);
        const seriesKeyMerge = `${symbol}:${String(
          tf,
        )}:${connectorType}:${marketType}`;
        this.logger.warn(
          `[CANDLE_PIPELINE] symbol=${symbol} interval=${String(
            tf,
          )} ts=${tsIso} source=realtime action=merge reason=duplicate removed=${
            existsCount - 1
          } seriesKey=${seriesKeyMerge}`,
        );
        return;
      }

      if (exists) {
        const updateSql = `
          UPDATE candles
          SET
            open=${openSql},
            high=${highSql},
            low=${lowSql},
            close=${closeSql},
            volume=${volumeSql}
          WHERE symbol='${symbolSql}'
            AND connectorType='${connectorTypeSql}'
            AND marketType='${marketTypeSql}'
            AND interval='${intervalSql}'
            AND ts = timestamp '${tsIso}'
        `;
        await this.questDbQueryService.query(updateSql);
        const seriesKeyUpd = `${symbol}:${String(
          tf,
        )}:${connectorType}:${marketType}`;
        if (this.warmupVerbose) {
          this.logger.log(
            `[CANDLE_PIPELINE] symbol=${symbol} interval=${String(
              tf,
            )} ts=${tsIso} source=realtime action=update reason=normal seriesKey=${seriesKeyUpd}`,
          );
        }
        return;
      }

      const insertSql = `
        INSERT INTO candles (
          symbol,
          interval,
          connectorType,
          marketType,
          open,
          high,
          low,
          close,
          volume,
          ts
        ) VALUES (
          '${symbolSql}',
          '${intervalSql}',
          '${connectorTypeSql}',
          '${marketTypeSql}',
          ${openSql},
          ${highSql},
          ${lowSql},
          ${closeSql},
          ${volumeSql},
          timestamp '${tsIso}'
        )
      `;
      await this.questDbQueryService.query(insertSql);
      const seriesKeyIns = `${symbol}:${String(
        tf,
      )}:${connectorType}:${marketType}`;
      if (this.warmupVerbose) {
        this.logger.log(
          `[CANDLE_PIPELINE] symbol=${symbol} interval=${String(
            tf,
          )} ts=${tsIso} source=realtime action=insert reason=normal seriesKey=${seriesKeyIns}`,
        );
      }
    });
  }

  // ================================================================
  // 3) Realtime batch (TCP ILP — низкий объём)
  // ================================================================
  async writeBatch(list: CandleWrite[]) {
    if (!list || !list.length) return;
    if (!this.warmupGate.isWarmupCompleted()) return;
    if (this.warmupGate.isAnyWarmupRunning()) return;

    const batch: ILPWriteOptions[] = list
      .filter((c) => {
        if (!c) return false;

        if (isInvalidOhlc(c)) return false;

        if (!Number.isFinite(c.ts)) return false;

        // 🔒 защита от 1970 / ts=0 / отрицательных дат (В Т.Ч. ДЛЯ BATCH)
        const tsMs = Math.trunc(c.ts);
        if (
          !Number.isFinite(tsMs) ||
          tsMs < CandleWriterService.MIN_REASONABLE_TS_MS
        ) {
          this.logger.warn(
            `[candles] writeBatch skipped invalid timestamp | symbol=${
              c.symbol
            } interval=${String(c.interval)} connectorType=${
              c.connectorType
            } marketType=${c.marketType} ts=${c.ts}`,
          );
          return false;
        }

        if (
          !Number.isFinite(c.open) ||
          !Number.isFinite(c.high) ||
          !Number.isFinite(c.low) ||
          !Number.isFinite(c.close) ||
          !Number.isFinite(c.volume)
        ) {
          return false;
        }

        if (this.warmupGate.isWarmupRunning(c.connectorType, c.marketType))
          return false;

        return true;
      })
      .map((c) => ({
        table: 'candles',
        keys: {
          symbol: c.symbol,
          connectorType: c.connectorType,
          marketType: c.marketType,
          interval: c.interval,
        },
        fields: {
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        },
        timestampNs: BigInt(Math.trunc(c.ts)) * 1_000_000n,
      }));

    if (!batch.length) return;
    await this.writer.writeBatch(this.CHANNEL, batch);
  }

  // ================================================================
  // 4) HISTORY: TCP ILP streaming (chunked + throttled)
  // ================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** WAL-aware adaptive chunk size (smaller when lag is high). */
  private computeChunkSize(lag: number): number {
    if (lag > 380) return 30;
    if (lag > 320) return 40;
    if (lag > 260) return 50;
    if (lag > 200) return 60;
    if (lag > 120) return 70;
    if (lag > 70) return 90;
    return 120;
  }

  /** WAL-aware adaptive delay (ms). */
  private computeDelay(lag: number): number {
    return Math.min(900, Math.max(40, Math.trunc(lag * 2.5)));
  }

  /** Throttled RESUME WAL: at most once per RESUME_WAL_THROTTLE_MS. */
  private async tryResume(logPrefix: string): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastResumeAt < CandleWriterService.RESUME_WAL_THROTTLE_MS) {
      return false;
    }
    await this.questDbQueryService.query(
      `ALTER TABLE ${this.CHANNEL} RESUME WAL`,
    );
    this.lastResumeAt = now;
    this.logger.warn(
      `${logPrefix} [WAL] ALTER TABLE ${this.CHANNEL} RESUME WAL`,
    );
    return true;
  }

  /** Write a chunk of rows over TCP ILP and flush. */
  private async writeChunk(
    chunk: ILPWriteOptions[],
    onChunkWritten?: (count: number) => void,
  ): Promise<void> {
    for (const row of chunk) {
      this.writer.write(this.CHANNEL, row);
    }
    await this.writer.flushChannel(this.CHANNEL);
    onChunkWritten?.(chunk.length);
  }

  /**
   * Stream history rows over TCP ILP with WAL-aware adaptive chunk size and delay.
   * Handles suspended: throttled resume + backoff; no write until not suspended.
   */
  private async writeHistoryTcp(
    rows: ILPWriteOptions[],
    logMeta: WarmupLogMeta,
    onChunkWritten?: (count: number) => void,
  ): Promise<void> {
    let offset = 0;
    const total = rows.length;
    const logPrefix = this.warmupPrefix(logMeta);

    while (offset < total) {
      const wal = await this.questDbQueryService.getWalState(this.CHANNEL);

      if (wal.suspended) {
        const resumed = await this.waitUntilWalUnsuspended(logMeta);
        if (!resumed) {
          throw new Error(
            `${logPrefix} WAL remains suspended after throttled retries`,
          );
        }
        continue;
      }

      const chunkSize = this.computeChunkSize(wal.lag);
      const delay = this.computeDelay(wal.lag);
      const chunk = rows.slice(offset, offset + chunkSize);

      await this.writeChunk(chunk, onChunkWritten);
      offset += chunk.length;

      this.warmupDebug(
        `${logPrefix} [WAL] lag=${wal.lag} chunk=${chunkSize} delay=${delay} offset=${offset}/${total}`,
      );

      if (offset < total) {
        await this.sleep(delay);
      }
    }

    this.warmupLog(
      `${logPrefix} [QuestDB ILP] candles TCP → ${rows.length} rows (adaptive WAL throttled)`,
    );
    if (this.warmupVerbose && rows.length > 0) {
      const firstTs =
        rows[0]?.timestampNs != null
          ? Number(rows[0].timestampNs / 1_000_000n)
          : 0;
      const lastTs =
        rows[rows.length - 1]?.timestampNs != null
          ? Number(rows[rows.length - 1]!.timestampNs! / 1_000_000n)
          : 0;
      const seriesKeyHist = `${logMeta.ctx.symbol}:${String(logMeta.ctx.tf)}:${
        logMeta.ctx.connectorType
      }:${logMeta.ctx.marketType}`;
      this.logger.log(
        `[CANDLE_PIPELINE] symbol=${logMeta.ctx.symbol} interval=${String(
          logMeta.ctx.tf,
        )} ts=${firstTs}..${lastTs} source=history action=insert reason=backfill count=${
          rows.length
        } seriesKey=${seriesKeyHist}`,
      );
    }
  }

  private async waitUntilWalUnsuspended(
    logMeta: WarmupLogMeta,
  ): Promise<boolean> {
    const logPrefix = this.warmupPrefix(logMeta);
    const maxAttempts = 10;
    let backoffMs = 200;
    let suspendedStreak = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const stateBefore = await this.questDbQueryService.getWalState(
        this.CHANNEL,
      );
      if (!stateBefore.suspended) {
        this.warmupLog(`${logPrefix} [WAL] table is healthy, continue writes`);
        return true;
      }
      suspendedStreak += 1;

      this.logger.warn(
        `${logPrefix} [WAL] suspended=true streak=${suspendedStreak} attempt=${attempt}/${maxAttempts}, sleep=${backoffMs}ms`,
      );
      await this.sleep(backoffMs);
      const canResume =
        suspendedStreak >= CandleWriterService.SUSPENDED_STREAK_FOR_RESUME;
      const resumed = canResume ? await this.tryResume(logPrefix) : false;
      if (resumed) {
        await this.sleep(CandleWriterService.RESUME_WAL_COOLDOWN_MS);
      }

      const stateAfter = await this.questDbQueryService.getWalState(
        this.CHANNEL,
      );
      if (!stateAfter.suspended) {
        this.warmupLog(
          `${logPrefix} [WAL] resumed successfully on attempt=${attempt}, lag=${stateAfter.lag}`,
        );
        return true;
      }

      backoffMs = Math.min(2000, backoffMs * 2);
    }

    this.logger.error(
      `${logPrefix} [WAL] suspended remained true after ${maxAttempts} attempts`,
    );
    return false;
  }

  async bulkInsertHistory(
    symbol: string,
    interval: TimeFrame,
    connectorType: string,
    marketType: string,
    candles: Candle[],
    logMeta?: WarmupLogMeta,
  ) {
    if (!candles || !candles.length) return;
    const ctx =
      logMeta?.ctx ??
      ({
        symbol,
        tf: interval,
        connectorType,
        marketType,
      } as const);
    const meta = logMeta ?? { opId: this.createWarmupOpId(), ctx };
    const logPrefix = this.warmupPrefix(meta);

    const validated: Candle[] = [];
    const rejected: { candle: Candle; reason: string }[] = [];
    for (const c of candles) {
      if (!c) continue;

      const result = validateHistoryCandle(c);

      if (result.ok && c.time >= CandleWriterService.MIN_REASONABLE_TS_MS) {
        validated.push(c);
      } else {
        rejected.push({
          candle: c,
          reason: result.ok ? 'timestamp before 2000' : result.reason,
        });
      }
    }

    if (rejected.length > 0) {
      this.logger.warn(
        `${logPrefix} bulkInsertHistory rejected=${rejected.length} invalid candles`,
      );
      rejected.slice(0, 5).forEach(({ candle, reason }, idx) => {
        this.logger.warn(
          `${logPrefix} rejected[${idx}] ${reason} | time=${
            candle.time
          } ts=${new Date(candle.time).toISOString()} o=${candle.open} h=${
            candle.high
          } l=${candle.low} c=${candle.close} v=${candle.volume}`,
        );
      });
      if (rejected.length > 5) {
        this.logger.warn(
          `${logPrefix} ... and ${rejected.length - 5} more rejected.`,
        );
      }
    }

    if (!validated.length) return;

    // Было: dedupe только по time.
    // Стало: безопасный dedupe по (series + time) и с сохранением сортировки.
    const { deduped, removed } = this.dedupeHistoryCandles(
      validated,
      ctx.symbol,
      ctx.tf,
      ctx.connectorType,
      ctx.marketType,
    );

    if (removed > 0) {
      this.logger.warn(
        `${logPrefix} bulkInsertHistory removed duplicates=${removed}`,
      );
    }

    const lockKey = `${ctx.connectorType}:${ctx.marketType}:${
      ctx.symbol
    }:${String(ctx.tf)}`;
    await this.withSeriesLock(lockKey, async () => {
      this.warmupLog(
        `${logPrefix} bulkInsertHistory candles=${deduped.length} (TCP ILP, adaptive WAL chunking)`,
      );

      this.warmupProgress.register(ctx.symbol, ctx.tf, deduped.length);

      const rows: ILPWriteOptions[] = deduped.map((c) => ({
        table: 'candles',
        keys: {
          symbol: ctx.symbol,
          interval: ctx.tf,
          connectorType: ctx.connectorType,
          marketType: ctx.marketType,
        },
        fields: {
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        },
        timestampNs: BigInt(Math.trunc(c.time)) * 1_000_000n,
      }));

      const batchCount = Math.ceil(
        deduped.length / CandleWriterService.CHUNK_MIN,
      );
      const batchSnapshots: {
        batchIndex: number;
        rowCount: number;
        first: Record<string, number | string>;
        last: Record<string, number | string>;
      }[] = [];
      if (deduped.length > 0) {
        const firstChunk = deduped.slice(0, CandleWriterService.CHUNK_MAX);
        batchSnapshots.push({
          batchIndex: 0,
          rowCount: firstChunk.length,
          first: candleToLogRow(firstChunk[0]!),
          last: candleToLogRow(firstChunk[firstChunk.length - 1]!),
        });
        if (batchCount > 1) {
          const lastChunk = deduped.slice(
            Math.max(0, deduped.length - CandleWriterService.CHUNK_MAX),
            deduped.length,
          );
          if (lastChunk.length > 0) {
            batchSnapshots.push({
              batchIndex: batchCount - 1,
              rowCount: lastChunk.length,
              first: candleToLogRow(lastChunk[0]!),
              last: candleToLogRow(lastChunk[lastChunk.length - 1]!),
            });
          }
        }
      }

      try {
        await this.writeHistoryTcp(rows, meta, (count) =>
          this.warmupProgress.increment(ctx.symbol, ctx.tf, count),
        );
      } finally {
        this.warmupProgress.stop(ctx.symbol, ctx.tf);
      }

      await this.ddlService.checkCandlesSuspendedAndExitIfNeeded({
        symbol: ctx.symbol,
        interval: String(ctx.tf),
        connectorType: ctx.connectorType,
        marketType: ctx.marketType,
        totalRows: deduped.length,
        batchCount,
        firstTsIso: deduped[0]
          ? new Date(deduped[0].time).toISOString()
          : undefined,
        lastTsIso: deduped.length
          ? new Date(deduped[deduped.length - 1].time).toISOString()
          : undefined,
        batchSnapshots,
      });
    });
  }
}
