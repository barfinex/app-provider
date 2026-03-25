import { Injectable, Optional } from '@nestjs/common';
import { CandleIntegrityService } from './candle-integrity.service';
import { CandleDebugJobStore } from './candle-debug-job.store';
import { IntegrityAutoscanService } from './integrity-autoscan.service';
import { CandleSelfHealingOrchestratorService } from './candle-self-healing-orchestrator.service';
import type {
  AutoHealingStatus,
  CandleIntegrityIncident,
  IncidentListResult,
} from './candle-integrity-incident.types';

const STALE_WARNING_SECONDS = 60;
const STALE_CRITICAL_SECONDS = 180;

/** Rolling window (days) for SRE metrics when CANDLE_INTEGRITY_METRICS_WINDOW_DAYS is set. Full-history otherwise. */
const METRICS_WINDOW_DAYS =
  process.env.CANDLE_INTEGRITY_METRICS_WINDOW_DAYS != null
    ? Math.max(
        1,
        parseInt(process.env.CANDLE_INTEGRITY_METRICS_WINDOW_DAYS, 10) || 30,
      )
    : null;
/** TTL for cached operational metrics (ms). If set, dashboard uses cache to avoid heavy list() on every request. */
const OPERATIONAL_METRICS_CACHE_TTL_MS =
  process.env.CANDLE_INTEGRITY_METRICS_CACHE_TTL_MS != null
    ? Math.max(
        5000,
        parseInt(process.env.CANDLE_INTEGRITY_METRICS_CACHE_TTL_MS, 10) ||
          30_000,
      )
    : 30_000;

/** Data quality score 0–100. Penalties: duplicates, seam, gaps, lag, stale. */
export function computeDataQualityScore(params: {
  duplicateRowsTotal: number;
  seamIssueCount: number;
  gapCountTotal: number;
  laggingSeriesCount: number;
  staleSeriesCount: number;
  outOfOrderCountTotal: number;
}): number {
  let score = 100;
  score -= Math.min(params.duplicateRowsTotal * 2, 25);
  score -= Math.min(params.outOfOrderCountTotal * 2, 25);
  score -= Math.min(params.seamIssueCount * 5, 25);
  score -= Math.min(Math.floor(params.gapCountTotal * 0.1), 20);
  score -= Math.min(params.laggingSeriesCount * 3, 15);
  score -= Math.min(params.staleSeriesCount, 10);
  return Math.max(0, Math.min(100, Math.round(score)));
}

export interface CandleDebugDashboardDto {
  health: { live: boolean; ready: boolean };
  structuralIntegrity: {
    status: 'healthy' | 'broken';
    duplicateRowsTotal: number;
    outOfOrderCountTotal: number;
    seamIssueCount: number;
  };
  operationalIntegrity: {
    status: 'healthy' | 'repair_recommended';
    gapCountTotal: number;
    staleSeriesCount: number;
    laggingSeriesCount: number;
  };
  seriesCount: number;
  totalRows: number;
  lastScanTime: string;
  jobs: { runningJobs: number; lastJobStatus: string };
  dataQualityScore?: number;
  /** Self-healing pipeline */
  activeIncidentCount?: number;
  criticalIncidentCount?: number;
  lastIncidentAt?: string | null;
  autoHealingStatus?: AutoHealingStatus;
  lastAutoscanAt?: string | null;
  lastAutoscanDurationMs?: number | null;
  lastVerifyAt?: string | null;
  lastRepairAt?: string | null;
  /** SRE-style operational metrics */
  operationalMetrics?: {
    mttrMs: number | null;
    mtbfMs: number | null;
    repairSuccessRate: number | null;
    verificationSuccessRate: number | null;
    /** Rolling window days for metrics (full-history if not set). */
    windowDays?: number | null;
  };
}

