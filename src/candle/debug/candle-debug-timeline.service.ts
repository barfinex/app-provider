import { Injectable, Optional } from '@nestjs/common';
import { CandleIntegrityEventStore } from './candle-integrity-event.store';
import { CandleIntegrityIncidentStore } from './candle-integrity-incident.store';
import { CandleDebugJobStore } from './candle-debug-job.store';

export interface TimelineItem {
  kind: 'event' | 'incident' | 'job';
  timestamp: string;
  id: string;
  level?: string;
  message: string;
  eventType?: string;
  incidentId?: string;
  jobId?: string;
  jobType?: string;
  status?: string;
  durationMs?: number;
  severity?: string;
  previousEventId?: string;
  rootIncidentId?: string;
}

@Injectable()
export class CandleDebugTimelineService {
  constructor(
    private readonly eventStore: CandleIntegrityEventStore,
    @Optional() private readonly incidentStore?: CandleIntegrityIncidentStore,
    @Optional() private readonly jobStore?: CandleDebugJobStore,
  ) {}

  /**
   * Return a merged operational timeline (events + recent incidents + recent jobs) for UI.
   * Sorted by timestamp descending (newest first).
   */
  getTimeline(params: {
    from?: string;
    to?: string;
    limit?: number;
    incidentId?: string;
    eventType?: string;
    severity?: string;
  }): { items: TimelineItem[]; total: number } {
    const limit = Math.min(Math.max(1, params.limit ?? 100), 200);
    const eventFilters = {
      from: params.from,
      to: params.to,
      incidentId: params.incidentId,
      eventType: params.eventType as
        | import('./candle-integrity-incident.types').CandleIntegrityEventType
        | undefined,
      level: params.severity as
        | import('./candle-integrity-incident.types').CandleIntegrityEventLevel
        | undefined,
      limit: limit * 2,
      offset: 0,
    };
    const eventResult = this.eventStore.listReverseChrono(eventFilters);
    const items: TimelineItem[] = eventResult.events.map((e) => ({
      kind: 'event' as const,
      timestamp: e.timestamp,
      id: e.eventId,
      level: e.level,
      message: e.message,
      eventType: e.eventType,
      incidentId: e.incidentId,
      jobId: e.jobId,
      durationMs: e.durationMs,
      severity: e.severity ?? e.level,
      previousEventId: e.previousEventId,
      rootIncidentId: e.rootIncidentId,
    }));

    if (params.incidentId) {
      const incident = this.incidentStore?.get(params.incidentId);
      if (incident) {
        items.push({
          kind: 'incident',
          timestamp: incident.detectedAt,
          id: incident.incidentId,
          message: incident.summary,
          incidentId: incident.incidentId,
          status: incident.status,
        });
      }
    }

    if (this.jobStore && !params.incidentId) {
      const jobs = this.jobStore.list();
      for (const j of jobs.slice(-20)) {
        const startedAt = (j as { startedAt?: string }).startedAt;
        if (startedAt) {
          items.push({
            kind: 'job',
            timestamp: startedAt,
            id: j.jobId,
            message: `${j.type} job ${j.status}`,
            jobId: j.jobId,
            jobType: j.type,
            status: j.status,
          });
        }
      }
    }

    items.sort((a, b) =>
      b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0,
    );
    const trimmed = items.slice(0, limit);
    return {
      items: trimmed,
      total: eventResult.total + (items.length - eventResult.events.length),
    };
  }
}
