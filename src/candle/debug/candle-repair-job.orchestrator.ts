import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { CandleRepairService } from '../repair/candle-repair.service';
import { CandleRepairRequest } from '../repair/candle-repair.types';
import { RepairProgressReport } from '../repair/candle-repair.types';
import { CandleDebugJobStore } from './candle-debug-job.store';
import {
  CandleDebugJobStartResponse,
  CandleDebugJobResult,
  RepairJobStage,
} from './candle-debug-job.types';

@Injectable()
export class CandleRepairJobOrchestrator {
  private readonly logger = new Logger(CandleRepairJobOrchestrator.name);

  constructor(
    private readonly repairService: CandleRepairService,
    private readonly jobStore: CandleDebugJobStore,
  ) {}

  /** Returns the current running repair job id if any. Verification jobs may run concurrently. */
  getRunningRepairJobId(): string | null {
    const list = this.jobStore.list('repair');
    const running = (list ?? []).find(
      (j) => j.status === 'started' || j.status === 'running',
    );
    return running?.jobId ?? null;
  }

  startRepairJob(request: CandleRepairRequest): CandleDebugJobStartResponse {
    const currentJobId = this.getRunningRepairJobId();
    if (currentJobId != null) {
      throw new ConflictException({
        error: 'repair already running',
        jobId: currentJobId,
      });
    }
    const jobId = this.nextJobId();
    const startedAt = new Date().toISOString();
    this.jobStore.create({
      jobId,
      type: 'repair',
      status: 'running',
      stage: 'scanning_series',
      progressPercent: 0,
      startedAt,
    });

    void this.runRepairJob(jobId, request);
    return { jobId, status: 'started' };
  }

  private nextJobId(): string {
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = Math.floor(100 + Math.random() * 900);
    return `repair-${datePart}-${suffix}`;
  }

  private async runRepairJob(
    jobId: string,
    request: CandleRepairRequest,
  ): Promise<void> {
    const startMs = Date.now();
    const reportProgress = (report: RepairProgressReport): void => {
      if (this.jobStore.isCancelled(jobId)) {
        throw new Error('Job cancelled');
      }
      this.jobStore.update(jobId, {
        stage: report.stage as RepairJobStage,
        progressPercent: report.progressPercent,
        processedSeries: report.processedSeries,
        totalSeries: report.totalSeries,
        currentSeries: report.currentSeries,
        duplicatesFixed: report.duplicatesFixed,
        gapsFixed: report.gapsFixed,
      });
    };

    try {
      const response = await this.repairService.executeRepair(
        request,
        reportProgress,
      );
      const durationMs = Date.now() - startMs;
      const duplicatesFixed = response.results.reduce(
        (s, r) => s + r.repairedDuplicateRows,
        0,
      );
      const gapsFixed = response.results.reduce(
        (s, r) => s + r.repairedGapRanges,
        0,
      );
      const result: CandleDebugJobResult = {
        status: 'completed',
        duplicatesFixed,
        gapsFixed,
        durationMs,
        clean: response.clean,
      };
      this.jobStore.update(jobId, {
        status: 'completed',
        stage: 'completed',
        progressPercent: 100,
        completedAt: new Date().toISOString(),
        duplicatesFixed,
        gapsFixed,
        result,
      });
    } catch (err) {
      const isCancelled =
        err instanceof Error && err.message === 'Job cancelled';
      const status = isCancelled ? 'cancelled' : 'failed';
      const error = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startMs;
      this.jobStore.update(jobId, {
        status,
        completedAt: new Date().toISOString(),
        error,
        result: {
          status: status as 'cancelled' | 'failed',
          error,
          durationMs,
        },
        ...(isCancelled && { cancelled: true }),
      });
      if (!isCancelled) {
        this.logger.error(`[repair job ${jobId}] failed: ${error}`);
      }
    }
  }
}
