import { ConnectorType, MarketType, TimeFrame } from '@barfinex/types';

export interface SyntheticBacktestOptions {
  symbol: string;
  interval: TimeFrame;
  /** Number of candles to generate. Default: 500 */
  numCandles?: number;
  /** Starting price. Default: 50000 */
  startPrice?: number;
  /**
   * Per-candle volatility (log-normal sigma). E.g. 0.015 = 1.5% per candle.
   * Default: 0.015
   */
  volatility?: number;
  /**
   * Per-candle drift. 0 = pure random walk. 0.001 = slight uptrend, -0.001 = slight downtrend.
   * Default: 0
   */
  trend?: number;
  connectorType?: ConnectorType;
  marketType?: MarketType;
}

export interface BacktestOptions {
  /** 'historical' = replay stored candles from QuestDB. 'synthetic' = generate GBM candles. */
  mode: 'historical' | 'synthetic';

  // ── Historical mode ────────────────────────────────────────────
  /** from timestamp (Unix ms). Required for historical mode. */
  from?: number;
  /** to timestamp (Unix ms). Required for historical mode. */
  to?: number;
  /** Symbol filter for historical mode (e.g. 'BTCUSDT'). */
  symbol?: string;
  /** Timeframe filter for historical mode. */
  interval?: TimeFrame;
  connectorType?: ConnectorType;
  marketType?: MarketType;

  // ── Synthetic mode ─────────────────────────────────────────────
  synthetic?: SyntheticBacktestOptions;

  // ── Common ─────────────────────────────────────────────────────
  /**
   * Playback speed multiplier. 1 = real-time (uses candle timestamps as delays).
   * 100 = 100× faster. 0 = instant (no delay). Default: 1.
   */
  speed?: number;
}

export interface BacktestStatus {
  running: boolean;
  mode?: 'historical' | 'synthetic';
  cursor: number;
  total: number;
  progressPct: number;
  speed: number;
  startedAt?: number;
  completedAt?: number;
}
