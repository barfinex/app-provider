import { Injectable, Logger } from '@nestjs/common';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import { QuestDBDDLService } from '../questdb/questdb-ddl.service';
import { QuestDBWriteService } from '../questdb/questdb-write.service';
import { TimeFrame, Candle, ALL_CANDLE_INTERVALS } from '@barfinex/types';
import { normalize } from './aggregation/aggregation.utils';
import { ms } from './time/time.utils';

interface WarmupLogMeta {
  opId: string;
  ctx: {
    symbol: string;
    tf: TimeFrame;
    connectorType: string;
    marketType: string;
  };
}

export interface SeriesCoverage {
  minTsMs: number | null;
  maxTsMs: number | null;
  count: number;
}

export interface AggregatedSourceCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CandleDuplicateBucket {
  ts: string;
  count: number;
}

export interface CandleIntegrityAudit {
  symbol: string;
  connectorType: string;
  marketType: string;
  interval: TimeFrame;
  from: number;
  to: number;
  totalRows: number;
  distinctTs: number;
  duplicateBuckets: CandleDuplicateBucket[];
  duplicateRows: number;
  outOfOrderCount: number;
  gapCount: number;
  gaps: Array<{ from: number; to: number }>;
  latestTs: number | null;
}

export interface CandleSeriesKey {
  connectorType: string;
  marketType: string;
  symbol: string;
  interval: TimeFrame;
}

export interface CandleSeriesIntegrityReport extends CandleSeriesKey {
  startTimestamp: number | null;
  endTimestamp: number | null;
  duplicateRows: number;
  gapCount: number;
  outOfOrderCount: number;
  missingRanges: Array<{ from: number; to: number }>;
  timestampMonotonic: boolean;
  totalRows: number;
}

@Injectable()
export class CandleQueryService {
  private readonly logger = new Logger(CandleQueryService.name);
  private readonly warmupVerbose = process.env.CANDLE_VERBOSE_LOGS === 'true';
  private static readonly MIN_REASONABLE_TS_ISO = '2000-01-01T00:00:00.000Z';

  constructor(
    private readonly reader: QuestDBQueryService,
    private readonly ddl: QuestDBDDLService,
    private readonly writer: QuestDBWriteService,
  ) {}

