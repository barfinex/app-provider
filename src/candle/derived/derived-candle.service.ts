import { Injectable, Logger } from '@nestjs/common';
import { TimeFrame } from '@barfinex/types';

import { QuestDBQueryService } from '../../questdb/questdb-query.service';

interface DerivedRangeParams {
  symbol: string;
  connectorType: string;
  marketType: string;
  interval: TimeFrame.week | TimeFrame.month;
  fromMs: number;
  toMs: number;
}

interface RecomputeBucketParams {
  symbol: string;
  connectorType: string;
  marketType: string;
  dayTsMs: number;
}

type LowerInterval = TimeFrame.day | TimeFrame.h4 | TimeFrame.h1;
interface AggregatedBucketRow {
  bucket: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

@Injectable()
export class DerivedCandleService {
  private readonly logger = new Logger(DerivedCandleService.name);
  private readonly derivedVerbose = process.env.CANDLE_VERBOSE_LOGS === 'true';

  constructor(private readonly query: QuestDBQueryService) {}

  private derivedLog(message: string): void {
    if (this.derivedVerbose) this.logger.log(message);
  }

  private esc(value: string): string {
    return value.replace(/'/g, "''");
  }

  private toIso(tsMs: number): string {
    return new Date(tsMs).toISOString();
  }

  private weekStartUtc(tsMs: number): number {
    const d = new Date(tsMs);
    const day = d.getUTCDay(); // 0=Sun ... 6=Sat
    const shiftToMonday = day === 0 ? 6 : day - 1;
    const startDay = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() - shiftToMonday,
      0,
      0,
      0,
      0,
    );
    return startDay;
  }

