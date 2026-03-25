import { Injectable } from '@nestjs/common';
import {
  CandleIntegrityRecommendedAction,
  CandleIntegrityIncidentType,
  CandleIntegrityIncidentSeverity,
} from './candle-integrity-incident.types';

/** Configurable thresholds (ENV: CANDLE_INTEGRITY_DQS_OBSERVE, _AUTO_REPAIR, _ESCALATE). */
const DQS_OBSERVE_THRESHOLD = Math.min(
  100,
  Math.max(0, Number(process.env.CANDLE_INTEGRITY_DQS_OBSERVE ?? 95)),
);
const DQS_AUTO_REPAIR_BELOW = Math.min(
  100,
  Math.max(0, Number(process.env.CANDLE_INTEGRITY_DQS_AUTO_REPAIR_BELOW ?? 85)),
);
const DQS_ESCALATE_SEVERITY_BELOW = Math.min(
  100,
  Math.max(0, Number(process.env.CANDLE_INTEGRITY_DQS_ESCALATE_BELOW ?? 70)),
);

export interface PolicyInput {
  /** Structural */
  duplicateRowsTotal: number;
  outOfOrderCountTotal: number;
  seamIssueCount: number;
  /** Operational */
  gapCountTotal: number;
  staleSeriesCount: number;
  laggingSeriesCount: number;
  /** Context */
  hasActiveRepairJob: boolean;
  incidentType?: CandleIntegrityIncidentType;
  connectorStall?: boolean;
  /** Data quality score 0–100; used to soften/escalate policy */
  dataQualityScore?: number;
}

export interface PolicyResult {
  autoRepairEligible: boolean;
  reason: string;
  recommendedAction: CandleIntegrityRecommendedAction;
  severity: CandleIntegrityIncidentSeverity;
}

@Injectable()
export class CandleIntegrityRecoveryPolicyService {
  /**
   * Evaluate whether auto-recovery is allowed and what action is recommended.
   * Rules are conservative: structural issues generally escalate; operational issues may allow repair.
   */
  evaluate(input: PolicyInput): PolicyResult {
    const {
      duplicateRowsTotal,
      outOfOrderCountTotal,
      seamIssueCount,
      gapCountTotal,
      staleSeriesCount,
      laggingSeriesCount,
      hasActiveRepairJob,
      incidentType,
      connectorStall,
      dataQualityScore,
    } = input;

    if (dataQualityScore != null && dataQualityScore >= DQS_OBSERVE_THRESHOLD) {
      return {
        autoRepairEligible: false,
        reason: `Data quality score ${dataQualityScore} >= ${DQS_OBSERVE_THRESHOLD}; observe only`,
        recommendedAction: 'NONE',
        severity: 'INFO',
      };
    }

    if (hasActiveRepairJob) {
      return {
        autoRepairEligible: false,
        reason: 'A repair job is already running',
        recommendedAction: 'NONE',
        severity: 'WARN',
      };
    }

    if (connectorStall) {
      return {
        autoRepairEligible: false,
        reason:
          'Connector stall: prefer connector recovery before history repair',
        recommendedAction: 'CONNECTOR_RECOVERY',
        severity: 'CRITICAL',
      };
    }

    const structuralBroken =
      duplicateRowsTotal > 0 || outOfOrderCountTotal > 0 || seamIssueCount > 0;
    const operationalIssues =
      gapCountTotal > 0 || staleSeriesCount > 0 || laggingSeriesCount > 0;

    const escalateSeverityIfLowDqs = (base: PolicyResult): PolicyResult =>
      dataQualityScore != null && dataQualityScore < DQS_ESCALATE_SEVERITY_BELOW
        ? { ...base, severity: 'CRITICAL' as const }
        : base;

    if (duplicateRowsTotal > 0) {
      return escalateSeverityIfLowDqs({
        autoRepairEligible: false,
        reason:
          'Duplicates detected: auto-repair disabled, escalate for manual review',
        recommendedAction: 'ESCALATE',
        severity: 'CRITICAL',
      });
    }

    if (outOfOrderCountTotal > 0) {
      return {
        autoRepairEligible: false,
        reason: 'Out-of-order candles: escalate for targeted repair',
        recommendedAction: 'ESCALATE',
        severity: 'CRITICAL',
      };
    }

    if (seamIssueCount > 0) {
      return {
        autoRepairEligible: false,
        reason:
          'Seam issues: do not auto-repair aggressively; escalate unless safe targeted path exists',
        recommendedAction: 'ESCALATE',
        severity: 'CRITICAL',
      };
    }

    if (structuralBroken) {
      return {
        autoRepairEligible: false,
        reason: 'Structural integrity broken',
        recommendedAction: 'ESCALATE',
        severity: 'CRITICAL',
      };
    }

    const autoRepairAllowed =
      dataQualityScore == null || dataQualityScore < DQS_AUTO_REPAIR_BELOW;

    if (gapCountTotal > 0 && !operationalIssues) {
      return escalateSeverityIfLowDqs({
        autoRepairEligible: autoRepairAllowed,
        reason: autoRepairAllowed
          ? 'Gaps only, limited scope; auto-repair allowed'
          : `Data quality score ${dataQualityScore} >= ${DQS_AUTO_REPAIR_BELOW}; repair not auto-triggered`,
        recommendedAction: autoRepairAllowed ? 'TARGETED_REPAIR' : 'NONE',
        severity: 'WARN',
      });
    }

    if (gapCountTotal > 0) {
      return escalateSeverityIfLowDqs({
        autoRepairEligible: autoRepairAllowed,
        reason: autoRepairAllowed
          ? 'Gaps present; auto-repair allowed with verification'
          : `Data quality score ${dataQualityScore} >= ${DQS_AUTO_REPAIR_BELOW}; observe`,
        recommendedAction: autoRepairAllowed ? 'TARGETED_REPAIR' : 'NONE',
        severity: 'WARN',
      });
    }

    if (staleSeriesCount > 0 || laggingSeriesCount > 0) {
      return {
        autoRepairEligible: false,
        reason:
          'Stale/lagging series: verify or observe first; connector may recover',
        recommendedAction: 'VERIFY_ONLY',
        severity: 'WARN',
      };
    }

    if (incidentType === 'CONNECTOR_STALL') {
      return {
        autoRepairEligible: false,
        reason: 'Connector stall: connector recovery recommended',
        recommendedAction: 'CONNECTOR_RECOVERY',
        severity: 'CRITICAL',
      };
    }

    return {
      autoRepairEligible: false,
      reason: 'No actionable issue',
      recommendedAction: 'NONE',
      severity: 'INFO',
    };
  }
}