@Injectable()
export class CandleDebugDashboardService {
  constructor(
    private readonly integrityService: CandleIntegrityService,
    private readonly jobStore: CandleDebugJobStore,
    @Optional()
    private readonly healthService?: {
      getLivenessSnapshot(): { status: string };
      getReadinessSnapshot(): Promise<{ ready?: boolean }>;
    },
    @Optional()
    private readonly autoscan?: IntegrityAutoscanService,
    @Optional()
    private readonly incidentStore?: {
      countActive(): number;
      countCritical(): number;
      getLastIncidentAt(): string | null;
      list(filters?: { limit?: number; offset?: number }): IncidentListResult;
    },
    @Optional()
    private readonly repairOrchestrator?: {
      getRunningRepairJobId(): string | null;
    },
    @Optional()
    private readonly selfHealingOrchestrator?: CandleSelfHealingOrchestratorService,
  ) {}

  async getDashboard(): Promise<CandleDebugDashboardDto> {
    const jobList = this.jobStore.list();
    const healthPromise = this.resolveHealth();

    // Prefer cached autoscan for fast response (<100ms goal)
    const cached =
      this.autoscan?.getCachedIfValid() ?? this.autoscan?.getCached();
    let diagnostics: import('./candle-integrity.service').IntegrityDiagnostics;
    let seam: Array<{ gapAtSeam: boolean; rowsAtLastTs?: number | null }>;

    if (cached) {
      diagnostics = cached.diagnostics;
      seam = cached.seam;
      // If cache expired, trigger refresh in background (non-blocking)
      if (!this.autoscan?.getCachedIfValid() && !this.autoscan?.isScanning()) {
        void this.autoscan?.runScanOnce();
      }
    } else {
      const [d, s] = await Promise.all([
        this.integrityService.scanDiagnostics(),
        this.integrityService.getSeamDiagnostics(undefined),
      ]);
      diagnostics = d;
      seam = s ?? [];
    }

    const nowSec = Math.floor(Date.now() / 1000);
    let staleSeriesCount = 0;
    let laggingSeriesCount = 0;
    const series = diagnostics.series ?? [];
    for (const s of series) {
      const lastTsSec = s.endTs != null ? Math.floor(s.endTs / 1000) : null;
      if (lastTsSec == null) continue;
      const lagSeconds = nowSec - lastTsSec;
      if (lagSeconds >= STALE_CRITICAL_SECONDS) laggingSeriesCount += 1;
      else if (lagSeconds >= STALE_WARNING_SECONDS) staleSeriesCount += 1;
    }

    const seamIssueCount = (seam ?? []).filter(
      (s) => s.gapAtSeam || (s.rowsAtLastTs != null && s.rowsAtLastTs !== 1),
    ).length;

    const structuralHealthy =
      (diagnostics.duplicateRowsTotal ?? 0) === 0 &&
      (diagnostics.outOfOrderCountTotal ?? 0) === 0 &&
      seamIssueCount === 0;

    const operationalHealthy =
      (diagnostics.gapCountTotal ?? 0) === 0 &&
      staleSeriesCount === 0 &&
      laggingSeriesCount === 0;

    const runningJobs = (jobList ?? []).filter(
      (j) => j.status === 'started' || j.status === 'running',
    ).length;
    const lastJob =
      (jobList ?? []).length > 0
        ? (jobList ?? [])[(jobList ?? []).length - 1]!
        : null;
    const lastJobStatus = lastJob?.status ?? 'idle';

    const health = await healthPromise;

    const dataQualityScore = computeDataQualityScore({
      duplicateRowsTotal: diagnostics.duplicateRowsTotal ?? 0,
      outOfOrderCountTotal: diagnostics.outOfOrderCountTotal ?? 0,
      seamIssueCount,
      gapCountTotal: diagnostics.gapCountTotal ?? 0,
      laggingSeriesCount,
      staleSeriesCount,
    });

    const rawState = this.selfHealingOrchestrator?.getAutoHealingState?.();
    const criticalCount = this.incidentStore?.countCritical?.() ?? 0;
    const autoHealingStatus: AutoHealingStatus =
      rawState === 'IDLE' && criticalCount > 0
        ? 'DEGRADED'
        : rawState ?? this.resolveAutoHealingStatus(runningJobs, jobList ?? []);
    const { lastVerifyAt, lastRepairAt } = this.getLastJobTimes(jobList ?? []);
    const lastAutoscanAt =
      cached?.scannedAt != null
        ? new Date(cached.scannedAt).toISOString()
        : null;
    const lastAutoscanDurationMs = null;
    const operationalMetrics = this.computeOperationalMetrics(jobList ?? []);

    return {
      health: { live: health.live, ready: health.ready },
      structuralIntegrity: {
        status: structuralHealthy ? 'healthy' : 'broken',
        duplicateRowsTotal: diagnostics.duplicateRowsTotal ?? 0,
        outOfOrderCountTotal: diagnostics.outOfOrderCountTotal ?? 0,
        seamIssueCount,
      },
      operationalIntegrity: {
        status: operationalHealthy ? 'healthy' : 'repair_recommended',
        gapCountTotal: diagnostics.gapCountTotal ?? 0,
        staleSeriesCount,
        laggingSeriesCount,
      },
      seriesCount: diagnostics.seriesCount ?? 0,
      totalRows: diagnostics.totalRows ?? 0,
      lastScanTime: diagnostics.scannedAt ?? new Date().toISOString(),
      jobs: { runningJobs, lastJobStatus },
      dataQualityScore,
      activeIncidentCount: this.incidentStore?.countActive?.() ?? 0,
      criticalIncidentCount: this.incidentStore?.countCritical?.() ?? 0,
      lastIncidentAt: this.incidentStore?.getLastIncidentAt?.() ?? null,
      autoHealingStatus,
      lastAutoscanAt,
      lastAutoscanDurationMs,
      lastVerifyAt,
      lastRepairAt,
      operationalMetrics,
    };
  }

