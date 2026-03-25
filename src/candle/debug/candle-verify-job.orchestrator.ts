import { Injectable, Logger } from '@nestjs/common';
import { CandleIntegrityService } from './candle-integrity.service';
import { CandleDebugJobStore } from './candle-debug-job.store';
import {
  CandleDebugJobStartResponse,
  CandleDebugJobResult,
  VerifyJobStage,
} from './candle-debug-job.types';
import { computeDataQualityScore } from './candle-debug-dashboard.service';

const STALE_WARNING_SEC = 60;
const STALE_CRITICAL_SEC = 180;

@Injectable()
export class CandleVerifyJobOrchestrator {
  private readonly logger = new Logger(CandleVerifyJobOrchestrator.name);

  constructor(
    private readonly integrityService: CandleIntegrityService,
    private readonly jobStore: CandleDebugJobStore,
  ) {}

  startVerifyJob(): CandleDebugJobStartResponse {
    const jobId = this.nextJobId();
    const startedAt = new Date().toISOString();
    this.jobStore.create({
      jobId,
      type: 'verify',
      status: 'running',
      stage: 'health',
      progressPercent: 0,
      startedAt,
    });

    void this.runVerifyJob(jobId);
    return { jobId, status: 'started' };
  }

  private nextJobId(): string {
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = Math.floor(100 + Math.random() * 900);
    return `verify-${datePart}-${suffix}`;
  }

  private async runVerifyJob(jobId: string): Promise<void> {
    const startMs = Date.now();
    const stages: VerifyJobStage[] = [
      'health',
      'stats',
      'duplicates',
      'gaps',
      'out_of_order',
      'seam',
      'lag',
    ];
    const totalStages = stages.length;
    const progressPerStage = 100 / (totalStages + 1);

    const update = (stage: VerifyJobStage, percent: number) => {
      if (this.jobStore.isCancelled(jobId)) throw new Error('Job cancelled');
      this.jobStore.update(jobId, {
        stage,
        progressPercent: Math.min(99, Math.round(percent)),
      });
    };

    try {
      update('health', progressPerStage);
      await Promise.resolve();

      update('stats', progressPerStage * 2);
      const diagnostics = await this.integrityService.scanDiagnostics();

      update('duplicates', progressPerStage * 3);
      const duplicates = await this.integrityService.getDuplicates();

      update('gaps', progressPerStage * 4);
      const gaps = await this.integrityService.getGaps(undefined, 500);

      update('out_of_order', progressPerStage * 5);
      const outOfOrder = await this.integrityService.getOutOfOrder();

      update('seam', progressPerStage * 6);
      const seam = await this.integrityService.getSeamDiagnostics(undefined);

      update('lag', progressPerStage * 7);
      const nowSec = Math.floor(Date.now() / 1000);
      let staleCount = 0;
      let laggingCount = 0;
      for (const s of diagnostics.series) {
        const lastTsSec = s.endTs != null ? Math.floor(s.endTs / 1000) : null;
        if (lastTsSec == null) continue;
        const lagSec = nowSec - lastTsSec;
        if (lagSec >= STALE_CRITICAL_SEC) laggingCount += 1;
        else if (lagSec >= STALE_WARNING_SEC) staleCount += 1;
      }

      const seamIssueCount = seam.filter(
        (s) => s.gapAtSeam || (s.rowsAtLastTs != null && s.rowsAtLastTs !== 1),
      ).length;

      const structuralHealthy =
        diagnostics.duplicateRowsTotal === 0 &&
        diagnostics.outOfOrderCountTotal === 0 &&
        seamIssueCount === 0;
      const operationalHealthy =
        diagnostics.gapCountTotal === 0 &&
        staleCount === 0 &&
        laggingCount === 0;

      const checks: Record<string, 'ok' | 'warn' | 'fail'> = {
        health: 'ok',
        duplicates: diagnostics.duplicateRowsTotal === 0 ? 'ok' : 'fail',
        out_of_order: diagnostics.outOfOrderCountTotal === 0 ? 'ok' : 'fail',
        seam: seamIssueCount === 0 ? 'ok' : 'fail',
        gaps: diagnostics.gapCountTotal === 0 ? 'ok' : 'warn',
        lag: laggingCount > 0 ? 'warn' : staleCount > 0 ? 'warn' : 'ok',
      };

      const pass = structuralHealthy && (operationalHealthy || true);

      const dataQualityScore = computeDataQualityScore({
        duplicateRowsTotal: diagnostics.duplicateRowsTotal ?? 0,
        outOfOrderCountTotal: diagnostics.outOfOrderCountTotal ?? 0,
        seamIssueCount,
        gapCountTotal: diagnostics.gapCountTotal ?? 0,
        laggingSeriesCount: laggingCount,
        staleSeriesCount: staleCount,
      });

      const result: CandleDebugJobResult = {
        status: 'completed',
        structuralIntegrity: structuralHealthy ? 'healthy' : 'broken',
        operationalIntegrity: operationalHealthy
          ? 'healthy'
          : 'repair_recommended',
        checks,
        metrics: {
          duplicateRowsTotal: diagnostics.duplicateRowsTotal ?? 0,
          gapCountTotal: diagnostics.gapCountTotal ?? 0,
          outOfOrderCountTotal: diagnostics.outOfOrderCountTotal ?? 0,
          seamIssueCount,
        },
        pass: structuralHealthy,
        durationMs: Date.now() - startMs,
        dataQualityScore,
      };

      this.jobStore.update(jobId, {
        status: 'completed',
        stage: 'completed',
        progressPercent: 100,
        completedAt: new Date().toISOString(),
        result,
      });
    } catch (err) {
      const isCancelled =
        err instanceof Error && err.message === 'Job cancelled';
      const status = isCancelled ? 'cancelled' : 'failed';
      const error = err instanceof Error ? err.message : String(err);
      this.jobStore.update(jobId, {
        status,
        completedAt: new Date().toISOString(),
        error,
        result: {
          status: status as 'cancelled' | 'failed',
          error,
          durationMs: Date.now() - startMs,
        },
        ...(isCancelled && { cancelled: true }),
      });
      if (!isCancelled) {
        this.logger.error(`[verify job ${jobId}] failed: ${error}`);
      }
    }
  }
}
