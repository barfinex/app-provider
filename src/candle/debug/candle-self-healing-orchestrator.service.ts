import { Injectable, Logger, Optional } from '@nestjs/common';
import { CandleIntegrityIncidentStore } from './candle-integrity-incident.store';
import { CandleIntegrityEventStore } from './candle-integrity-event.store';
import {
  CandleIntegrityRecoveryPolicyService,
  PolicyResult,
} from './candle-integrity-recovery-policy.service';
import { CandleIntegrityImpactScoreService } from './candle-integrity-impact-score.service';
import {
  CandleIntegrityIncident,
  CandleIntegrityIncidentStatus,
  CandleIntegrityIncidentCategory,
  CandleIntegrityIncidentType,
  CandleIntegrityIncidentSeverity,
  CandleIntegrityIncidentScope,
  CandleIntegrityEvent,
  CandleIntegrityEventType,
  CandleIntegrityEventLevel,
} from './candle-integrity-incident.types';
import { CandleRepairJobOrchestrator } from './candle-repair-job.orchestrator';
import { CandleVerifyJobOrchestrator } from './candle-verify-job.orchestrator';
import { CandleDebugJobStore } from './candle-debug-job.store';
import {
  IntegrityAutoscanService,
  CachedScanResult,
} from './integrity-autoscan.service';
import { IntegrityAlertService } from './integrity-alert.service';
import { computeDataQualityScore } from './candle-debug-dashboard.service';
import { CandleDebugDashboardService } from './candle-debug-dashboard.service';

const COOLDOWN_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const MAX_AUTO_REPAIR_ATTEMPTS = 3;
/** After resolving an incident, do not trigger new repair for this many minutes. */
const COOLDOWN_AFTER_RESOLVE_MINUTES = 5;

export type AutoHealingState =
  | 'IDLE'
  | 'SCANNING'
  | 'REPAIR_RUNNING'
  | 'VERIFY_RUNNING'
  | 'COOLDOWN';

@Injectable()
export class CandleSelfHealingOrchestratorService {
  private readonly logger = new Logger(
    CandleSelfHealingOrchestratorService.name,
  );
  private cooldownUntilMs = 0;
  /** Per-incident last event id for event chaining (previousEventId). */
  private readonly lastEventIdByIncident = new Map<string, string>();

  constructor(
    private readonly incidentStore: CandleIntegrityIncidentStore,
    private readonly eventStore: CandleIntegrityEventStore,
    private readonly policyService: CandleIntegrityRecoveryPolicyService,
    private readonly impactScoreService: CandleIntegrityImpactScoreService,
    private readonly repairOrchestrator: CandleRepairJobOrchestrator,
    private readonly verifyOrchestrator: CandleVerifyJobOrchestrator,
    private readonly jobStore: CandleDebugJobStore,
    @Optional() private readonly autoscan?: IntegrityAutoscanService,
    @Optional() private readonly alertService?: IntegrityAlertService,
    @Optional() private readonly dashboardService?: CandleDebugDashboardService,
  ) {}

