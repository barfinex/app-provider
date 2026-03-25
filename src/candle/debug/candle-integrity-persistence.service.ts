import { Injectable, Logger, Optional } from '@nestjs/common';
import { QuestDBWriteService } from '../../questdb/questdb-write.service';
import { QuestDBQueryService } from '../../questdb/questdb-query.service';
import type { CandleIntegrityIncident } from './candle-integrity-incident.types';
import type { CandleIntegrityEvent } from './candle-integrity-incident.types';

const DEFAULT_RETENTION_DAYS = 30;
const INTEGRITY_CHANNEL = 'events' as const;

/** Non-blocking persistence of incidents and events to QuestDB. Retention configurable via ENV. */
@Injectable()
export class CandleIntegrityPersistenceService {
  private readonly logger = new Logger(CandleIntegrityPersistenceService.name);
  private readonly retentionDays: number;

  constructor(
    @Optional() private readonly writer?: QuestDBWriteService,
    @Optional() private readonly reader?: QuestDBQueryService,
  ) {
    const env = process.env.CANDLE_INTEGRITY_PERSISTENCE_RETENTION_DAYS;
    this.retentionDays =
      env != null && env !== ''
        ? Math.max(1, parseInt(env, 10) || DEFAULT_RETENTION_DAYS)
        : DEFAULT_RETENTION_DAYS;
  }

