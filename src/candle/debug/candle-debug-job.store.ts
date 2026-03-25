import { Injectable } from '@nestjs/common';
import {
  CandleDebugJobRecord,
  CandleDebugJobStatus,
  CandleDebugJobType,
  CandleDebugJobListItem,
  CandleDebugJobStatusResponse,
  RepairJobStage,
} from './candle-debug-job.types';

const HEARTBEAT_THRESHOLD_MS = 10_000;

function computeElapsedSeconds(startedAt: string): number {
  return Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
}

@Injectable()
export class CandleDebugJobStore {
  private readonly jobs = new Map<string, CandleDebugJobRecord>();

  create(record: Omit<CandleDebugJobRecord, 'lastProgressAt'>): void {
    const now = Date.now();
    this.jobs.set(record.jobId, {
      ...record,
      lastProgressAt: now,
    });
  }

  update(
    jobId: string,
    patch: Partial<
      Pick<
        CandleDebugJobRecord,
        | 'status'
        | 'stage'
        | 'progressPercent'
        | 'processedSeries'
        | 'totalSeries'
        | 'currentSeries'
        | 'duplicatesFixed'
        | 'gapsFixed'
        | 'completedAt'
        | 'error'
        | 'result'
        | 'cancelled'
      >
    >,
  ): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const now = Date.now();
    if (
      patch.status !== undefined ||
      patch.stage !== undefined ||
      patch.progressPercent !== undefined ||
      patch.processedSeries !== undefined ||
      patch.duplicatesFixed !== undefined ||
      patch.gapsFixed !== undefined ||
      patch.currentSeries !== undefined
    ) {
      (job as CandleDebugJobRecord).lastProgressAt = now;
    }
    Object.assign(job, patch);
  }

  get(jobId: string): CandleDebugJobRecord | undefined {
    return this.jobs.get(jobId);
  }

  getStatus(jobId: string): CandleDebugJobStatusResponse | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    const now = Date.now();
    const elapsedSeconds = Math.floor(
      (now - new Date(job.startedAt).getTime()) / 1000,
    );
    const heartbeat =
      job.status === 'running' &&
      now - job.lastProgressAt >= HEARTBEAT_THRESHOLD_MS;
    return {
      jobId: job.jobId,
      type: job.type,
      status: job.status,
      stage: job.stage,
      progressPercent: job.progressPercent,
      processedSeries: job.processedSeries,
      totalSeries: job.totalSeries,
      currentSeries: job.currentSeries,
      duplicatesFixed: job.duplicatesFixed,
      gapsFixed: job.gapsFixed,
      startedAt: job.startedAt,
      elapsedSeconds,
      ...(heartbeat && { heartbeat: true }),
      error: job.error,
    };
  }

  list(typeFilter?: CandleDebugJobType): CandleDebugJobListItem[] {
    const now = Date.now();
    return Array.from(this.jobs.values())
      .filter((j) => (typeFilter == null ? true : j.type === typeFilter))
      .map((j) => {
        const elapsedSeconds = computeElapsedSeconds(j.startedAt);
        const heartbeat =
          (j.status === 'started' || j.status === 'running') &&
          now - j.lastProgressAt >= HEARTBEAT_THRESHOLD_MS;
        return {
          jobId: j.jobId,
          type: j.type,
          status: j.status,
          progressPercent: j.progressPercent,
          stage: j.stage,
          currentSeries: j.currentSeries,
          startedAt: j.startedAt,
          elapsedSeconds,
          ...(heartbeat && { heartbeat: true }),
        };
      });
  }

  requestCancel(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || (job.status !== 'running' && job.status !== 'started'))
      return false;
    (job as CandleDebugJobRecord).cancelled = true;
    return true;
  }

  isCancelled(jobId: string): boolean {
    return this.jobs.get(jobId)?.cancelled === true;
  }
}
