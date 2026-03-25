import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { QuestDBQueryService } from '../questdb/questdb-query.service';

const TRADES_RAW_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.TRADES_RAW_RETENTION_DAYS ?? 14),
);
const ORDERBOOK_SNAPSHOTS_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.ORDERBOOK_SNAPSHOTS_RETENTION_DAYS ?? 7),
);

/** Lag (ms) above which trade/orderbook stream is considered LAGGING. Below STALE = OK. */
export const MARKET_DATA_LAG_WARNING_MS = Math.max(
  1000,
  Number(process.env.MARKET_DATA_LAG_WARNING_MS ?? 30_000),
);
/** Lag (ms) above which stream is considered STALE. */
export const MARKET_DATA_STALE_MS = Math.max(
  5000,
  Number(process.env.MARKET_DATA_STALE_MS ?? 120_000),
);

/** Primary candle interval for desktop stream status when using candle-time (not event-time). Default 1m. */
export const CANDLE_PRIMARY_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.CANDLE_PRIMARY_INTERVAL_MS ?? 60_000),
);
/** Candle lag: OK when lag <= this multiplier * interval. */
export const CANDLE_LAG_OK_MULTIPLIER = Math.max(
  1,
  Number(process.env.CANDLE_LAG_OK_MULTIPLIER ?? 1.5),
);
/** Candle lag: WARNING when lag <= this multiplier * interval (above OK). */
export const CANDLE_LAG_WARNING_MULTIPLIER = Math.max(
  1.5,
  Number(process.env.CANDLE_LAG_WARNING_MULTIPLIER ?? 3),
);

@Injectable()
export class MarketDataRetentionService {
  private readonly logger = new Logger(MarketDataRetentionService.name);

  constructor(private readonly reader: QuestDBQueryService) {}

  /**
   * Purge raw_trades older than TRADES_RAW_RETENTION_DAYS.
   * QuestDB: DROP PARTITION LIST for partitions older than retention.
   */
  @Cron('0 3 * * *') // daily at 03:00
  async purgeRawTrades(): Promise<void> {
    try {
      const cutoff =
        Date.now() - TRADES_RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const cutoffDate = new Date(cutoff);
      const dateStr = cutoffDate.toISOString().slice(0, 10);
      const sql = `ALTER TABLE raw_trades DROP PARTITION WHERE ts < to_timestamp('${dateStr}', 'yyyy-MM-dd')`;
      await this.reader.query(sql);
      this.logger.log(
        `[RETENTION] raw_trades dropped partitions older than ${dateStr} (retention_days=${TRADES_RAW_RETENTION_DAYS})`,
      );
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      this.logger.warn(`[RETENTION] raw_trades purge failed: ${msg}`);
    }
  }

  /**
   * Purge orderbook_snapshots older than ORDERBOOK_SNAPSHOTS_RETENTION_DAYS.
   */
  @Cron('0 4 * * *') // daily at 04:00
  async purgeOrderbookSnapshots(): Promise<void> {
    try {
      const cutoff =
        Date.now() - ORDERBOOK_SNAPSHOTS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const cutoffDate = new Date(cutoff);
      const dateStr = cutoffDate.toISOString().slice(0, 10);
      const sql = `ALTER TABLE orderbook_snapshots DROP PARTITION WHERE ts < to_timestamp('${dateStr}', 'yyyy-MM-dd')`;
      await this.reader.query(sql);
      this.logger.log(
        `[RETENTION] orderbook_snapshots dropped partitions older than ${dateStr} (retention_days=${ORDERBOOK_SNAPSHOTS_RETENTION_DAYS})`,
      );
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      this.logger.warn(`[RETENTION] orderbook_snapshots purge failed: ${msg}`);
    }
  }

  getRetentionConfig(): {
    rawTradesDays: number;
    orderbookSnapshotsDays: number;
    lagWarningMs: number;
    lagStaleMs: number;
    candlePrimaryIntervalMs: number;
    candleLagOkMultiplier: number;
    candleLagWarningMultiplier: number;
  } {
    return {
      rawTradesDays: TRADES_RAW_RETENTION_DAYS,
      orderbookSnapshotsDays: ORDERBOOK_SNAPSHOTS_RETENTION_DAYS,
      lagWarningMs: MARKET_DATA_LAG_WARNING_MS,
      lagStaleMs: MARKET_DATA_STALE_MS,
      candlePrimaryIntervalMs: CANDLE_PRIMARY_INTERVAL_MS,
      candleLagOkMultiplier: CANDLE_LAG_OK_MULTIPLIER,
      candleLagWarningMultiplier: CANDLE_LAG_WARNING_MULTIPLIER,
    };
  }
}