  /** Fire-and-forget write to both history and current snapshot (non-blocking). */
  writeIncident(incident: CandleIntegrityIncident): void {
    if (!this.writer) return;
    try {
      const updatedAt = incident.updatedAt
        ? new Date(incident.updatedAt).getTime()
        : Date.now();
      const detectedAt = incident.detectedAt
        ? new Date(incident.detectedAt).getTime()
        : null;
      const resolvedAt = incident.resolvedAt
        ? new Date(incident.resolvedAt).getTime()
        : null;
      const lastAttemptAt = incident.lastAttemptAt
        ? new Date(incident.lastAttemptAt).getTime()
        : null;
      const lastSuccessfulRepairAt = incident.lastSuccessfulRepairAt
        ? new Date(incident.lastSuccessfulRepairAt).getTime()
        : null;
      const lastSuccessfulVerifyAt = incident.lastSuccessfulVerifyAt
        ? new Date(incident.lastSuccessfulVerifyAt).getTime()
        : null;
      const tsNs = BigInt(updatedAt) * 1_000_000n;
      const baseRow = {
        table: 'candle_integrity_incidents',
        keys: {
          incident_id: incident.incidentId,
          status: incident.status,
          severity: incident.severity,
          category: incident.category,
          type: incident.type,
          connectorType: incident.connectorType ?? '',
          marketType: incident.marketType ?? '',
          symbol: incident.symbol ?? '',
          interval: incident.interval ?? '',
          seriesKey: incident.seriesKey ?? '',
          repairJobId: incident.autoRepairJobId ?? '',
          verifyJobId: incident.verifyJobId ?? '',
          identity_key: incident.identityKey ?? '',
        },
        fields: {
          summary: incident.summary ?? '',
          details: incident.details ?? '',
          dataQualityScore: BigInt(
            Math.trunc(incident.dataQualityScoreAtDetection ?? 0),
          ),
          autoRepairEligible: incident.autoRepairEligible ?? false,
          autoRepairAttempted: incident.autoRepairAttempted ?? false,
          revision: BigInt(Math.trunc(incident.revision ?? 0)),
          impact_score: incident.incidentImpactScore ?? 0,
          detected_at_ms: BigInt(Math.trunc(detectedAt ?? 0)),
          resolved_at_ms: BigInt(Math.trunc(resolvedAt ?? 0)),
        },
        timestampNs: tsNs,
      };
      this.writer.write(INTEGRITY_CHANNEL, baseRow);

      // Current snapshot table (same row + audit/scope fields for fast-path reads)
      this.writer.write(INTEGRITY_CHANNEL, {
        ...baseRow,
        table: 'candle_integrity_incidents_current',
        keys: {
          ...baseRow.keys,
          scope: incident.scope ?? 'SERIES',
          policy_decision: incident.policyDecision ?? '',
        },
        fields: {
          ...baseRow.fields,
          policy_reason: incident.policyReason ?? '',
          attempt_count: BigInt(Math.trunc(incident.attemptCount ?? 0)),
          last_attempt_at_ms: BigInt(Math.trunc(lastAttemptAt ?? 0)),
          last_successful_repair_at_ms: BigInt(
            Math.trunc(lastSuccessfulRepairAt ?? 0),
          ),
          last_successful_verify_at_ms: BigInt(
            Math.trunc(lastSuccessfulVerifyAt ?? 0),
          ),
        },
      });
    } catch (e) {
      this.logger.warn(
        `Failed to persist incident ${incident.incidentId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Fire-and-forget write (non-blocking). */
  writeEvent(event: CandleIntegrityEvent): void {
    if (!this.writer) return;
    try {
      const ts = event.timestamp
        ? new Date(event.timestamp).getTime()
        : Date.now();
      const tsNs = BigInt(ts) * 1_000_000n;
      this.writer.write(INTEGRITY_CHANNEL, {
        table: 'candle_integrity_events',
        keys: {
          eventType: event.eventType,
          level: event.level,
          incidentId: event.incidentId ?? '',
          jobId: event.jobId ?? '',
          event_id: event.eventId,
          previousEventId: event.previousEventId ?? '',
          rootIncidentId: event.rootIncidentId ?? '',
        },
        fields: {
          message: event.message ?? '',
          payload: event.payload ? JSON.stringify(event.payload) : '',
          error: event.error ?? '',
          durationMs: BigInt(Math.trunc(event.durationMs ?? 0)),
        },
        timestampNs: tsNs,
      });
    } catch (e) {
      this.logger.warn(
        `Failed to persist event ${event.eventId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Load incidents from history table (LATEST BY incident_id) for hydration. Use for audit/timeline. */
  async loadIncidents(): Promise<CandleIntegrityIncident[]> {
    if (!this.reader) return [];
    try {
      const cutoff = `dateadd('d', -${Math.max(1, this.retentionDays)}, now())`;
      const sql = `SELECT * FROM candle_integrity_incidents LATEST BY incident_id WHERE updated_at > ${cutoff}`;
      const rows = await this.reader.queryAsObjects(sql);
      if (!Array.isArray(rows)) return [];
      return rows
        .map((r) => this.rowToIncident(r))
        .filter((i): i is CandleIntegrityIncident => i != null);
    } catch (e) {
      this.logger.warn(
        `Failed to load incidents from QuestDB: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return [];
    }
  }

  /** Load current snapshot from candle_integrity_incidents_current (fast path for dashboard/list). */
  async loadIncidentsFromCurrent(): Promise<CandleIntegrityIncident[]> {
    if (!this.reader) return [];
    try {
      const cutoff = `dateadd('d', -${Math.max(1, this.retentionDays)}, now())`;
      const sql = `SELECT * FROM candle_integrity_incidents_current LATEST BY incident_id WHERE updated_at > ${cutoff}`;
      const rows = await this.reader.queryAsObjects(sql);
      if (!Array.isArray(rows)) return [];
      return rows
        .map((r) => this.rowToIncident(r))
        .filter((i): i is CandleIntegrityIncident => i != null);
    } catch (e) {
      this.logger.warn(
        `Failed to load incidents current from QuestDB: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return [];
    }
  }

  /** Load events from QuestDB for hydration on startup. */
  async loadEvents(): Promise<CandleIntegrityEvent[]> {
    if (!this.reader) return [];
    try {
      const cutoff = `dateadd('d', -${Math.max(1, this.retentionDays)}, now())`;
      const sql = `SELECT * FROM candle_integrity_events WHERE ts > ${cutoff} ORDER BY ts DESC LIMIT 50000`;
      const rows = await this.reader.queryAsObjects(sql);
      if (!Array.isArray(rows)) return [];
      return rows
        .map((r) => this.rowToEvent(r))
        .filter((e): e is CandleIntegrityEvent => e != null);
    } catch (e) {
      this.logger.warn(
        `Failed to load events from QuestDB: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return [];
    }
  }

  getRetentionDays(): number {
    return this.retentionDays;
  }

  private rowToIncident(
    r: Record<string, unknown>,
  ): CandleIntegrityIncident | null {
    const incidentId = String(r?.incident_id ?? '');
    if (!incidentId) return null;
    const updatedAt =
      r?.updated_at != null
        ? new Date(r.updated_at as string | number).toISOString()
        : new Date().toISOString();
    const detectedAt =
      r?.detected_at_ms != null && Number(r.detected_at_ms) > 0
        ? new Date(Number(r.detected_at_ms)).toISOString()
        : r?.detected_at != null
        ? new Date(r.detected_at as string | number).toISOString()
        : updatedAt;
    return {
      incidentId,
      status: String(r?.status ?? 'OPEN') as CandleIntegrityIncident['status'],
      severity: String(
        r?.severity ?? 'WARN',
      ) as CandleIntegrityIncident['severity'],
      category: String(
        r?.category ?? 'OPERATIONAL',
      ) as CandleIntegrityIncident['category'],
      type: String(r?.type ?? 'GAPS') as CandleIntegrityIncident['type'],
      detectedAt,
      updatedAt,
      resolvedAt:
        r?.resolved_at_ms != null && Number(r.resolved_at_ms) > 0
          ? new Date(Number(r.resolved_at_ms)).toISOString()
          : r?.resolved_at != null
          ? new Date(r.resolved_at as string | number).toISOString()
          : undefined,
      connectorType:
        r?.connectorType != null ? String(r.connectorType) : undefined,
      marketType: r?.marketType != null ? String(r.marketType) : undefined,
      symbol: r?.symbol != null ? String(r.symbol) : undefined,
      interval: r?.interval != null ? String(r.interval) : undefined,
      seriesKey: r?.seriesKey != null ? String(r.seriesKey) : undefined,
      structuralIntegrityAtDetection: 'healthy',
      operationalIntegrityAtDetection: 'healthy',
      dataQualityScoreAtDetection:
        typeof r?.dataQualityScore === 'number'
          ? r.dataQualityScore
          : undefined,
      summary: String(r?.summary ?? ''),
      details: r?.details != null ? String(r.details) : undefined,
      autoRepairEligible: Boolean(r?.autoRepairEligible),
      autoRepairAttempted: Boolean(r?.autoRepairAttempted),
      autoRepairJobId:
        r?.repairJobId != null ? String(r.repairJobId) : undefined,
      verifyJobId: r?.verifyJobId != null ? String(r.verifyJobId) : undefined,
      recommendedAction: undefined,
      autoRepairAttemptCount: 0,
      revision: typeof r?.revision === 'number' ? r.revision : undefined,
      identityKey: r?.identity_key != null ? String(r.identity_key) : undefined,
      incidentImpactScore:
        typeof r?.impact_score === 'number' ? r.impact_score : undefined,
      scope:
        r?.scope != null && (r.scope === 'SERIES' || r.scope === 'GLOBAL')
          ? r.scope
          : undefined,
      policyDecision:
        r?.policy_decision != null && String(r.policy_decision) !== ''
          ? (String(
              r.policy_decision,
            ) as import('./candle-integrity-incident.types').CandleIntegrityRecommendedAction)
          : undefined,
      policyReason:
        r?.policy_reason != null ? String(r.policy_reason) : undefined,
      attemptCount:
        typeof r?.attempt_count === 'number' ? r.attempt_count : undefined,
      lastAttemptAt:
        r?.last_attempt_at_ms != null && Number(r.last_attempt_at_ms) > 0
          ? new Date(Number(r.last_attempt_at_ms)).toISOString()
          : undefined,
      lastSuccessfulRepairAt:
        r?.last_successful_repair_at_ms != null &&
        Number(r.last_successful_repair_at_ms) > 0
          ? new Date(Number(r.last_successful_repair_at_ms)).toISOString()
          : undefined,
      lastSuccessfulVerifyAt:
        r?.last_successful_verify_at_ms != null &&
        Number(r.last_successful_verify_at_ms) > 0
          ? new Date(Number(r.last_successful_verify_at_ms)).toISOString()
          : undefined,
    };
  }

  private rowToEvent(r: Record<string, unknown>): CandleIntegrityEvent | null {
    const eventId = String(r?.event_id ?? r?.eventId ?? '');
    if (!eventId) return null;
    const ts =
      r?.ts != null
        ? new Date(r.ts as string | number).toISOString()
        : new Date().toISOString();
    let payload: Record<string, unknown> | undefined;
    if (r?.payload != null && typeof r.payload === 'string') {
      try {
        payload = JSON.parse(r.payload) as Record<string, unknown>;
      } catch {
        payload = undefined;
      }
    }
    return {
      eventId,
      incidentId:
        r?.incidentId != null && r.incidentId !== ''
          ? String(r.incidentId)
          : undefined,
      jobId: r?.jobId != null && r.jobId !== '' ? String(r.jobId) : undefined,
      eventType: String(
        r?.eventType ?? 'INCIDENT_UPDATED',
      ) as CandleIntegrityEvent['eventType'],
      level: String(r?.level ?? 'INFO') as CandleIntegrityEvent['level'],
      timestamp: ts,
      message: String(r?.message ?? ''),
      payload,
      error: r?.error != null ? String(r.error) : undefined,
      durationMs: typeof r?.durationMs === 'number' ? r.durationMs : undefined,
      previousEventId:
        r?.previousEventId != null && r.previousEventId !== ''
          ? String(r.previousEventId)
          : undefined,
      rootIncidentId:
        r?.rootIncidentId != null && r.rootIncidentId !== ''
          ? String(r.rootIncidentId)
          : undefined,
    };
  }
}
