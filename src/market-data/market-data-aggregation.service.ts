import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import { TradeFeaturesRepository } from '../questdb/repositories/trade-features.repository';

/** Trade feature window: 1m, 5m, 15m, 1h. Stored in trade_features.window. */
export const TRADE_FEATURE_WINDOWS = [
  { key: '1m', ms: 60 * 1000 },
  { key: '5m', ms: 5 * 60 * 1000 },
  { key: '15m', ms: 15 * 60 * 1000 },
  { key: '1h', ms: 60 * 60 * 1000 },
] as const;

/**
 * Burst score formula:
 *   burstScore = tradeCount / max(1, rollingMeanTradeCount)
 * where rollingMeanTradeCount = average trade count over the previous N buckets
 * for the same (connectorType, marketType, symbol, window).
 * N = 60 for 1m (1h lookback), 12 for 5m (1h), 4 for 15m (1h), 24 for 1h (24h lookback).
 * Values > 1 indicate higher-than-average activity (burst); < 1 indicates lower.
 */
const BURST_LOOKBACK_BUCKETS: Record<string, number> = {
  '1m': 60,
  '5m': 12,
  '15m': 4,
  '1h': 24,
};

/**
 * Aggregates raw_trades into trade_features for multiple windows (1m, 5m, 15m, 1h).
 * Groups by connectorType, marketType, symbol, window (time bucket).
 * Metrics: tradeCount, buyVolume, sellVolume, signedVolume, imbalance, avgTradeSize,
 * maxTradeSize, tapeSpeed (trades/sec in window), vwap, burstScore.
 */
@Injectable()
export class MarketDataAggregationService {
  private readonly logger = new Logger(MarketDataAggregationService.name);

  constructor(
    private readonly reader: QuestDBQueryService,
    private readonly tradeFeaturesRepo: TradeFeaturesRepository,
  ) {}

  /** Every minute: aggregate 1m window (previous minute). */
  @Cron('* * * * *')
  async aggregate1m(): Promise<void> {
    await this.runAggregation('1m', 60 * 1000);
  }

  /** Every 5 minutes: aggregate 5m window. */
  @Cron('*/5 * * * *')
  async aggregate5m(): Promise<void> {
    await this.runAggregation('5m', 5 * 60 * 1000);
  }

  /** Every 15 minutes: aggregate 15m window. */
  @Cron('*/15 * * * *')
  async aggregate15m(): Promise<void> {
    await this.runAggregation('15m', 15 * 60 * 1000);
  }

  /** Every hour at :05: aggregate 1h window. */
  @Cron('5 * * * *')
  async aggregate1h(): Promise<void> {
    await this.runAggregation('1h', 60 * 60 * 1000);
  }

  /**
   * Run aggregation for one window. Buckets raw_trades by ts into window-sized buckets,
   * groups by connectorType, marketType, symbol, bucket_ts. Computes burstScore from
   * rolling mean of tradeCount in trade_features for same key.
   */
  async runAggregation(windowKey: string, windowMs: number): Promise<void> {
    try {
      const now = Date.now();
      const windowEnd = Math.floor(now / windowMs) * windowMs;
      const windowStart = windowEnd - windowMs;
      const fromTs = windowStart;
      const toTs = windowEnd;

      // QuestDB: ts is timestamp; cast(ts as long) is microseconds. Epoch ms = cast(ts as long)/1000.
      const bucketExpr = `(cast(ts as long) / 1000 / ${windowMs}) * ${windowMs}`;
      const sql = `
        SELECT
          connectorType,
          marketType,
          symbol,
          ${bucketExpr} AS bucketMs,
          count() AS tradeCount,
          sum(case when side = 'LONG' then qty else 0 end) AS buyVolume,
          sum(case when side = 'SHORT' then qty else 0 end) AS sellVolume,
          sum(case when side = 'LONG' then qty else -qty end) AS signedVolume,
          avg(price) AS vwap,
          max(qty) AS maxTradeSize,
          avg(qty) AS avgTradeSize
        FROM raw_trades
        WHERE ts >= ${fromTs * 1000}L AND ts < ${toTs * 1000}L
        GROUP BY connectorType, marketType, symbol, ${bucketExpr}
      `;
      const rows = await this.reader.queryAsObjects(sql).catch(() => []);
      if (!Array.isArray(rows) || rows.length === 0) return;

      const lookback = BURST_LOOKBACK_BUCKETS[windowKey] ?? 12;
      const rollbackStart = windowEnd - lookback * windowMs;
      const meanByKey: Map<string, number> = new Map();
      try {
        const meanSql = `
          SELECT connectorType, marketType, symbol, avg(tradeCount) AS meanCount
          FROM trade_features
          WHERE window = '${windowKey.replace(/'/g, "''")}'
            AND ts >= ${rollbackStart * 1000}L AND ts < ${windowEnd * 1000}L
          GROUP BY connectorType, marketType, symbol
        `;
        const meanRows = await this.reader
          .queryAsObjects(meanSql)
          .catch(() => []);
        if (Array.isArray(meanRows)) {
          for (const r of meanRows) {
            const k = [r?.connectorType, r?.marketType, r?.symbol].join('\0');
            meanByKey.set(k, Math.max(1, Number(r?.meanCount ?? 0)));
          }
        }
      } catch {
        // optional: use 1 so burstScore = tradeCount
      }

      for (const r of rows) {
        const buyVol = Number(r?.buyVolume ?? 0);
        const sellVol = Number(r?.sellVolume ?? 0);
        const total = buyVol + sellVol;
        const imbalance = total > 0 ? (buyVol - sellVol) / total : 0;
        const tradeCount = Number(r?.tradeCount ?? 0);
        const bucketMs = Number(r?.bucketMs ?? windowEnd);
        const tapeSpeed = windowMs > 0 ? tradeCount / (windowMs / 1000) : 0;
        const key = [r?.connectorType, r?.marketType, r?.symbol].join('\0');
        const rollingMean = meanByKey.get(key) ?? 1;
        const burstScore = tradeCount / rollingMean;

        this.tradeFeaturesRepo.enqueueFeatures({
          connectorType: String(r?.connectorType ?? ''),
          marketType: String(r?.marketType ?? ''),
          symbol: String(r?.symbol ?? '').toUpperCase(),
          window: windowKey,
          tradeCount,
          buyVolume: buyVol,
          sellVolume: sellVol,
          signedVolume: Number(r?.signedVolume ?? 0),
          imbalance,
          avgTradeSize: Number(r?.avgTradeSize ?? 0),
          maxTradeSize: Number(r?.maxTradeSize ?? 0),
          tapeSpeed,
          vwap: Number(r?.vwap ?? 0),
          burstScore,
          ts: bucketMs,
        });
      }
      this.logger.debug(
        `[AGGREGATION] trade_features ${windowKey} rows=${rows.length} windowEnd=${windowEnd}`,
      );
    } catch (e: unknown) {
      this.logger.warn(
        `[AGGREGATION] trade_features ${windowKey} failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
