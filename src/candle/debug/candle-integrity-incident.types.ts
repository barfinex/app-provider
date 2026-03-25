/**
 * Candle Integrity Incident and Event domain model for self-healing pipeline.
 * Used by incident store, event store, policy, and orchestrator.
 */

export type CandleIntegrityIncidentStatus =
  | 'OPEN'
  | 'AUTO_REPAIR_RUNNING'
  | 'AUTO_REPAIR_FAILED'
  | 'RESOLVED'
  | 'ESCALATED'
  | 'IGNORED';

export type CandleIntegrityIncidentSeverity = 'INFO' | 'WARN' | 'CRITICAL';

export type CandleIntegrityIncidentCategory =
  | 'STRUCTURAL'
  | 'OPERATIONAL'
  | 'INGESTION';

export type CandleIntegrityIncidentType =
  | 'DUPLICATES'
  | 'SEAM_ISSUE'
  | 'OUT_OF_ORDER'
  | 'GAPS'
  | 'STALE_SERIES'
  | 'CONNECTOR_STALL'
  | 'MIXED';

/** Incident scope for deduplication: SERIES = per symbol/interval; GLOBAL = connector/market-wide. */
export type CandleIntegrityIncidentScope = 'SERIES' | 'GLOBAL';

export type CandleIntegrityRecommendedAction =
  | 'NONE'
  | 'TARGETED_REPAIR'
  | 'FULL_REPAIR'
  | 'VERIFY_ONLY'
  | 'CONNECTOR_RECOVERY'
  | 'ESCALATE';

export interface CandleIntegrityIncident {
  incidentId: string;
  status: CandleIntegrityIncidentStatus;
  severity: CandleIntegrityIncidentSeverity;
  category: CandleIntegrityIncidentCategory;
  type: CandleIntegrityIncidentType;
  detectedAt: string; // ISO
  updatedAt: string;
  resolvedAt?: string;
  connectorType?: string;
  marketType?: string;
  symbol?: string;
  interval?: string;
  seriesKey?: string;
  structuralIntegrityAtDetection: 'healthy' | 'broken';
  operationalIntegrityAtDetection: 'healthy' | 'repair_recommended';
  dataQualityScoreAtDetection?: number;
  summary: string;
  details?: string;
  autoRepairEligible: boolean;
  autoRepairAttempted: boolean;
  autoRepairJobId?: string;
  verifyJobId?: string;
  escalationReason?: string;
  lastError?: string;
  /** Policy decision at last evaluation */
  recommendedAction?: CandleIntegrityRecommendedAction;
  /** Anti-loop: count of auto-repair attempts for this incident */
  autoRepairAttemptCount: number;
  /** Anti-loop: last time auto-repair was attempted (ISO) */
  lastAutoRepairAttemptAt?: string;
  /** Deduplication: version of this incident (incremented on each update) */
  revision?: number;
  /** Deduplication: identity key = type:connectorType:marketType:symbol:interval (SERIES) or type:connectorType:marketType:GLOBAL */
  identityKey?: string;
  /** Scope for deduplication: SERIES (per symbol/interval) or GLOBAL */
  scope?: CandleIntegrityIncidentScope;
  /** Computed impact score for prioritization (configurable weights × interval/symbol multipliers) */
  incidentImpactScore?: number;
  /** Explainable impact components for UI (duplicates, gaps, stale, lag, intervalMultiplier, symbolMultiplier) */
  impactScoreComponents?: Record<string, number | string>;
  /** Recovery audit: number of repair/verify attempts */
  attemptCount?: number;
  /** Recovery audit: last attempt time (ISO) */
  lastAttemptAt?: string;
  /** Recovery audit: last successful repair completion (ISO) */
  lastSuccessfulRepairAt?: string;
  /** Recovery audit: last successful verify completion (ISO) */
  lastSuccessfulVerifyAt?: string;
  /** Policy decision at last evaluation (NONE, TARGETED_REPAIR, etc.) */
  policyDecision?: CandleIntegrityRecommendedAction;
  /** Policy reason text */
  policyReason?: string;
}

export type CandleIntegrityEventType =
  | 'SCAN_STARTED'
  | 'SCAN_COMPLETED'
  | 'SCAN_FAILED'
  | 'WATCHDOG_WARN'
  | 'WATCHDOG_CRITICAL'
  | 'INCIDENT_OPENED'
  | 'INCIDENT_UPDATED'
  | 'AUTO_REPAIR_SCHEDULED'
  | 'AUTO_REPAIR_STARTED'
  | 'AUTO_REPAIR_COMPLETED'
  | 'AUTO_REPAIR_FAILED'
  | 'AUTO_REPAIR_SKIPPED'
  | 'VERIFY_STARTED'
  | 'VERIFY_COMPLETED'
  | 'VERIFY_FAILED'
  | 'INCIDENT_RESOLVED'
  | 'INCIDENT_ESCALATED'
  | 'CONNECTOR_RECONNECT_REQUESTED'
  | 'CONNECTOR_RECOVERY_FAILED';

export type CandleIntegrityEventLevel = 'INFO' | 'WARN' | 'ERROR';

export interface CandleIntegrityEvent {
  eventId: string;
  incidentId?: string;
  jobId?: string;
  eventType: CandleIntegrityEventType;
  level: CandleIntegrityEventLevel;
  timestamp: string; // ISO
  durationMs?: number;
  message: string;
  payload?: Record<string, unknown>;
  error?: string;
  /** Correlation: previous event in chain */
  previousEventId?: string;
  /** Correlation: root incident for RCA */
  rootIncidentId?: string;
  /** Optional severity for timeline display */
  severity?: string;
}

export interface IncidentListFilters {
  status?: CandleIntegrityIncidentStatus;
  severity?: CandleIntegrityIncidentSeverity;
  category?: CandleIntegrityIncidentCategory;
  type?: CandleIntegrityIncidentType;
  symbol?: string;
  connectorType?: string;
  marketType?: string;
  interval?: string;
  limit?: number;
  offset?: number;
}

export interface EventListFilters {
  incidentId?: string;
  eventType?: CandleIntegrityEventType;
  level?: CandleIntegrityEventLevel;
  from?: string; // ISO
  to?: string; // ISO
  limit?: number;
  offset?: number;
}

export interface IncidentListResult {
  incidents: CandleIntegrityIncident[];
  total: number;
  limit: number;
  offset: number;
}

export interface EventListResult {
  events: CandleIntegrityEvent[];
  total: number;
  limit: number;
  offset: number;
}

export type AutoHealingStatus =
  | 'IDLE'
  | 'SCANNING'
  | 'REPAIR_RUNNING'
  | 'VERIFY_RUNNING'
  | 'COOLDOWN'
  | 'RECOVERY_RUNNING' // legacy alias
  | 'VERIFYING' // legacy alias
  | 'DEGRADED';
