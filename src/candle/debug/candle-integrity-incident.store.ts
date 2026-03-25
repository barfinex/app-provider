import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import {
  type CandleIntegrityIncident,
  type IncidentListFilters,
  type IncidentListResult,
} from './candle-integrity-incident.types';
import type { CandleIntegrityPersistenceService } from './candle-integrity-persistence.service';

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_INCIDENTS = 5000;

@Injectable()
export class CandleIntegrityIncidentStore implements OnModuleInit {
  private readonly incidents = new Map<string, CandleIntegrityIncident>();
  private readonly order: string[] = []; // incidentId insertion order for pagination
  private readonly retentionDays: number;
  private readonly maxIncidents: number;
  private hydrationDone = false;

  constructor(
    @Optional()
    private readonly persistence?: CandleIntegrityPersistenceService,
  ) {
    this.retentionDays =
      typeof process.env.CANDLE_INTEGRITY_INCIDENT_RETENTION_DAYS !==
      'undefined'
        ? Math.max(
            1,
            parseInt(
              process.env.CANDLE_INTEGRITY_INCIDENT_RETENTION_DAYS,
              10,
            ) || 7,
          )
        : DEFAULT_RETENTION_DAYS;
    this.maxIncidents =
      typeof process.env.CANDLE_INTEGRITY_INCIDENT_MAX_RECORDS !== 'undefined'
        ? Math.max(
            100,
            parseInt(process.env.CANDLE_INTEGRITY_INCIDENT_MAX_RECORDS, 10) ||
              5000,
          )
        : DEFAULT_MAX_INCIDENTS;
  }

  async onModuleInit(): Promise<void> {
    if (!this.persistence) return;
    try {
      // Prefer current snapshot table for fast hydration; fallback to history
      let loaded: CandleIntegrityIncident[];
      if (
        'loadIncidentsFromCurrent' in this.persistence &&
        typeof (
          this.persistence as {
            loadIncidentsFromCurrent?(): Promise<CandleIntegrityIncident[]>;
          }
        ).loadIncidentsFromCurrent === 'function'
      ) {
        try {
          loaded = await (
            this.persistence as {
              loadIncidentsFromCurrent(): Promise<CandleIntegrityIncident[]>;
            }
          ).loadIncidentsFromCurrent();
        } catch {
          loaded = await this.persistence.loadIncidents();
        }
      } else {
        loaded = await this.persistence.loadIncidents();
      }
      for (const inc of loaded) {
        this.incidents.set(inc.incidentId, inc);
        if (!this.order.includes(inc.incidentId))
          this.order.push(inc.incidentId);
      }
      this.hydrationDone = true;
    } catch {
      this.hydrationDone = true;
    }
  }

  create(incident: CandleIntegrityIncident): void {
    this.ensureRetention();
    if (this.incidents.size >= this.maxIncidents) {
      this.dropOldest();
    }
    this.incidents.set(incident.incidentId, { ...incident });
    if (!this.order.includes(incident.incidentId)) {
      this.order.push(incident.incidentId);
    }
    this.persistence?.writeIncident(incident);
  }

  update(
    incidentId: string,
    patch: Partial<
      Omit<
        CandleIntegrityIncident,
        | 'incidentId'
        | 'detectedAt'
        | 'structuralIntegrityAtDetection'
        | 'operationalIntegrityAtDetection'
      >
    >,
  ): void {
    const inc = this.incidents.get(incidentId);
    if (!inc) return;
    const revision = (inc.revision ?? 0) + 1;
    const updated: CandleIntegrityIncident = {
      ...inc,
      ...patch,
      updatedAt: new Date().toISOString(),
      revision,
    };
    this.incidents.set(incidentId, updated);
    this.persistence?.writeIncident(updated);
  }

  get(incidentId: string): CandleIntegrityIncident | undefined {
    return this.incidents.get(incidentId);
  }