  /**
   * Called after autoscan completes with issues. Creates/updates incidents, emits events,
   * evaluates policy, and may start auto-repair (respecting mutex and cooldown).
   */
  async tryRecoverFromScanResult(cached: CachedScanResult): Promise<void> {
    const { diagnostics, seam, scannedAt } = cached;
    const seamIssueCount = (seam ?? []).filter(
      (s) => s.gapAtSeam || (s.rowsAtLastTs != null && s.rowsAtLastTs !== 1),
    ).length;
    const structuralBroken =
      (diagnostics.duplicateRowsTotal ?? 0) > 0 ||
      (diagnostics.outOfOrderCountTotal ?? 0) > 0 ||
      seamIssueCount > 0;
    const nowSec = Math.floor(Date.now() / 1000);
    let staleSeriesCount = 0;
    let laggingSeriesCount = 0;
    for (const s of diagnostics.series ?? []) {
      const lastTsSec = s.endTs != null ? Math.floor(s.endTs / 1000) : null;
      if (lastTsSec == null) continue;
      const lagSec = nowSec - lastTsSec;
      if (lagSec >= 180) laggingSeriesCount += 1;
      else if (lagSec >= 60) staleSeriesCount += 1;
    }
    const operationalIssues =
      (diagnostics.gapCountTotal ?? 0) > 0 ||
      staleSeriesCount > 0 ||
      laggingSeriesCount > 0;

    if (!structuralBroken && !operationalIssues) {
      return;
    }

    const dataQualityScore = computeDataQualityScore({
      duplicateRowsTotal: diagnostics.duplicateRowsTotal ?? 0,
      outOfOrderCountTotal: diagnostics.outOfOrderCountTotal ?? 0,
      seamIssueCount,
      gapCountTotal: diagnostics.gapCountTotal ?? 0,
      laggingSeriesCount,
      staleSeriesCount,
    });

    const incidentType = this.deriveIncidentType(
      diagnostics.duplicateRowsTotal ?? 0,
      diagnostics.outOfOrderCountTotal ?? 0,
      seamIssueCount,
      diagnostics.gapCountTotal ?? 0,
      staleSeriesCount,
      laggingSeriesCount,
    );
    const category: CandleIntegrityIncidentCategory = structuralBroken
      ? 'STRUCTURAL'
      : 'OPERATIONAL';

    const policyResult = this.policyService.evaluate({
      duplicateRowsTotal: diagnostics.duplicateRowsTotal ?? 0,
      outOfOrderCountTotal: diagnostics.outOfOrderCountTotal ?? 0,
      seamIssueCount,
      gapCountTotal: diagnostics.gapCountTotal ?? 0,
      staleSeriesCount,
      laggingSeriesCount,
      hasActiveRepairJob:
        this.repairOrchestrator.getRunningRepairJobId() != null,
      incidentType,
      dataQualityScore,
    });

    const dup = diagnostics.duplicateRowsTotal ?? 0;
    const gaps = diagnostics.gapCountTotal ?? 0;
    const firstSeam = (cached.seam ?? [])[0];
    const interval = firstSeam?.interval ?? 'h1';
    const symbol = firstSeam?.symbol;
    const scope: CandleIntegrityIncidentScope =
      firstSeam?.symbol && firstSeam?.interval ? 'SERIES' : 'GLOBAL';
    const impactResult = this.impactScoreService.compute({
      duplicateRowsTotal: dup,
      gapCountTotal: gaps,
      staleSeriesCount,
      laggingSeriesCount,
      interval,
      symbol,
      scope,
    });
    const incidentId = this.ensureIncident(
      cached,
      incidentType,
      category,
      policyResult,
      structuralBroken,
      operationalIssues,
      dataQualityScore,
      {
        impactScore: impactResult.score,
        impactScoreComponents: impactResult.components,
        scope,
        interval,
        symbol,
      },
    );

    this.emitEvent({
      eventType: 'INCIDENT_UPDATED',
      level: 'INFO',
      message: `Policy: ${policyResult.recommendedAction} - ${policyResult.reason}`,
      incidentId,
      payload: {
        autoRepairEligible: policyResult.autoRepairEligible,
        recommendedAction: policyResult.recommendedAction,
      },
    });

    if (policyResult.recommendedAction === 'CONNECTOR_RECOVERY') {
      this.emitEvent({
        eventType: 'CONNECTOR_RECOVERY_FAILED',
        level: 'WARN',
        message:
          'Connector recovery recommended but not available; escalate for manual recovery',
        incidentId,
      });
      this.incidentStore.update(incidentId, {
        status: 'ESCALATED',
        escalationReason: 'Connector recovery not available',
      });
      this.alertService?.maybeAlertConnectorStall?.({});
    } else if (
      policyResult.autoRepairEligible &&
      policyResult.recommendedAction !== 'NONE' &&
      policyResult.recommendedAction !== 'VERIFY_ONLY' &&
      policyResult.recommendedAction !== 'ESCALATE'
    ) {
      const state = this.getAutoHealingState();
      if (state === 'REPAIR_RUNNING' || state === 'COOLDOWN') {
        return;
      }
      const incident = this.incidentStore.get(incidentId);
      if (incident && this.canAttemptAutoRepair(incident)) {
        await this.startAutoRepair(incidentId);
      } else if (incident && !this.canAttemptAutoRepair(incident)) {
        this.incidentStore.update(incidentId, {
          status: 'ESCALATED',
          escalationReason: `Cooldown: max ${MAX_AUTO_REPAIR_ATTEMPTS} attempts in ${
            COOLDOWN_WINDOW_MS / 60000
          } min exceeded`,
        });
        this.emitEvent({
          eventType: 'INCIDENT_ESCALATED',
          level: 'WARN',
          message: 'Auto-repair skipped: cooldown exceeded',
          incidentId,
        });
        this.alertService?.maybeAlertIncidentEscalated?.({
          incidentId,
          severity: incident.severity,
          type: incident.type,
          seriesKey: incident.seriesKey,
          reason: 'Cooldown exceeded',
        });
      }
    }
  }