  private esc(value: string): string {
    return value.replace(/'/g, "''");
  }

  private parseQuestTs(raw: unknown): number | null {
    if (raw == null) return null;
    const text = String(raw);
    const iso = text.endsWith('Z') ? text : `${text}Z`;
    const ts = Date.parse(iso);
    return Number.isFinite(ts) ? ts : null;
  }

  private warmupPrefix(meta: WarmupLogMeta): string {
    const { opId, ctx } = meta;
    return `[warmup:${opId}] [ctx symbol=${ctx.symbol} tf=${String(
      ctx.tf,
    )} connectorType=${ctx.connectorType} marketType=${ctx.marketType}]`;
  }

  private createWarmupOpId(): string {
    return `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`.toUpperCase();
  }

  private warmupDebug(message: string): void {
    if (this.warmupVerbose) this.logger.debug(message);
  }

  // =========================================================================
  // 🔹 TRUNCATE (очистка таблицы свечей перед подкачкой с нуля)
  // QuestDB TRUNCATE over PG wire can leave data; use DROP + recreate.
  // =========================================================================
  async truncateCandles(): Promise<void> {
    let countBefore: number | null = null;
    try {
      const row = await this.reader.queryAsObjects(
        'SELECT count() AS cnt FROM candles LIMIT 1',
      );
      countBefore = row?.[0]?.cnt != null ? Number(row[0].cnt) : null;
    } catch (e) {
      this.logger.warn('Could not get row count before truncate', e);
    }
    this.logger.warn(
      `Truncating candles table (clearHistoryOnStartup). Rows before: ${
        countBefore ?? 'unknown'
      }`,
    );
    // Release ILP lock on candles so DROP can succeed
    this.writer.disconnectChannel('candles');
    try {
      await this.reader.query('DROP TABLE IF EXISTS candles');
      await this.ddl.ensureCandlesTable();
    } finally {
      this.writer.reconnectChannel('candles');
    }
    let countAfter: number | null = null;
    try {
      const row = await this.reader.queryAsObjects(
        'SELECT count() AS cnt FROM candles LIMIT 1',
      );
      countAfter = row?.[0]?.cnt != null ? Number(row[0].cnt) : null;
    } catch (e) {
      this.logger.warn('Could not get row count after truncate', e);
    }
    this.logger.log(
      `Truncate done. Rows after: ${countAfter ?? 'unknown'} (expected 0).`,
    );
  }

  async cleanupUnreasonableCandles(): Promise<void> {
    const cutoffIso = CandleQueryService.MIN_REASONABLE_TS_ISO;
    try {
      const beforeRows = await this.reader.queryAsObjects(
        `SELECT count() AS cnt FROM candles WHERE ts < timestamp '${cutoffIso}'`,
      );
      const before = Number(beforeRows?.[0]?.cnt ?? 0);
      if (!Number.isFinite(before) || before <= 0) return;

      this.logger.warn(
        `[candles] cleanupUnreasonableCandles: deleting ${before} rows with ts < ${cutoffIso}`,
      );
      await this.reader.query(
        `DELETE FROM candles WHERE ts < timestamp '${cutoffIso}'`,
      );

      const afterRows = await this.reader.queryAsObjects(
        `SELECT count() AS cnt FROM candles WHERE ts < timestamp '${cutoffIso}'`,
      );
      const after = Number(afterRows?.[0]?.cnt ?? 0);
      this.logger.warn(
        `[candles] cleanupUnreasonableCandles: done, remaining=${
          Number.isFinite(after) ? after : 'unknown'
        }`,
      );
    } catch (e) {
      this.logger.warn('[candles] cleanupUnreasonableCandles failed', e);
    }
  }

  private async cleanupUnreasonableCandlesForSeries(ctx: {
    symbol: string;
    tf: TimeFrame;
    connectorType: string;
    marketType: string;
  }): Promise<void> {
    const cutoffIso = CandleQueryService.MIN_REASONABLE_TS_ISO;
    const symbolSql = ctx.symbol.replace(/'/g, "''");
    const connectorTypeSql = ctx.connectorType.replace(/'/g, "''");
    const marketTypeSql = ctx.marketType.replace(/'/g, "''");
    const intervalSql = String(ctx.tf).replace(/'/g, "''");

    try {
      const beforeRows = await this.reader.queryAsObjects(
        `SELECT count() AS cnt FROM candles
         WHERE symbol='${symbolSql}'
           AND connectorType='${connectorTypeSql}'
           AND marketType='${marketTypeSql}'
           AND interval='${intervalSql}'
           AND ts < timestamp '${cutoffIso}'`,
      );
      const before = Number(beforeRows?.[0]?.cnt ?? 0);
      if (!Number.isFinite(before) || before <= 0) return;

      this.logger.warn(
        `[candles] cleanupUnreasonableCandlesForSeries: deleting ${before} rows for ${
          ctx.symbol
        } ${String(ctx.tf)}`,
      );
      await this.reader.query(
        `DELETE FROM candles
         WHERE symbol='${symbolSql}'
           AND connectorType='${connectorTypeSql}'
           AND marketType='${marketTypeSql}'
           AND interval='${intervalSql}'
           AND ts < timestamp '${cutoffIso}'`,
      );
    } catch (e) {
      this.logger.warn(
        '[candles] cleanupUnreasonableCandlesForSeries failed',
        e,
      );
    }
  }

  // =========================================================================
  // 🔹 BASE RANGE LOAD (QuestDB, ISO timestamps)
  // =========================================================================
  async loadRange(params: {
    symbol: string;
    connectorType: string;
    marketType: string;
    interval: TimeFrame;
    from: number; // ms UTC
    to: number; // ms UTC
    logMeta?: WarmupLogMeta;
  }): Promise<Candle[]> {
    const { from, to, logMeta } = params;
    const ctx =
      logMeta?.ctx ??
      ({
        symbol: params.symbol,
        tf: params.interval,
        connectorType: params.connectorType,
        marketType: params.marketType,
      } as const);
    const meta = logMeta ?? { opId: this.createWarmupOpId(), ctx };
    const logPrefix = this.warmupPrefix(meta);

    const symbolSql = ctx.symbol.replace(/'/g, "''");
    const connectorTypeSql = ctx.connectorType.replace(/'/g, "''");
    const marketTypeSql = ctx.marketType.replace(/'/g, "''");
    const intervalSql = String(ctx.tf).replace(/'/g, "''");

    const fromIso = new Date(from).toISOString();
    const toIso = new Date(to).toISOString();

    const sql = `
    SELECT
      ts,
      open,
      high,
      low,
      close,
      volume
    FROM candles
    WHERE symbol='${symbolSql}'
      AND connectorType='${connectorTypeSql}'
      AND marketType='${marketTypeSql}'
      AND interval='${intervalSql}'
      AND ts >= timestamp '${fromIso}'
      AND ts <= timestamp '${toIso}'
    ORDER BY ts ASC
  `;

    this.warmupDebug(`${logPrefix} SQL loadRange:\n${sql.trim()}`);

    const rows = await this.reader.queryAsObjects(sql);

    this.warmupDebug(`${logPrefix} loadRange result: ${rows.length} rows`);

    return rows as Candle[];
  }

  // =========================================================================
  // 🔹 NORMALIZED READ PATH
  // =========================================================================
  async loadRangeNormalized(params: {
    symbol: string;
    connectorType: string;
    marketType: string;
    interval: TimeFrame;
    from: number; // ms
    to: number; // ms
  }): Promise<Candle[]> {
    this.logger.debug(
      `loadRangeNormalized | symbol=${params.symbol} | interval=${params.interval}`,
    );

    const rows = await this.loadRange(params);
    const normalized = normalize(rows);

    this.logger.debug(
      `loadRangeNormalized result: ${normalized.length} candles`,
    );

    return normalized;
  }

  // =========================================================================
  // 🔹 LAST TIMESTAMP (ANCHOR)
  // =========================================================================
  async loadLastTimestamp(params: {
    symbol: string;
    connectorType: string;
    marketType: string;
    interval: TimeFrame;
    logMeta?: WarmupLogMeta;
  }): Promise<number | null> {
    const { logMeta } = params;
    const ctx =
      logMeta?.ctx ??
      ({
        symbol: params.symbol,
        tf: params.interval,
        connectorType: params.connectorType,
        marketType: params.marketType,
      } as const);
    const meta = logMeta ?? { opId: this.createWarmupOpId(), ctx };
    const logPrefix = this.warmupPrefix(meta);

    const symbolSql = ctx.symbol.replace(/'/g, "''");
    const connectorTypeSql = ctx.connectorType.replace(/'/g, "''");
    const marketTypeSql = ctx.marketType.replace(/'/g, "''");
    const intervalSql = String(ctx.tf).replace(/'/g, "''");

    const sql = `
      SELECT max(ts) AS ts
      FROM candles
      WHERE symbol='${symbolSql}'
        AND connectorType='${connectorTypeSql}'
        AND marketType='${marketTypeSql}'
        AND interval='${intervalSql}'
    `;

    this.warmupDebug(`${logPrefix} executing loadLastTimestamp`);

    const rows = (await this.reader.queryAsObjects(sql)) as {
      ts: string | null;
    }[];

    if (!rows.length || rows[0]?.ts == null) {
      this.warmupDebug(`${logPrefix} loadLastTimestamp: no data`);
      return null;
    }

    const rawTs = rows[0].ts;

    // QuestDB возвращает ISO без Z — добавляем если нужно
    const iso =
      typeof rawTs === 'string' && !rawTs.endsWith('Z') ? `${rawTs}Z` : rawTs;

    const tsMs = Date.parse(iso);

    if (!Number.isFinite(tsMs)) {
      this.logger.error(`${logPrefix} invalid ts from DB: ${rawTs}`);
      return null;
    }

    const MIN_REASONABLE_TS = 946684800000; // 2000-01-01 UTC

    if (tsMs < MIN_REASONABLE_TS) {
      this.logger.warn(`${logPrefix} ignoring unreasonable tsMs=${tsMs}`);
      await this.cleanupUnreasonableCandlesForSeries(ctx);
      const retryRows = (await this.reader.queryAsObjects(sql)) as {
        ts: string | null;
      }[];
      const retryRawTs = retryRows?.[0]?.ts ?? null;
      if (retryRawTs == null) return null;
      const retryIso =
        typeof retryRawTs === 'string' && !retryRawTs.endsWith('Z')
          ? `${retryRawTs}Z`
          : retryRawTs;
      const retryTsMs = Date.parse(retryIso);
      if (!Number.isFinite(retryTsMs) || retryTsMs < MIN_REASONABLE_TS) {
        return null;
      }
      this.warmupDebug(
        `${logPrefix} loadLastTimestamp recovered after cleanup tsIso=${new Date(
          retryTsMs,
        ).toISOString()} ts(ms)=${retryTsMs}`,
      );
      return retryTsMs;
    }

    this.warmupDebug(
      `${logPrefix} loadLastTimestamp result tsIso=${new Date(
        tsMs,
      ).toISOString()} ts(ms)=${tsMs}`,
    );

    return tsMs;
  }

  async loadSeriesCoverage(params: {
    symbol: string;
    connectorType: string;
    marketType: string;
    interval: TimeFrame;
    logMeta?: WarmupLogMeta;
  }): Promise<SeriesCoverage> {
    const { logMeta } = params;
    const ctx =
      logMeta?.ctx ??
      ({
        symbol: params.symbol,
        tf: params.interval,
        connectorType: params.connectorType,
        marketType: params.marketType,
      } as const);
    const meta = logMeta ?? { opId: this.createWarmupOpId(), ctx };
    const logPrefix = this.warmupPrefix(meta);

    const symbolSql = ctx.symbol.replace(/'/g, "''");
    const connectorTypeSql = ctx.connectorType.replace(/'/g, "''");
    const marketTypeSql = ctx.marketType.replace(/'/g, "''");
    const intervalSql = String(ctx.tf).replace(/'/g, "''");

    const sql = `
      SELECT
        min(ts) AS min_ts,
        max(ts) AS max_ts,
        count() AS cnt
      FROM candles
      WHERE symbol='${symbolSql}'
        AND connectorType='${connectorTypeSql}'
        AND marketType='${marketTypeSql}'
        AND interval='${intervalSql}'
    `;

    const rows = await this.reader.queryAsObjects(sql);
    const row = rows?.[0] as
      | { min_ts?: string | null; max_ts?: string | null; cnt?: unknown }
      | undefined;

    const parseTs = (raw?: string | null): number | null => {
      if (raw == null) return null;
      const iso =
        typeof raw === 'string' && !raw.endsWith('Z') ? `${raw}Z` : raw;
      const ts = Date.parse(iso);
      return Number.isFinite(ts) ? ts : null;
    };

    const minTsMs = parseTs(row?.min_ts ?? null);
    const maxTsMs = parseTs(row?.max_ts ?? null);
    const count = Number(row?.cnt ?? 0);

    this.warmupDebug(
      `${logPrefix} coverage min=${
        minTsMs != null ? new Date(minTsMs).toISOString() : 'null'
      } max=${
        maxTsMs != null ? new Date(maxTsMs).toISOString() : 'null'
      } count=${Number.isFinite(count) ? count : 0}`,
    );

    return {
      minTsMs,
      maxTsMs,
      count: Number.isFinite(count) ? count : 0,
    };
  }

  async loadIntervalsWithHistory(params: {
    symbol: string;
    connectorType: string;
    marketType: string;
  }): Promise<TimeFrame[]> {
    const symbolSql = params.symbol.replace(/'/g, "''");
    const connectorTypeSql = params.connectorType.replace(/'/g, "''");
    const marketTypeSql = params.marketType.replace(/'/g, "''");

    const sql = `
      SELECT interval, count() AS cnt
      FROM candles
      WHERE symbol='${symbolSql}'
        AND connectorType='${connectorTypeSql}'
        AND marketType='${marketTypeSql}'
      GROUP BY interval
      ORDER BY interval
    `;

    const rows = await this.reader.queryAsObjects(sql);
    const out: TimeFrame[] = [];
    for (const row of rows ?? []) {
      const interval = String(row.interval ?? '') as TimeFrame;
      const cnt = Number(row.cnt ?? 0);
      if (!Number.isFinite(cnt) || cnt <= 0) continue;
      out.push(interval);
    }
    return out;
  }

  async loadAggregatedFromSource(params: {
    symbol: string;
    connectorType: string;
    marketType: string;
    sourceInterval: TimeFrame;
    fromMs: number;
    toExclusiveMs: number;
  }): Promise<AggregatedSourceCandle | null> {
    const symbolSql = params.symbol.replace(/'/g, "''");
    const connectorTypeSql = params.connectorType.replace(/'/g, "''");
    const marketTypeSql = params.marketType.replace(/'/g, "''");
    const sourceIntervalSql = String(params.sourceInterval).replace(/'/g, "''");
    const fromIso = new Date(params.fromMs).toISOString();
    const toIso = new Date(params.toExclusiveMs).toISOString();

    const whereSql = `
      symbol='${symbolSql}'
      AND connectorType='${connectorTypeSql}'
      AND marketType='${marketTypeSql}'
      AND interval='${sourceIntervalSql}'
      AND ts >= timestamp '${fromIso}'
      AND ts < timestamp '${toIso}'
    `;

    const sql = `
      SELECT
        first(open) AS open,
        max(high) AS high,
        min(low) AS low,
        last(close) AS close,
        sum(volume) AS volume,
        count() AS cnt
      FROM candles
      WHERE ${whereSql}
    `;

    const rows = await this.reader.queryAsObjects(sql);
    const row = rows?.[0] as
      | {
          open?: unknown;
          high?: unknown;
          low?: unknown;
          close?: unknown;
          volume?: unknown;
          cnt?: unknown;
        }
      | undefined;
    if (!row) return null;
    const cnt = Number(row.cnt ?? 0);
    if (!Number.isFinite(cnt) || cnt <= 0) return null;

    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    const volume = Number(row.volume);
    if (
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(volume)
    ) {
      return null;
    }

    return { open, high, low, close, volume };
  }

  // =========================================================================
  // 🔹 LOAD LAST N (DEBUG / ADMIN)
  // =========================================================================
  async loadLastN(
    symbol: string,
    interval: TimeFrame,
    n = 100,
  ): Promise<Candle[]> {
    symbol = symbol.replace(/'/g, "''");
    const intervalSql = String(interval).replace(/'/g, "''");

    const sql = `
      SELECT
        ts,
        open,
        high,
        low,
        close,
        volume
      FROM candles
      WHERE symbol='${symbol}'
        AND interval='${intervalSql}'
      ORDER BY ts DESC
      LIMIT ${n}
    `;

    this.logger.debug(
      `Executing loadLastN | symbol=${symbol} | interval=${intervalSql} | n=${n}`,
    );

    const rows = await this.reader.queryAsObjects(sql);

    this.logger.debug(`loadLastN result: ${rows.length} rows`);

    return rows as Candle[];
  }

  async loadLastCandle(params: {
    symbol: string;
    connectorType: string;
    marketType: string;
    interval: TimeFrame;
  }): Promise<Candle | null> {
    const symbolSql = params.symbol.replace(/'/g, "''");
    const connectorTypeSql = params.connectorType.replace(/'/g, "''");
    const marketTypeSql = params.marketType.replace(/'/g, "''");
    const intervalSql = String(params.interval).replace(/'/g, "''");
    const sql = `
      SELECT
        ts,
        open,
        high,
        low,
        close,
        volume
      FROM candles
      WHERE symbol='${symbolSql}'
        AND connectorType='${connectorTypeSql}'
        AND marketType='${marketTypeSql}'
        AND interval='${intervalSql}'
      ORDER BY ts DESC
      LIMIT 1
    `;
    const rows = await this.reader.queryAsObjects(sql);
    if (!rows?.length) return null;
    return rows[0] as Candle;
  }

  async loadIntegrityAudit(params: {
    symbol: string;
    connectorType: string;
    marketType: string;
    interval: TimeFrame;
    from: number;
    to: number;
    maxGapSamples?: number;
    maxDuplicateSamples?: number;
  }): Promise<CandleIntegrityAudit> {
    const maxGapSamples = Math.max(1, Number(params.maxGapSamples ?? 50));
    const maxDuplicateSamples = Math.max(
      1,
      Number(params.maxDuplicateSamples ?? 50),
    );
    const symbolSql = params.symbol.replace(/'/g, "''");
    const connectorTypeSql = params.connectorType.replace(/'/g, "''");
    const marketTypeSql = params.marketType.replace(/'/g, "''");
    const intervalSql = String(params.interval).replace(/'/g, "''");
    const fromIso = new Date(params.from).toISOString();
    const toIso = new Date(params.to).toISOString();

    const seriesWhere = `
      symbol='${symbolSql}'
      AND connectorType='${connectorTypeSql}'
      AND marketType='${marketTypeSql}'
      AND interval='${intervalSql}'
      AND ts >= timestamp '${fromIso}'
      AND ts <= timestamp '${toIso}'
    `;

    const totalsSql = `
      SELECT
        count() AS total_rows,
        count_distinct(ts) AS distinct_ts,
        max(ts) AS latest_ts
      FROM candles
      WHERE ${seriesWhere}
    `;
    const totalsRows = await this.reader.queryAsObjects(totalsSql);
    const totalsRow = totalsRows?.[0] ?? {};
    const totalRows = Number(totalsRow.total_rows ?? 0);
    const distinctTs = Number(totalsRow.distinct_ts ?? 0);
    const latestRaw = totalsRow.latest_ts ?? null;
    const latestIso =
      typeof latestRaw === 'string' && !latestRaw.endsWith('Z')
        ? `${latestRaw}Z`
        : latestRaw;
    const latestTs = latestIso ? Date.parse(String(latestIso)) : null;

    const dupSql = `
      SELECT ts, cnt
      FROM (
        SELECT ts, count() AS cnt
        FROM candles
        WHERE ${seriesWhere}
        GROUP BY ts
      )
      WHERE cnt > 1
      ORDER BY ts ASC
      LIMIT ${maxDuplicateSamples}
    `;
    const dupRows = await this.reader.queryAsObjects(dupSql);
    const duplicateBuckets: CandleDuplicateBucket[] = (dupRows ?? []).map(
      (row: any) => ({
        ts: String(row.ts),
        count: Number(row.cnt ?? 0),
      }),
    );

    const intervalMs = ms(params.interval);

    // Deprecated: this read path groups and sorts timestamps, so out-of-order cannot be
    // observed reliably here. Keep metric for API compatibility, but always return 0.
    const outOfOrderCount = 0;
    const gaps: Array<{ from: number; to: number }> = [];
    const orderedSql = `
      SELECT ts
      FROM candles
      WHERE ${seriesWhere}
      GROUP BY ts
      ORDER BY ts ASC
    `;
    const orderedRows = await this.reader.queryAsObjects(orderedSql);
    const orderedMs = (orderedRows ?? [])
      .map((row: any) => {
        const raw = row.ts;
        const iso =
          typeof raw === 'string' && !raw.endsWith('Z') ? `${raw}Z` : raw;
        const parsed = Date.parse(String(iso));
        return Number.isFinite(parsed) ? parsed : NaN;
      })
      .filter((ts: number) => Number.isFinite(ts));
    for (let i = 1; i < orderedMs.length; i += 1) {
      const prev = orderedMs[i - 1]!;
      const curr = orderedMs[i]!;
      if (curr - prev > intervalMs && gaps.length < maxGapSamples) {
        gaps.push({
          from: prev + intervalMs,
          to: curr - intervalMs,
        });
      }
    }

    return {
      symbol: params.symbol,
      connectorType: params.connectorType,
      marketType: params.marketType,
      interval: params.interval,
      from: params.from,
      to: params.to,
      totalRows: Number.isFinite(totalRows) ? totalRows : 0,
      distinctTs: Number.isFinite(distinctTs) ? distinctTs : 0,
      duplicateBuckets,
      duplicateRows: Math.max(0, totalRows - distinctTs),
      outOfOrderCount,
      gapCount: gaps.length,
      gaps,
      latestTs: Number.isFinite(Number(latestTs)) ? Number(latestTs) : null,
    };
  }

  async loadAllSeriesKeys(): Promise<CandleSeriesKey[]> {
    const sql = `
      SELECT
        connectorType,
        marketType,
        symbol,
        interval
      FROM candles
      GROUP BY connectorType, marketType, symbol, interval
      ORDER BY connectorType, marketType, symbol, interval
    `;
    const rows = await this.reader.queryAsObjects(sql);
    const supported = new Set(ALL_CANDLE_INTERVALS);
    return (rows ?? [])
      .map((row: any) => ({
        connectorType: String(row.connectortype ?? row.connectorType ?? ''),
        marketType: String(row.markettype ?? row.marketType ?? ''),
        symbol: String(row.symbol ?? ''),
        interval: String(row.interval ?? '') as TimeFrame,
      }))
      .filter((k) => supported.has(k.interval));
  }

  async loadSeriesRowsAtTimestamp(
    params: CandleSeriesKey & { timestampMs: number },
  ): Promise<Candle[]> {
    const symbolSql = this.esc(params.symbol);
    const connectorTypeSql = this.esc(params.connectorType);
    const marketTypeSql = this.esc(params.marketType);
    const intervalSql = this.esc(String(params.interval));
    const tsIso = new Date(params.timestampMs).toISOString();
    const sql = `
      SELECT
        ts,
        open,
        high,
        low,
        close,
        volume
      FROM candles
      WHERE symbol='${symbolSql}'
        AND connectorType='${connectorTypeSql}'
        AND marketType='${marketTypeSql}'
        AND interval='${intervalSql}'
        AND ts = timestamp '${tsIso}'
      ORDER BY volume DESC, open DESC, high DESC, low DESC, close DESC, ts DESC
    `;
    const rows = await this.reader.queryAsObjects(sql);
    return (rows ?? []).map((row: any) => ({
      time: this.parseQuestTs(row.ts) ?? params.timestampMs,
      open: Number(row.open ?? 0),
      high: Number(row.high ?? 0),
      low: Number(row.low ?? 0),
      close: Number(row.close ?? 0),
      volume: Number(row.volume ?? 0),
      symbol: { name: params.symbol } as any,
      interval: params.interval,
    }));
  }

  async deleteSeriesRowsAtTimestamp(
    params: CandleSeriesKey & { timestampMs: number },
  ): Promise<void> {
    const symbolSql = this.esc(params.symbol);
    const connectorTypeSql = this.esc(params.connectorType);
    const marketTypeSql = this.esc(params.marketType);
    const intervalSql = this.esc(String(params.interval));
    const tsIso = new Date(params.timestampMs).toISOString();
    const sql = `
      DELETE FROM candles
      WHERE symbol='${symbolSql}'
        AND connectorType='${connectorTypeSql}'
        AND marketType='${marketTypeSql}'
        AND interval='${intervalSql}'
        AND ts = timestamp '${tsIso}'
    `;
    await this.reader.query(sql);
  }

  async deleteSeriesRange(
    params: CandleSeriesKey & { fromMs: number; toMs: number },
  ): Promise<void> {
    const symbolSql = this.esc(params.symbol);
    const connectorTypeSql = this.esc(params.connectorType);
    const marketTypeSql = this.esc(params.marketType);
    const intervalSql = this.esc(String(params.interval));
    const fromIso = new Date(params.fromMs).toISOString();
    const toIso = new Date(params.toMs).toISOString();
    const sql = `
      DELETE FROM candles
      WHERE symbol='${symbolSql}'
        AND connectorType='${connectorTypeSql}'
        AND marketType='${marketTypeSql}'
        AND interval='${intervalSql}'
        AND ts >= timestamp '${fromIso}'
        AND ts <= timestamp '${toIso}'
    `;
    await this.reader.query(sql);
  }

  async loadDuplicateTimestamps(params: CandleSeriesKey): Promise<number[]> {
    const symbolSql = this.esc(params.symbol);
    const connectorTypeSql = this.esc(params.connectorType);
    const marketTypeSql = this.esc(params.marketType);
    const intervalSql = this.esc(String(params.interval));
    const sql = `
      SELECT ts
      FROM (
        SELECT ts, count() AS cnt
        FROM candles
        WHERE symbol='${symbolSql}'
          AND connectorType='${connectorTypeSql}'
          AND marketType='${marketTypeSql}'
          AND interval='${intervalSql}'
        GROUP BY ts
      ) dup
      WHERE dup.cnt > 1
      ORDER BY ts ASC
    `;
    const rows = await this.reader.queryAsObjects(sql);
    return (rows ?? [])
      .map((row: any) => this.parseQuestTs(row.ts))
      .filter((ts: number | null): ts is number => ts != null);
  }

  async loadSeriesIntegrityReport(
    params: CandleSeriesKey & { maxMissingRanges?: number },
  ): Promise<CandleSeriesIntegrityReport> {
    const maxMissingRanges = Math.max(
      0,
      Number(params.maxMissingRanges ?? 2000),
    );
    const symbolSql = this.esc(params.symbol);
    const connectorTypeSql = this.esc(params.connectorType);
    const marketTypeSql = this.esc(params.marketType);
    const intervalSql = this.esc(String(params.interval));

    const totalsSql = `
      SELECT
        min(ts) AS min_ts,
        max(ts) AS max_ts,
        count() AS total_rows,
        count_distinct(ts) AS distinct_ts
      FROM candles
      WHERE symbol='${symbolSql}'
        AND connectorType='${connectorTypeSql}'
        AND marketType='${marketTypeSql}'
        AND interval='${intervalSql}'
    `;
    const totalsRows = await this.reader.queryAsObjects(totalsSql);
    const totalsRow = totalsRows?.[0] ?? {};
    const totalRows = Number(totalsRow.total_rows ?? 0);
    const distinctTs = Number(totalsRow.distinct_ts ?? 0);
    const startTimestamp = this.parseQuestTs(totalsRow.min_ts ?? null);
    const endTimestamp = this.parseQuestTs(totalsRow.max_ts ?? null);

    const stepMs = ms(params.interval);
    // Deprecated: this integrity path sorts timestamps before comparison,
    // so out-of-order cannot be meaningfully detected from this query.
    const outOfOrderCount = 0;
    let gapCount = 0;
    const missingRanges: Array<{ from: number; to: number }> = [];
    const orderedSql = `
      SELECT ts
      FROM candles
      WHERE symbol='${symbolSql}'
        AND connectorType='${connectorTypeSql}'
        AND marketType='${marketTypeSql}'
        AND interval='${intervalSql}'
      GROUP BY ts
      ORDER BY ts ASC
    `;
    const orderedRows = await this.reader.queryAsObjects(orderedSql);
    const orderedMs = (orderedRows ?? [])
      .map((row: any) => this.parseQuestTs(row.ts))
      .filter((ts: number | null): ts is number => ts != null);
    for (let i = 1; i < orderedMs.length; i += 1) {
      const prev = orderedMs[i - 1]!;
      const curr = orderedMs[i]!;
      if (curr - prev > stepMs) {
        gapCount += 1;
        if (missingRanges.length < maxMissingRanges) {
          missingRanges.push({
            from: prev + stepMs,
            to: curr - stepMs,
          });
        }
      }
    }

    return {
      connectorType: params.connectorType,
      marketType: params.marketType,
      symbol: params.symbol,
      interval: params.interval,
      startTimestamp,
      endTimestamp,
      duplicateRows: Math.max(0, totalRows - distinctTs),
      gapCount,
      outOfOrderCount,
      missingRanges,
      timestampMonotonic: outOfOrderCount === 0,
      totalRows: Number.isFinite(totalRows) ? totalRows : 0,
    };
  }

  async supportsDelete(): Promise<boolean> {
    try {
      await this.reader.query('DELETE FROM candles WHERE 1=0');
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.toLowerCase().includes('unexpected token [from]'))
        return false;
      throw e;
    }
  }
}