  list(filters: IncidentListFilters = {}): IncidentListResult {
    this.ensureRetention();
    let ids = [...this.order].reverse(); // newest first

    if (filters.status != null) {
      ids = ids.filter(
        (id) => this.incidents.get(id)?.status === filters.status,
      );
    }
    if (filters.severity != null) {
      ids = ids.filter(
        (id) => this.incidents.get(id)?.severity === filters.severity,
      );
    }
    if (filters.category != null) {
      ids = ids.filter(
        (id) => this.incidents.get(id)?.category === filters.category,
      );
    }
    if (filters.type != null) {
      ids = ids.filter((id) => this.incidents.get(id)?.type === filters.type);
    }
    if (filters.symbol != null && filters.symbol !== '') {
      ids = ids.filter(
        (id) => this.incidents.get(id)?.symbol === filters.symbol,
      );
    }
    if (filters.connectorType != null && filters.connectorType !== '') {
      ids = ids.filter(
        (id) => this.incidents.get(id)?.connectorType === filters.connectorType,
      );
    }
    if (filters.marketType != null && filters.marketType !== '') {
      ids = ids.filter(
        (id) => this.incidents.get(id)?.marketType === filters.marketType,
      );
    }
    if (filters.interval != null && filters.interval !== '') {
      ids = ids.filter(
        (id) => this.incidents.get(id)?.interval === filters.interval,
      );
    }

    const total = ids.length;
    const limit = Math.min(Math.max(1, filters.limit ?? 50), 200);
    const offset = Math.max(0, filters.offset ?? 0);
    const pageIds = ids.slice(offset, offset + limit);
    const incidents = pageIds
      .map((id) => this.incidents.get(id))
      .filter((i): i is CandleIntegrityIncident => i != null);

    return { incidents, total, limit, offset };
  }

  countActive(): number {
    this.ensureRetention();
    return [...this.incidents.values()].filter(
      (i) =>
        i.status === 'OPEN' ||
        i.status === 'AUTO_REPAIR_RUNNING' ||
        i.status === 'AUTO_REPAIR_FAILED',
    ).length;
  }

  countCritical(): number {
    this.ensureRetention();
    return [...this.incidents.values()].filter(
      (i) =>
        i.severity === 'CRITICAL' &&
        (i.status === 'OPEN' ||
          i.status === 'AUTO_REPAIR_RUNNING' ||
          i.status === 'AUTO_REPAIR_FAILED' ||
          i.status === 'ESCALATED'),
    ).length;
  }

  getLastIncidentAt(): string | null {
    if (this.order.length === 0) return null;
    const last = this.incidents.get(this.order[this.order.length - 1]!);
    return last?.detectedAt ?? null;
  }

  /** Find an OPEN incident of given type updated since the given ISO timestamp. */
  findOpenByTypeUpdatedSince(
    type: import('./candle-integrity-incident.types').CandleIntegrityIncidentType,
    sinceIso: string,
  ): CandleIntegrityIncident | undefined {
    for (const id of [...this.order].reverse()) {
      const inc = this.incidents.get(id);
      if (
        inc?.status === 'OPEN' &&
        inc.type === type &&
        inc.updatedAt >= sinceIso
      ) {
        return inc;
      }
    }
    return undefined;
  }

  /** Find an OPEN incident with the same identity key (type:connectorType:marketType:symbol:interval). Used for deduplication. */
  findOpenByIdentityKey(
    identityKey: string,
  ): CandleIntegrityIncident | undefined {
    if (!identityKey) return undefined;
    for (const id of [...this.order].reverse()) {
      const inc = this.incidents.get(id);
      if (inc?.status === 'OPEN' && inc.identityKey === identityKey) {
        return inc;
      }
    }
    return undefined;
  }

  private ensureRetention(): void {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoff).toISOString();
    for (const id of [...this.order]) {
      const inc = this.incidents.get(id);
      if (inc && inc.updatedAt < cutoffIso) {
        this.incidents.delete(id);
        this.order.splice(this.order.indexOf(id), 1);
      }
    }
  }

  private dropOldest(): void {
    while (this.order.length > 0 && this.incidents.size >= this.maxIncidents) {
      const id = this.order.shift();
      if (id) this.incidents.delete(id);
    }
  }
}
