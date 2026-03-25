import { TimeFrame } from '@barfinex/types';

export type CandleRepairMode = 'dry-run' | 'apply';

export interface CandleSeriesSelector {
  connectorType: string;
  marketType: string;
  symbol: string;
  interval: TimeFrame;
}

export interface MissingRange {
  from: number;
  to: number;
}

export interface SeriesIntegrityReport extends CandleSeriesSelector {
  startTimestamp: number | null;
  endTimestamp: number | null;
  duplicateRows: number;
  gapCount: number;
  outOfOrderCount: number;
  missingRanges: MissingRange[];
  timestampMonotonic: boolean;
  totalRows: number;
}

export interface SeriesRepairPlan extends CandleSeriesSelector {
  duplicateRowsToRemove: number;
  gapRangesToBackfill: MissingRange[];
  requiresOutOfOrderRewrite: boolean;
}

export interface CandleRepairRequest {
  mode: CandleRepairMode;
  series?: CandleSeriesSelector;
}

export interface SeriesRepairResult extends CandleSeriesSelector {
  iterations: number;
  changed: boolean;
  before: SeriesIntegrityReport;
  after: SeriesIntegrityReport;
  repairedDuplicateRows: number;
  repairedGapRanges: number;
  repairedOutOfOrderPasses: number;
  error?: string;
}

export interface CandleRepairResponse {
  mode: CandleRepairMode;
  plans: SeriesRepairPlan[];
  results: SeriesRepairResult[];
  clean: boolean;
}

/** Optional progress report for async job UI; stage names match REPAIR_JOB_STAGES in candle-debug-job.types */
export interface RepairProgressReport {
  stage: string;
  currentSeries?: string;
  processedSeries?: number;
  totalSeries?: number;
  duplicatesFixed?: number;
  gapsFixed?: number;
  progressPercent?: number;
}
