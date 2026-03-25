import { Injectable } from '@nestjs/common';
import type { CandleIntegrityIncidentScope } from './candle-integrity-incident.types';

/** Configurable weights (ENV). Defaults match previous formula: dup*10 + gaps*3 + stale*2 + lag/10. */
const W_DUPLICATE = Number(
  process.env.CANDLE_INTEGRITY_IMPACT_DUPLICATE_WEIGHT ?? 10,
);
const W_GAP = Number(process.env.CANDLE_INTEGRITY_IMPACT_GAP_WEIGHT ?? 3);
const W_STALE = Number(process.env.CANDLE_INTEGRITY_IMPACT_STALE_WEIGHT ?? 2);
const W_LAG = Number(process.env.CANDLE_INTEGRITY_IMPACT_LAG_WEIGHT ?? 0.1); // per lagging-series "unit" (e.g. 60s)

/** Interval multiplier (higher = more critical). min1 > min5 > h1 > day. */
const INTERVAL_MULTIPLIER: Record<string, number> = {
  min1: Number(process.env.CANDLE_INTEGRITY_IMPACT_INTERVAL_MIN1 ?? 1.5),
  min5: Number(process.env.CANDLE_INTEGRITY_IMPACT_INTERVAL_MIN5 ?? 1.25),
  min15: Number(process.env.CANDLE_INTEGRITY_IMPACT_INTERVAL_MIN15 ?? 1.1),
  min30: Number(process.env.CANDLE_INTEGRITY_IMPACT_INTERVAL_MIN30 ?? 1.05),
  h1: Number(process.env.CANDLE_INTEGRITY_IMPACT_INTERVAL_H1 ?? 1),
  h4: Number(process.env.CANDLE_INTEGRITY_IMPACT_INTERVAL_H4 ?? 0.9),
  day: Number(process.env.CANDLE_INTEGRITY_IMPACT_INTERVAL_DAY ?? 0.8),
};

/** High-priority symbols get higher multiplier. Comma-separated list in ENV, e.g. BTCUSDT,ETHUSDT */
const PRIORITY_SYMBOLS = (
  process.env.CANDLE_INTEGRITY_IMPACT_PRIORITY_SYMBOLS ?? 'BTCUSDT,ETHUSDT'
)
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const SYMBOL_PRIORITY_MULTIPLIER = Number(
  process.env.CANDLE_INTEGRITY_IMPACT_SYMBOL_PRIORITY ?? 1.3,
);

export interface ImpactScoreInput {
  duplicateRowsTotal: number;
  gapCountTotal: number;
  staleSeriesCount: number;
  laggingSeriesCount: number;
  interval?: string;
  symbol?: string;
  scope?: CandleIntegrityIncidentScope;
}

export interface ImpactScoreResult {
  score: number;
  components: Record<string, number | string>;
}

@Injectable()
export class CandleIntegrityImpactScoreService {
  /**
   * Compute explainable impact score. Formula:
   * (W_dup*duplicates + W_gap*gaps + W_stale*stale + W_lag*laggingSeries*60) * intervalMultiplier * symbolMultiplier
   */
  compute(input: ImpactScoreInput): ImpactScoreResult {
    const raw =
      W_DUPLICATE * input.duplicateRowsTotal +
      W_GAP * input.gapCountTotal +
      W_STALE * input.staleSeriesCount +
      W_LAG * (input.laggingSeriesCount * 60);
    const intervalKey = (input.interval ?? 'h1').toLowerCase();
    const intervalMult =
      INTERVAL_MULTIPLIER[intervalKey] ?? INTERVAL_MULTIPLIER.h1 ?? 1;
    const symbolMult =
      input.symbol && PRIORITY_SYMBOLS.includes(input.symbol.toUpperCase())
        ? SYMBOL_PRIORITY_MULTIPLIER
        : 1;
    const score = Math.round(Math.max(0, raw * intervalMult * symbolMult));
    const components: Record<string, number | string> = {
      duplicateWeight: W_DUPLICATE,
      gapWeight: W_GAP,
      staleWeight: W_STALE,
      lagWeight: W_LAG,
      duplicates: input.duplicateRowsTotal,
      gaps: input.gapCountTotal,
      staleSeries: input.staleSeriesCount,
      laggingSeries: input.laggingSeriesCount,
      rawScore: Math.round(raw * 100) / 100,
      intervalMultiplier: intervalMult,
      symbolMultiplier: symbolMult,
    };
    return { score, components };
  }
}