  /**
   * Process recovery state: check repair/verify jobs linked to incidents and transition states.
   * Call periodically (e.g. from cron or after autoscan).
   */
  processRecoveryState(): void {
    const list = this.incidentStore.list({
      limit: 500,
      offset: 0,
    });
    for (const inc of list.incidents) {
      if (inc.status !== 'AUTO_REPAIR_RUNNING') continue;
      if (inc.verifyJobId) {
        this.checkVerifyJobAndResolve(inc);
      } else if (inc.autoRepairJobId) {
        this.checkRepairJobAndStartVerify(inc);
      }
    }
  }

  private deriveIncidentType(
    dup: number,
    ooo: number,
    seam: number,
    gaps: number,
    stale: number,
    lagging: number,
  ): CandleIntegrityIncidentType {
    if (dup > 0) return 'DUPLICATES';
    if (ooo > 0) return 'OUT_OF_ORDER';
    if (seam > 0) return 'SEAM_ISSUE';
    if (gaps > 0 && stale === 0 && lagging === 0) return 'GAPS';
    if ((stale > 0 || lagging > 0) && gaps === 0 && dup === 0 && seam === 0)
      return 'STALE_SERIES';
    const types: CandleIntegrityIncidentType[] = [];
    if (dup > 0) types.push('DUPLICATES');
    if (ooo > 0) types.push('OUT_OF_ORDER');
    if (seam > 0) types.push('SEAM_ISSUE');
    if (gaps > 0) types.push('GAPS');
    if (stale > 0 || lagging > 0) types.push('STALE_SERIES');
    return types.length > 1 ? 'MIXED' : types[0] ?? 'GAPS';
  }

