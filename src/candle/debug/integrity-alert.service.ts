import { Injectable, Logger } from '@nestjs/common';

const INTEGRITY_ALERT_WEBHOOK = 'INTEGRITY_ALERT_WEBHOOK';
const INTEGRITY_ALERT_SLACK = 'INTEGRITY_ALERT_SLACK';
const INTEGRITY_ALERT_TELEGRAM = 'INTEGRITY_ALERT_TELEGRAM';

/** Cooldown (ms) per incident+eventType to avoid noisy repeat alerts. ENV: CANDLE_INTEGRITY_ALERT_COOLDOWN_MS */
const ALERT_COOLDOWN_MS = Math.max(
  60_000,
  Number(process.env.CANDLE_INTEGRITY_ALERT_COOLDOWN_MS ?? 300_000),
);

export type IntegrityAlertEvent =
  | 'STRUCTURAL_INTEGRITY_FAILURE'
  | 'SEAM_ISSUES_DETECTED'
  | 'DUPLICATES_DETECTED'
  | 'AUTO_REPAIR_FAILED'
  | 'INCIDENT_ESCALATED'
  | 'CONNECTOR_STALL_CRITICAL';

export interface IntegrityAlertIncidentContext {
  incidentId?: string;
  severity?: string;
  type?: string;
  seriesKey?: string;
  recommendedAction?: string;
  autoRepairJobId?: string;
  verifyJobId?: string;
  structuralIntegrity?: string;
  operationalIntegrity?: string;
}

export interface IntegrityAlertPayload {
  event: IntegrityAlertEvent;
  duplicates?: number;
  seamIssues?: number;
  outOfOrder?: number;
  timestamp: string;
  /** Enrichment: incident context for ops */
  incident?: IntegrityAlertIncidentContext;
  message?: string;
}

@Injectable()
export class IntegrityAlertService {
  private readonly logger = new Logger(IntegrityAlertService.name);

  private readonly webhookUrl = process.env[INTEGRITY_ALERT_WEBHOOK];
  private readonly slackUrl = process.env[INTEGRITY_ALERT_SLACK];
  private readonly telegramUrl = process.env[INTEGRITY_ALERT_TELEGRAM];

  /** Cooldown key -> last sent timestamp (ms). Dedupe per incident+event. */
  private readonly cooldownUntil = new Map<string, number>();

  private shouldThrottle(
    incidentId: string | undefined,
    event: IntegrityAlertEvent,
  ): boolean {
    const key = `${incidentId ?? 'global'}:${event}`;
    const until = this.cooldownUntil.get(key);
    if (until == null) return false;
    if (Date.now() < until) return true;
    this.cooldownUntil.delete(key);
    return false;
  }

  private recordSent(
    incidentId: string | undefined,
    event: IntegrityAlertEvent,
  ): void {
    const key = `${incidentId ?? 'global'}:${event}`;
    this.cooldownUntil.set(key, Date.now() + ALERT_COOLDOWN_MS);
  }

  /** Non-blocking: fire-and-forget. Logs errors but does not throw. Respects cooldown per incident+event. */
  sendAlert(payload: IntegrityAlertPayload): void {
    if (this.shouldThrottle(payload.incident?.incidentId, payload.event)) {
      return;
    }
    const body = JSON.stringify({
      ...payload,
      timestamp: payload.timestamp ?? new Date().toISOString(),
    });
    const urls: string[] = [];
    if (this.webhookUrl) urls.push(this.webhookUrl);
    if (this.slackUrl) urls.push(this.slackUrl);
    if (this.telegramUrl) urls.push(this.telegramUrl);
    if (urls.length === 0) return;
    this.recordSent(payload.incident?.incidentId, payload.event);

    for (const url of urls) {
      void this.postUrl(url, body);
    }
  }

  private async postUrl(url: string, body: string): Promise<void> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        this.logger.warn(`Integrity alert POST ${url} returned ${res.status}`);
      }
    } catch (err) {
      this.logger.warn(
        `Integrity alert POST ${url} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Call when structural integrity becomes broken. Cooldown by event type (no incident id). */
  maybeAlertStructuralFailure(params: {
    duplicates: number;
    outOfOrder: number;
    seamIssues: number;
  }): void {
    if (
      params.duplicates === 0 &&
      params.outOfOrder === 0 &&
      params.seamIssues === 0
    )
      return;
    this.sendAlert({
      event: 'STRUCTURAL_INTEGRITY_FAILURE',
      duplicates: params.duplicates,
      seamIssues: params.seamIssues,
      outOfOrder: params.outOfOrder,
      timestamp: new Date().toISOString(),
    });
  }

  /** Call when seam issues are detected. */
  maybeAlertSeamIssues(seamIssues: number): void {
    if (seamIssues === 0) return;
    this.sendAlert({
      event: 'SEAM_ISSUES_DETECTED',
      seamIssues,
      timestamp: new Date().toISOString(),
    });
  }

  /** Call when duplicates appear. */
  maybeAlertDuplicates(duplicates: number): void {
    if (duplicates === 0) return;
    this.sendAlert({
      event: 'DUPLICATES_DETECTED',
      duplicates,
      timestamp: new Date().toISOString(),
    });
  }

  /** Call when auto-repair fails (with optional incident context). Non-blocking. */
  maybeAlertAutoRepairFailed(params: {
    incidentId?: string;
    severity?: string;
    type?: string;
    seriesKey?: string;
    recommendedAction?: string;
    autoRepairJobId?: string;
    message?: string;
  }): void {
    this.sendAlert({
      event: 'AUTO_REPAIR_FAILED',
      timestamp: new Date().toISOString(),
      message: params.message ?? 'Auto-repair failed',
      incident: {
        incidentId: params.incidentId,
        severity: params.severity,
        type: params.type,
        seriesKey: params.seriesKey,
        recommendedAction: params.recommendedAction,
        autoRepairJobId: params.autoRepairJobId,
      },
    });
  }

  /** Call when an incident is escalated. Non-blocking. */
  maybeAlertIncidentEscalated(params: {
    incidentId?: string;
    severity?: string;
    type?: string;
    seriesKey?: string;
    reason?: string;
  }): void {
    this.sendAlert({
      event: 'INCIDENT_ESCALATED',
      timestamp: new Date().toISOString(),
      message: params.reason ?? 'Incident escalated',
      incident: {
        incidentId: params.incidentId,
        severity: params.severity,
        type: params.type,
        seriesKey: params.seriesKey,
      },
    });
  }

  /** Call when connector stall is critical. Non-blocking. */
  maybeAlertConnectorStall(params: {
    connectorType?: string;
    marketType?: string;
  }): void {
    this.sendAlert({
      event: 'CONNECTOR_STALL_CRITICAL',
      timestamp: new Date().toISOString(),
      message: 'Connector stall: recovery recommended',
      incident: {
        type: 'CONNECTOR_STALL',
        severity: 'CRITICAL',
      },
    });
  }
}