  /** Cached operational metrics to keep dashboard fast. Invalidated by TTL. */
  private operationalMetricsCache: {
    at: number;
    value: CandleDebugDashboardDto['operationalMetrics'];
  } | null = null;

  /**
   * SRE operational metrics (semantics documented in docs/runtime/self-healing-candle-pipeline-v2-upgrade-deliverables.md):
   * - MTTR: Mean time to resolve — resolved incidents only; time from detectedAt to resolvedAt.
   * - MTBF: Mean time between incident openings (detectedAt to next incident's detectedAt).
   * - repairSuccessRate: completed repair jobs with status=completed / (completed + failed); in-progress excluded.
   * - verificationSuccessRate: verify jobs with result.pass=true / completed verify jobs; in-progress excluded.
   * Window: CANDLE_INTEGRITY_METRICS_WINDOW_DAYS or full-history. Avoids divide-by-zero; returns null when no data.
   */
  private computeOperationalMetrics(
    jobList: Array<{
      type: string;
      status: string;
      result?: { pass?: boolean };
      startedAt?: string;
    }>,
  ): CandleDebugDashboardDto['operationalMetrics'] {
    const now = Date.now();
    const cached = this.operationalMetricsCache;
    if (cached && now - cached.at < OPERATIONAL_METRICS_CACHE_TTL_MS) {
      return cached.value;
    }

    // Only completed or failed jobs count; in-progress (started/running) excluded from denominators
    const repairJobs = jobList.filter((j) => j.type === 'repair');
    const completedRepair = repairJobs.filter(
      (j) => j.status === 'completed',
    ).length;
    const failedRepair = repairJobs.filter((j) => j.status === 'failed').length;
    const repairTotal = completedRepair + failedRepair;
    const repairSuccessRate =
      repairTotal > 0
        ? Math.round((completedRepair / repairTotal) * 100) / 100
        : null;

    const verifyJobs = jobList.filter((j) => j.type === 'verify');
    const completedVerify = verifyJobs.filter((j) => j.status === 'completed');
    const verifyPassed = completedVerify.filter(
      (j) => j.result?.pass === true,
    ).length;
    const verifyTotal = completedVerify.length;
    const verificationSuccessRate =
      verifyTotal > 0
        ? Math.round((verifyPassed / verifyTotal) * 100) / 100
        : null;

    let mttrMs: number | null = null;
    let mtbfMs: number | null = null;
    const cutoffIso = METRICS_WINDOW_DAYS
      ? new Date(now - METRICS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
      : undefined;
    const incidentList = this.incidentStore?.list?.({ limit: 500, offset: 0 });
    if (incidentList?.incidents?.length) {
      let incidents = incidentList.incidents as CandleIntegrityIncident[];
      if (cutoffIso) {
        incidents = incidents.filter((i) => i.detectedAt >= cutoffIso);
      }
      const resolved = incidents.filter(
        (i) => i.status === 'RESOLVED' && i.resolvedAt && i.detectedAt,
      );
      if (resolved.length > 0) {
        const times = resolved.map(
          (i) =>
            new Date(i.resolvedAt!).getTime() -
            new Date(i.detectedAt).getTime(),
        );
        mttrMs = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      }
      const byDetected = [...incidents].sort(
        (a, b) =>
          new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime(),
      );
      const gaps: number[] = [];
      for (let i = 1; i < byDetected.length; i++) {
        gaps.push(
          new Date(byDetected[i]!.detectedAt).getTime() -
            new Date(byDetected[i - 1]!.detectedAt).getTime(),
        );
      }
      if (gaps.length > 0) {
        mtbfMs = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
      }
    }

    const value: CandleDebugDashboardDto['operationalMetrics'] = {
      mttrMs,
      mtbfMs,
      repairSuccessRate,
      verificationSuccessRate,
      windowDays: METRICS_WINDOW_DAYS ?? undefined,
    };
    this.operationalMetricsCache = { at: now, value };
    return value;
  }

  private resolveAutoHealingStatus(
    runningJobs: number,
    jobList: Array<{ type: string; status: string }>,
  ): AutoHealingStatus {
    if (this.autoscan?.isScanning?.()) return 'SCANNING';
    const repairRunning =
      this.repairOrchestrator?.getRunningRepairJobId?.() != null;
    if (repairRunning) return 'RECOVERY_RUNNING';
    const verifyRunning = jobList.some(
      (j) =>
        j.type === 'verify' &&
        (j.status === 'started' || j.status === 'running'),
    );
    if (verifyRunning) return 'VERIFYING';
    const critical = (this.incidentStore?.countCritical?.() ?? 0) > 0;
    if (critical) return 'DEGRADED';
    return 'IDLE';
  }

  private getLastJobTimes(
    jobList: Array<{ type: string; status: string; startedAt?: string }>,
  ): { lastVerifyAt: string | null; lastRepairAt: string | null } {
    let lastVerifyAt: string | null = null;
    let lastRepairAt: string | null = null;
    for (const j of jobList) {
      if (j.status !== 'completed' && j.status !== 'failed') continue;
      const started = j.startedAt ? new Date(j.startedAt).toISOString() : null;
      if (
        j.type === 'verify' &&
        started &&
        (!lastVerifyAt || started > lastVerifyAt)
      )
        lastVerifyAt = started;
      if (
        j.type === 'repair' &&
        started &&
        (!lastRepairAt || started > lastRepairAt)
      )
        lastRepairAt = started;
    }
    return { lastVerifyAt, lastRepairAt };
  }

  private async resolveHealth(): Promise<{ live: boolean; ready: boolean }> {
    if (!this.healthService) {
      return { live: true, ready: true };
    }
    try {
      const [liveSnap, readySnap] = await Promise.all([
        Promise.resolve(this.healthService.getLivenessSnapshot()),
        this.healthService.getReadinessSnapshot(),
      ]);
      return {
        live: liveSnap?.status === 'ok',
        ready: readySnap?.ready === true,
      };
    } catch {
      return { live: true, ready: false };
    }
  }
}
