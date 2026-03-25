import { Injectable } from '@nestjs/common';

const WINDOW_SEC = 5;
const NUM_BUCKETS = 5;

interface Bucket {
  tradeCount: number;
  orderbookCount: number;
  symbolCounts: Map<string, number>;
}

/**
 * Lightweight ingestion metrics for operational dashboard.
 * Sliding window (5s) for trades/sec, orderbook updates/sec, and symbol throughput.
 * Do not add expensive work in record* — hot path.
 */
@Injectable()
export class ProviderMetricsService {
  private readonly buckets: Bucket[] = Array.from(
    { length: NUM_BUCKETS },
    () => ({
      tradeCount: 0,
      orderbookCount: 0,
      symbolCounts: new Map<string, number>(),
    }),
  );
  private lastSecond = 0;

  /** Call from ingestion pipeline on each trade. */
  recordTrade(symbol?: string): void {
    this.advanceBuckets();
    const idx = this.currentBucketIndex();
    this.buckets[idx].tradeCount += 1;
    if (symbol) {
      const s = String(symbol).trim().toUpperCase();
      if (s) {
        const m = this.buckets[idx].symbolCounts;
        m.set(s, (m.get(s) ?? 0) + 1);
      }
    }
  }

  /** Call from ingestion pipeline on each orderbook update. */
  recordOrderbook(_symbol?: string): void {
    this.advanceBuckets();
    const idx = this.currentBucketIndex();
    this.buckets[idx].orderbookCount += 1;
  }

  private currentBucketIndex(): number {
    const sec = Math.floor(Date.now() / 1000);
    return sec % NUM_BUCKETS;
  }

  private advanceBuckets(): void {
    const sec = Math.floor(Date.now() / 1000);
    if (this.lastSecond !== sec) {
      const idx = sec % NUM_BUCKETS;
      this.buckets[idx].tradeCount = 0;
      this.buckets[idx].orderbookCount = 0;
      this.buckets[idx].symbolCounts.clear();
      this.lastSecond = sec;
    }
  }

  /**
   * Get current rates (trades/sec, orderbook/sec) and top symbols by events/sec.
   * Uses last WINDOW_SEC seconds (sum of 5 one-second buckets).
   */
  getMetrics(): {
    tradeRate: number;
    orderbookRate: number;
    symbols: Array<{ symbol: string; eventsPerSecond: number }>;
  } {
    let totalTrades = 0;
    let totalOrderbook = 0;
    const symbolTotals = new Map<string, number>();

    for (const b of this.buckets) {
      totalTrades += b.tradeCount;
      totalOrderbook += b.orderbookCount;
      b.symbolCounts.forEach((count, sym) => {
        symbolTotals.set(sym, (symbolTotals.get(sym) ?? 0) + count);
      });
    }

    const windowSec = Math.max(1, WINDOW_SEC);
    const tradeRate = Math.round((totalTrades / windowSec) * 10) / 10;
    const orderbookRate = Math.round((totalOrderbook / windowSec) * 10) / 10;
    const symbols = Array.from(symbolTotals.entries())
      .map(([symbol, count]) => ({
        symbol,
        eventsPerSecond: Math.round((count / windowSec) * 10) / 10,
      }))
      .sort((a, b) => b.eventsPerSecond - a.eventsPerSecond)
      .slice(0, 50);

    return { tradeRate, orderbookRate, symbols };
  }
}