  private monthStartUtc(tsMs: number): number {
    const d = new Date(tsMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
  }

  private monthEndExclusiveUtc(tsMs: number): number {
    const d = new Date(tsMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  }

  private rangeToBucketBounds(
    interval: TimeFrame.week | TimeFrame.month,
    fromMs: number,
    toMs: number,
  ): { fromBucketMs: number; toBucketExclusiveMs: number } {
    if (interval === TimeFrame.week) {
      const fromBucketMs = this.weekStartUtc(fromMs);
      const toBucketExclusiveMs = this.weekStartUtc(toMs) + 7 * 24 * 60 * 60 * 1000;
      return { fromBucketMs, toBucketExclusiveMs };
    }
    const fromBucketMs = this.monthStartUtc(fromMs);
    const toBucketExclusiveMs = this.monthEndExclusiveUtc(toMs);
    return { fromBucketMs, toBucketExclusiveMs };
  }

  private bucketExpr(interval: TimeFrame.week | TimeFrame.month): string {
    return interval === TimeFrame.week
      ? "date_trunc('week', ts)"
      : "date_trunc('month', ts)";
  }

  private toSqlNumber(value: number): string {
    if (!Number.isFinite(value)) return '0';
    return String(value);
  }

  private parseBucketToIso(bucket: unknown): string | null {
    if (bucket == null) return null;

    if (bucket instanceof Date) {
      const ms = bucket.getTime();
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }

    if (typeof bucket === 'number') {
      return Number.isFinite(bucket) ? new Date(bucket).toISOString() : null;
    }

    const parsedMs = Date.parse(String(bucket));
    if (!Number.isFinite(parsedMs)) return null;
    return new Date(parsedMs).toISOString();
  }

  private async pickBestSourceInterval(
    symbolSql: string,
    connectorSql: string,
    marketSql: string,
    fromBucketIso: string,
    toBucketExclusiveIso: string,
  ): Promise<LowerInterval | null> {
    const candidates: LowerInterval[] = [TimeFrame.day, TimeFrame.h4, TimeFrame.h1];
    for (const candidate of candidates) {
      const candidateSql = this.esc(String(candidate));
      const sql = `
        SELECT count() AS cnt
        FROM candles
        WHERE symbol='${symbolSql}'
          AND connectorType='${connectorSql}'
          AND marketType='${marketSql}'
          AND interval='${candidateSql}'
          AND ts >= timestamp '${fromBucketIso}'
          AND ts < timestamp '${toBucketExclusiveIso}'
      `;
      const rows = await this.query.queryAsObjects(sql);
      const count = Number(rows?.[0]?.cnt ?? 0);
      if (Number.isFinite(count) && count > 0) return candidate;
    }
    return null;
  }

  async recomputeRangeFromDaily(params: DerivedRangeParams): Promise<number> {
    const { symbol, connectorType, marketType, interval } = params;
    if (params.toMs < params.fromMs) return 0;

    const symbolSql = this.esc(symbol);
    const connectorSql = this.esc(connectorType);
    const marketSql = this.esc(marketType);
    const intervalSql = this.esc(String(interval));

    const { fromBucketMs, toBucketExclusiveMs } = this.rangeToBucketBounds(
      interval,
      params.fromMs,
      params.toMs,
    );
    const fromBucketIso = this.toIso(fromBucketMs);
    const toBucketExclusiveIso = this.toIso(toBucketExclusiveMs);
    const bucketExpr = this.bucketExpr(interval);

    const sourceInterval = await this.pickBestSourceInterval(
      symbolSql,
      connectorSql,
      marketSql,
      fromBucketIso,
      toBucketExclusiveIso,
    );

    if (sourceInterval == null) {
      this.derivedLog(
        `[DERIVED] skipped ${interval} (no source data: day/h4/h1) | symbol=${symbol} connectorType=${connectorType} marketType=${marketType} range=${fromBucketIso}..${toBucketExclusiveIso}`,
      );
      return 0;
    }

    const sourceIntervalSql = this.esc(String(sourceInterval));

    const aggregateSql = `
      SELECT
        ${bucketExpr} AS bucket,
        first(open) AS open,
        max(high) AS high,
        min(low) AS low,
        last(close) AS close,
        sum(volume) AS volume
      FROM candles
      WHERE symbol='${symbolSql}'
        AND connectorType='${connectorSql}'
        AND marketType='${marketSql}'
        AND interval='${sourceIntervalSql}'
        AND ts >= timestamp '${fromBucketIso}'
        AND ts < timestamp '${toBucketExclusiveIso}'
      GROUP BY ${bucketExpr}
      ORDER BY bucket
    `;

    const rows = (await this.query.queryAsObjects(aggregateSql)) as AggregatedBucketRow[];
    if (!Array.isArray(rows) || rows.length === 0) {
      this.derivedLog(
        `[DERIVED] skipped ${interval} (no aggregated rows) | symbol=${symbol} connectorType=${connectorType} marketType=${marketType} source=${sourceInterval}`,
      );
      return 0;
    }

    for (const row of rows) {
      const bucketIso = this.parseBucketToIso(row.bucket);
      if (bucketIso == null) {
        this.logger.warn(
          `[DERIVED] skipped bucket with invalid timestamp | symbol=${symbol} connectorType=${connectorType} marketType=${marketType} interval=${interval} bucket=${String(
            row.bucket,
          )}`,
        );
        continue;
      }
      const openSql = this.toSqlNumber(Number(row.open));
      const highSql = this.toSqlNumber(Number(row.high));
      const lowSql = this.toSqlNumber(Number(row.low));
      const closeSql = this.toSqlNumber(Number(row.close));
      const volumeSql = this.toSqlNumber(Number(row.volume));

      const updateSql = `
        UPDATE candles
        SET
          open=${openSql},
          high=${highSql},
          low=${lowSql},
          close=${closeSql},
          volume=${volumeSql}
        WHERE symbol='${symbolSql}'
          AND connectorType='${connectorSql}'
          AND marketType='${marketSql}'
          AND interval='${intervalSql}'
          AND ts = timestamp '${bucketIso}'
      `;

      const existsSql = `
        SELECT count() AS cnt
        FROM candles
        WHERE symbol='${symbolSql}'
          AND connectorType='${connectorSql}'
          AND marketType='${marketSql}'
          AND interval='${intervalSql}'
          AND ts = timestamp '${bucketIso}'
      `;

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
          '${connectorSql}',
          '${marketSql}',
          ${openSql},
          ${highSql},
          ${lowSql},
          ${closeSql},
          ${volumeSql},
          timestamp '${bucketIso}'
        )
      `;

      const existsRows = await this.query.queryAsObjects(existsSql);
      const exists = Number(existsRows?.[0]?.cnt ?? 0) > 0;
      if (exists) {
        await this.query.query(updateSql);
      } else {
        await this.query.query(insertSql);
      }
    }

    const countSql = `
      SELECT count() AS cnt
      FROM candles
      WHERE symbol='${symbolSql}'
        AND connectorType='${connectorSql}'
        AND marketType='${marketSql}'
        AND interval='${intervalSql}'
        AND ts >= timestamp '${fromBucketIso}'
        AND ts < timestamp '${toBucketExclusiveIso}'
    `;

    const countRows = await this.query.queryAsObjects(countSql);
    const count = Number(countRows?.[0]?.cnt ?? 0);

    this.derivedLog(
      `[DERIVED] recomputed ${interval} from ${sourceInterval} | symbol=${symbol} connectorType=${connectorType} marketType=${marketType} range=${fromBucketIso}..${toBucketExclusiveIso} buckets=${rows.length} rows=${Number.isFinite(count) ? count : 0}`,
    );

    return Number.isFinite(count) ? count : rows.length;
  }

  async recomputeAffectedFromDailyClose(params: RecomputeBucketParams): Promise<void> {
    const { symbol, connectorType, marketType, dayTsMs } = params;
    await this.recomputeRangeFromDaily({
      symbol,
      connectorType,
      marketType,
      interval: TimeFrame.week,
      fromMs: dayTsMs,
      toMs: dayTsMs,
    });
    await this.recomputeRangeFromDaily({
      symbol,
      connectorType,
      marketType,
      interval: TimeFrame.month,
      fromMs: dayTsMs,
      toMs: dayTsMs,
    });
  }
}