  private ensureIncident(
    cached: CachedScanResult,
    type: CandleIntegrityIncidentType,
    category: CandleIntegrityIncidentCategory,
    policy: PolicyResult,
    structuralBroken: boolean,
    operationalIssues: boolean,
    dataQualityScore: number,
    impact: {
      impactScore: number;
      impactScoreComponents?: Record<string, number | string>;
      scope: CandleIntegrityIncidentScope;
      interval?: string;
      symbol?: string;
    },
  ): string {
    const { diagnostics, seam } = cached;
    const seamIssueCount = (seam ?? []).filter(
      (s) => s.gapAtSeam || (s.rowsAtLastTs != null && s.rowsAtLastTs !== 1),
    ).length;
    const summary = this.buildSummary(
      diagnostics.duplicateRowsTotal ?? 0,
      diagnostics.outOfOrderCountTotal ?? 0,
      seamIssueCount,
      diagnostics.gapCountTotal ?? 0,
      type,
    );
    const now = new Date().toISOString();
    const firstSeam = (seam ?? [])[0];
    const connectorType = firstSeam?.connectorType ?? '';
    const marketType = firstSeam?.marketType ?? '';
    const symbol = firstSeam?.symbol ?? '';
    const interval = firstSeam?.interval ?? '';
    const scope = impact.scope;
    const identityKey =
      scope === 'GLOBAL'
        ? `${type}:${connectorType}:${marketType}:GLOBAL`
        : `${type}:${connectorType}:${marketType}:${symbol}:${interval}`;
    const existing = this.incidentStore.findOpenByIdentityKey(identityKey);
    if (existing) {
      this.incidentStore.update(existing.incidentId, {
        severity: policy.severity,
        summary,
        dataQualityScoreAtDetection: dataQualityScore,
        autoRepairEligible: policy.autoRepairEligible,
        recommendedAction: policy.recommendedAction,
        incidentImpactScore: impact.impactScore,
        impactScoreComponents: impact.impactScoreComponents,
        policyDecision: policy.recommendedAction,
        policyReason: policy.reason,
      });
      this.emitEvent({
        eventType: 'INCIDENT_UPDATED',
        level: 'INFO',
        message: summary,
        incidentId: existing.incidentId,
        payload: {
          type,
          category,
          recommendedAction: policy.recommendedAction,
        },
      });
      return existing.incidentId;
    }
    const incidentId = `inc-${Date.now()}-${Math.floor(
      100 + Math.random() * 900,
    )}`;
    const incident: CandleIntegrityIncident = {
      incidentId,
      status: 'OPEN',
      severity: policy.severity,
      category,
      type,
      detectedAt: now,
      updatedAt: now,
      connectorType: connectorType || undefined,
      marketType: marketType || undefined,
      symbol: symbol || undefined,
      interval: interval || undefined,
      seriesKey: firstSeam
        ? `${firstSeam.symbol}:${firstSeam.interval}:${firstSeam.connectorType}:${firstSeam.marketType}`
        : undefined,
      structuralIntegrityAtDetection: structuralBroken ? 'broken' : 'healthy',
      operationalIntegrityAtDetection: operationalIssues
        ? 'repair_recommended'
        : 'healthy',
      dataQualityScoreAtDetection: dataQualityScore,
      summary,
      details: undefined,
      autoRepairEligible: policy.autoRepairEligible,
      autoRepairAttempted: false,
      autoRepairAttemptCount: 0,
      recommendedAction: policy.recommendedAction,
      revision: 1,
      identityKey,
      scope,
      incidentImpactScore: impact.impactScore,
      impactScoreComponents: impact.impactScoreComponents,
      policyDecision: policy.recommendedAction,
      policyReason: policy.reason,
      attemptCount: 0,
    };
    this.incidentStore.create(incident);
    this.emitEvent({
      eventType: 'INCIDENT_OPENED',
      level: policy.severity === 'CRITICAL' ? 'ERROR' : 'WARN',
      message: summary,
      incidentId,
      payload: { type, category, recommendedAction: policy.recommendedAction },
    });
    return incidentId;
  }

  private buildSummary(
    dup: number,
    ooo: number,
    seam: number,
    gaps: number,
    type: CandleIntegrityIncidentType,
  ): string {
    const parts: string[] = [];
    if (dup > 0) parts.push(`${dup} duplicates`);
    if (ooo > 0) parts.push(`${ooo} out-of-order`);
    if (seam > 0) parts.push(`${seam} seam issues`);
    if (gaps > 0) parts.push(`${gaps} gaps`);
    const tail = parts.length ? ` (${parts.join(', ')})` : '';
    return `${type}${tail}`;
  }

  private canAttemptAutoRepair(incident: CandleIntegrityIncident): boolean {
    if (incident.autoRepairAttemptCount >= MAX_AUTO_REPAIR_ATTEMPTS) {
      const last = incident.lastAutoRepairAttemptAt
        ? new Date(incident.lastAutoRepairAttemptAt).getTime()
        : 0;
      if (Date.now() - last < COOLDOWN_WINDOW_MS) return false;
    }
    return true;
  }

