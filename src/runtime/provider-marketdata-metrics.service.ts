import { Injectable } from '@nestjs/common';
import { Gauge, register } from 'prom-client';

@Injectable()
export class ProviderMarketdataMetricsService {
  private readonly marketDataLagGauge: Gauge<'stream' | 'marketType'>;

  constructor() {
    this.marketDataLagGauge = this.getOrCreateLagGauge();
  }

  observeMarketDataLag(
    stream: string,
    marketType: string,
    eventTimestampMs?: number,
  ): void {
    if (
      !Number.isFinite(eventTimestampMs) ||
      !eventTimestampMs ||
      eventTimestampMs <= 0
    ) {
      return;
    }

    const lagMs = Math.max(0, Date.now() - Number(eventTimestampMs));
    this.marketDataLagGauge.labels(stream, marketType).set(lagMs);
  }

  async getLagSummary(): Promise<{
    maxLagMs: number;
    byStream: Record<string, number>;
  }> {
    const metrics = await register.getMetricsAsJSON();
    const lagMetric = metrics.find(
      (metric) => metric.name === 'provider_marketdata_lag_ms',
    );
    const values = lagMetric?.values || [];
    const byStream: Record<string, number> = {};
    let maxLagMs = 0;

    for (const value of values) {
      const stream = String(value.labels?.stream || 'unknown');
      const marketType = String(value.labels?.marketType || 'unknown');
      const lagMs = Number(value.value);
      if (!Number.isFinite(lagMs)) continue;

      if (lagMs > maxLagMs) maxLagMs = lagMs;
      byStream[`${stream}:${marketType}`] = lagMs;
    }

    return { maxLagMs, byStream };
  }

  private getOrCreateLagGauge(): Gauge<'stream' | 'marketType'> {
    const existing = register.getSingleMetric('provider_marketdata_lag_ms');
    if (existing) {
      return existing as Gauge<'stream' | 'marketType'>;
    }

    return new Gauge({
      name: 'provider_marketdata_lag_ms',
      help: 'Lag between now and incoming market-data event timestamp in milliseconds',
      labelNames: ['stream', 'marketType'],
      registers: [register],
    });
  }
}
