/**
 * Types for async candle debug/repair jobs (UI-friendly, non-blocking).
 */

export type CandleDebugJobType = 'repair' | 'verify' | 'scan';

export type CandleDebugJobStatus =
  | 'started'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const REPAIR_JOB_STAGES = [
  'scanning_series',
  'collapsing_duplicates',
  'detecting_gaps',
  'fetching_history',
  'inserting_backfill',
  'verifying',
  'completed',
] as const;

export type RepairJobStage = (typeof REPAIR_JOB_STAGES)[number];

export const VERIFY_JOB_STAGES = [
  'health',
  'stats',
  'duplicates',
  'gaps',
  'out_of_order',
  'seam',
  'lag',
  'completed',
] as const;

export type VerifyJobStage = (typeof VERIFY_JOB_STAGES)[number];

export interface RepairProgressUpdate {
  stage: RepairJobStage;
  processedSeries?: number;
  totalSeries?: number;
  currentSeries?: string;
  duplicatesFixed?: number;
  gapsFixed?: number;
  progressPercent?: number;
}

export interface CandleDebugJobRecord {
  jobId: string;
  type: CandleDebugJobType;
  status: CandleDebugJobStatus;
  stage?: RepairJobStage | VerifyJobStage | string;
  progressPercent?: number;
  processedSeries?: number;
  totalSeries?: number;
  currentSeries?: string;
  duplicatesFixed?: number;
  gapsFixed?: number;
  startedAt: string; // ISO
  completedAt?: string;
  lastProgressAt: number; // ms since epoch, for heartbeat
  elapsedSeconds?: number;
  error?: string;
  result?: CandleDebugJobResult;
  cancelled?: boolean;
}

export interface CandleDebugJobResult {
  status: 'completed' | 'failed' | 'cancelled';
  duplicatesFixed?: number;
  gapsFixed?: number;
  durationMs?: number;
  clean?: boolean;
  error?: string;
  /** Verification job result */
  structuralIntegrity?: 'healthy' | 'broken';
  operationalIntegrity?: 'healthy' | 'repair_recommended';
  checks?: Record<string, 'ok' | 'warn' | 'fail'>;
  metrics?: Record<string, number>;
  pass?: boolean;
  dataQualityScore?: number;
}

export interface CandleDebugJobStartResponse {
  jobId: string;
  status: 'started';
}

export interface CandleDebugJobStatusResponse {
  jobId: string;
  type: CandleDebugJobType;
  status: CandleDebugJobStatus;
  stage?: RepairJobStage | VerifyJobStage | string;
  progressPercent?: number;
  processedSeries?: number;
  totalSeries?: number;
  currentSeries?: string;
  duplicatesFixed?: number;
  gapsFixed?: number;
  startedAt: string;
  elapsedSeconds?: number;
  heartbeat?: boolean;
  error?: string;
}

export interface CandleDebugJobListItem {
  jobId: string;
  type: CandleDebugJobType;
  status: CandleDebugJobStatus;
  progressPercent?: number;
  stage?: string;
  currentSeries?: string;
  startedAt?: string;
  elapsedSeconds?: number;
  heartbeat?: boolean;
}