  private async startAutoRepair(incidentId: string): Promise<void> {
    const incident = this.incidentStore.get(incidentId);
    if (!incident || incident.status !== 'OPEN') return;
    try {
      const response = this.repairOrchestrator.startRepairJob({
        mode: 'apply',
      });
      const now = new Date().toISOString();
      const attemptCount = incident.autoRepairAttemptCount + 1;
      this.incidentStore.update(incidentId, {
        status: 'AUTO_REPAIR_RUNNING',
        autoRepairJobId: response.jobId,
        autoRepairAttempted: true,
        autoRepairAttemptCount: attemptCount,
        lastAutoRepairAttemptAt: now,
        attemptCount,
        lastAttemptAt: now,
      });
      this.emitEvent({
        eventType: 'AUTO_REPAIR_STARTED',
        level: 'INFO',
        message: `Auto-repair started: job ${response.jobId}`,
        incidentId,
        jobId: response.jobId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const inc = this.incidentStore.get(incidentId);
      this.incidentStore.update(incidentId, {
        status: 'AUTO_REPAIR_FAILED',
        lastError: msg,
        autoRepairAttempted: true,
      });
      this.emitEvent({
        eventType: 'AUTO_REPAIR_FAILED',
        level: 'ERROR',
        message: msg,
        incidentId,
        error: msg,
      });
      this.alertService?.maybeAlertAutoRepairFailed?.({
        incidentId,
        severity: inc?.severity,
        type: inc?.type,
        seriesKey: inc?.seriesKey,
        recommendedAction: inc?.recommendedAction,
        message: msg,
      });
    }
  }

  private checkRepairJobAndStartVerify(
    incident: CandleIntegrityIncident,
  ): void {
    const job = incident.autoRepairJobId
      ? this.jobStore.get(incident.autoRepairJobId)
      : undefined;
    if (!job) return;
    if (
      job.status !== 'completed' &&
      job.status !== 'failed' &&
      job.status !== 'cancelled'
    )
      return;
    if (job.status === 'completed') {
      const response = this.verifyOrchestrator.startVerifyJob();
      this.incidentStore.update(incident.incidentId, {
        verifyJobId: response.jobId,
        lastSuccessfulRepairAt: new Date().toISOString(),
      });
      this.emitEvent({
        eventType: 'VERIFY_STARTED',
        level: 'INFO',
        message: `Post-repair verification started: job ${response.jobId}`,
        incidentId: incident.incidentId,
        jobId: response.jobId,
      });
    } else {
      this.incidentStore.update(incident.incidentId, {
        status: 'AUTO_REPAIR_FAILED',
        lastError: job.error,
        escalationReason: job.error,
      });
      this.incidentStore.update(incident.incidentId, { status: 'ESCALATED' });
      this.emitEvent({
        eventType: 'AUTO_REPAIR_FAILED',
        level: 'ERROR',
        message: job.error ?? 'Repair job failed',
        incidentId: incident.incidentId,
        jobId: job.jobId,
        error: job.error,
      });
    }
  }

  private checkVerifyJobAndResolve(incident: CandleIntegrityIncident): void {
    const job = incident.verifyJobId
      ? this.jobStore.get(incident.verifyJobId)
      : undefined;
    if (!job) return;
    if (
      job.status !== 'completed' &&
      job.status !== 'failed' &&
      job.status !== 'cancelled'
    )
      return;
    const pass = job.result?.pass === true;
    if (job.status === 'completed' && pass) {
      const now = new Date().toISOString();
      this.incidentStore.update(incident.incidentId, {
        status: 'RESOLVED',
        resolvedAt: now,
        lastSuccessfulVerifyAt: now,
      });
      this.cooldownUntilMs =
        Date.now() + COOLDOWN_AFTER_RESOLVE_MINUTES * 60 * 1000;
      this.emitEvent({
        eventType: 'INCIDENT_RESOLVED',
        level: 'INFO',
        message: 'Verification passed; incident resolved',
        incidentId: incident.incidentId,
        jobId: job.jobId,
      });
    } else {
      this.incidentStore.update(incident.incidentId, {
        status: 'ESCALATED',
        escalationReason:
          job.status === 'failed' ? job.error : 'Verification did not pass',
        lastError: job.error,
      });
      this.emitEvent({
        eventType:
          job.status === 'failed' ? 'VERIFY_FAILED' : 'INCIDENT_ESCALATED',
        level: 'WARN',
        message: job.error ?? 'Verification did not pass',
        incidentId: incident.incidentId,
        jobId: job.jobId,
        error: job.error,
      });
    }
  }

  private emitEvent(params: {
    eventType: CandleIntegrityEventType;
    level: CandleIntegrityEventLevel;
    message: string;
    incidentId?: string;
    jobId?: string;
    error?: string;
    payload?: Record<string, unknown>;
    durationMs?: number;
    previousEventId?: string;
    rootIncidentId?: string;
  }): void {
    const eventId = `evt-${Date.now()}-${Math.floor(
      100 + Math.random() * 900,
    )}`;
    const incidentId = params.incidentId;
    const previousEventId =
      params.previousEventId ??
      (incidentId ? this.lastEventIdByIncident.get(incidentId) : undefined);
    const event: CandleIntegrityEvent = {
      eventId,
      incidentId: params.incidentId,
      jobId: params.jobId,
      eventType: params.eventType,
      level: params.level,
      timestamp: new Date().toISOString(),
      message: params.message,
      payload: params.payload,
      error: params.error,
      durationMs: params.durationMs,
      previousEventId,
      rootIncidentId: params.rootIncidentId ?? params.incidentId,
    };
    this.eventStore.append(event);
    if (incidentId) {
      this.lastEventIdByIncident.set(incidentId, eventId);
    }
  }

  /** Operational state for autoscan: do not start recovery when REPAIR_RUNNING or COOLDOWN. */
  getAutoHealingState(): AutoHealingState {
    if (this.autoscan?.isScanning?.()) return 'SCANNING';
    if (this.repairOrchestrator.getRunningRepairJobId() != null)
      return 'REPAIR_RUNNING';
    const jobList = this.jobStore.list();
    const verifyRunning = (jobList ?? []).some(
      (j) =>
        j.type === 'verify' &&
        (j.status === 'started' || j.status === 'running'),
    );
    if (verifyRunning) return 'VERIFY_RUNNING';
    if (Date.now() < this.cooldownUntilMs) return 'COOLDOWN';
    return 'IDLE';
  }

  /** Manual retry: start repair for an incident (respects policy and mutex). */
  async retryIncident(
    incidentId: string,
  ): Promise<{ started: boolean; jobId?: string; error?: string }> {
    const incident = this.incidentStore.get(incidentId);
    if (!incident) return { started: false, error: 'Incident not found' };
    if (
      incident.status !== 'OPEN' &&
      incident.status !== 'AUTO_REPAIR_FAILED' &&
      incident.status !== 'ESCALATED'
    ) {
      return {
        started: false,
        error: `Invalid status for retry: ${incident.status}`,
      };
    }
    const running = this.repairOrchestrator.getRunningRepairJobId();
    if (running)
      return { started: false, error: `Repair already running: ${running}` };
    await this.startAutoRepair(incidentId);
    const updated = this.incidentStore.get(incidentId);
    const started = updated?.status === 'AUTO_REPAIR_RUNNING';
    return {
      started,
      jobId: updated?.autoRepairJobId,
      error: started ? undefined : 'Start repair failed',
    };
  }

  /** Manual escalate. */
  escalateIncident(incidentId: string, reason?: string): void {
    const incident = this.incidentStore.get(incidentId);
    if (!incident) return;
    this.incidentStore.update(incidentId, {
      status: 'ESCALATED',
      escalationReason: reason ?? 'Manual escalation',
    });
    this.emitEvent({
      eventType: 'INCIDENT_ESCALATED',
      level: 'WARN',
      message: reason ?? 'Manual escalation',
      incidentId,
    });
    this.alertService?.maybeAlertIncidentEscalated?.({
      incidentId,
      severity: incident.severity,
      type: incident.type,
      seriesKey: incident.seriesKey,
      reason: reason ?? 'Manual escalation',
    });
  }

  /** Manual ignore. */
  ignoreIncident(incidentId: string): void {
    this.incidentStore.update(incidentId, { status: 'IGNORED' });
    this.emitEvent({
      eventType: 'INCIDENT_UPDATED',
      level: 'INFO',
      message: 'Incident ignored by operator',
      incidentId,
    });
  }
}
