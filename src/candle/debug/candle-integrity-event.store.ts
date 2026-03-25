import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import {
  CandleIntegrityEvent,
  EventListFilters,
  EventListResult,
} from './candle-integrity-incident.types';
import type { CandleIntegrityPersistenceService } from './candle-integrity-persistence.service';

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_EVENTS = 50_000;

@Injectable()
export class CandleIntegrityEventStore implements OnModuleInit {
  private readonly events = new Map<string, CandleIntegrityEvent>();
  private readonly order: string[] = []; // eventId insertion order (chronological)
  private readonly retentionDays: number;
  private readonly maxEvents: number;

  constructor(
    @Optional()
    private readonly persistence?: CandleIntegrityPersistenceService,
  ) {
    this.retentionDays =
      typeof process.env.CANDLE_INTEGRITY_EVENT_RETENTION_DAYS !== 'undefined'
        ? Math.max(
            1,
            parseInt(process.env.CANDLE_INTEGRITY_EVENT_RETENTION_DAYS, 10) ||
              7,
          )
        : DEFAULT_RETENTION_DAYS;
    this.maxEvents =
      typeof process.env.CANDLE_INTEGRITY_EVENT_MAX_RECORDS !== 'undefined'
        ? Math.max(
            1000,
            parseInt(process.env.CANDLE_INTEGRITY_EVENT_MAX_RECORDS, 10) ||
              50_000,
          )
        : DEFAULT_MAX_EVENTS;
  }

  async onModuleInit(): Promise<void> {
    if (!this.persistence) return;
    try {
      const loaded = await this.persistence.loadEvents();
      for (const ev of loaded) {
        this.events.set(ev.eventId, ev);
        if (!this.order.includes(ev.eventId)) this.order.push(ev.eventId);
      }
    } catch {
      // ignore
    }
  }

  append(event: CandleIntegrityEvent): void {
    this.ensureRetention();
    if (this.events.size >= this.maxEvents) {
      this.dropOldest();
    }
    this.events.set(event.eventId, { ...event });
    if (!this.order.includes(event.eventId)) {
      this.order.push(event.eventId);
    }
    this.persistence?.writeEvent(event);
  }

  get(eventId: string): CandleIntegrityEvent | undefined {
    return this.events.get(eventId);
  }

  list(filters: EventListFilters = {}): EventListResult {
    this.ensureRetention();
    let ids = [...this.order]; // chronological

    if (filters.incidentId != null && filters.incidentId !== '') {
      ids = ids.filter(
        (id) => this.events.get(id)?.incidentId === filters.incidentId,
      );
    }
    if (filters.eventType != null) {
      ids = ids.filter(
        (id) => this.events.get(id)?.eventType === filters.eventType,
      );
    }
    if (filters.level != null) {
      ids = ids.filter((id) => this.events.get(id)?.level === filters.level);
    }
    if (filters.from != null && filters.from !== '') {
      ids = ids.filter(
        (id) => (this.events.get(id)?.timestamp ?? '') >= filters.from!,
      );
    }
    if (filters.to != null && filters.to !== '') {
      ids = ids.filter(
        (id) => (this.events.get(id)?.timestamp ?? '') <= filters.to!,
      );
    }

    const total = ids.length;
    const limit = Math.min(Math.max(1, filters.limit ?? 100), 500);
    const offset = Math.max(0, filters.offset ?? 0);
    const pageIds = ids.slice(offset, offset + limit);
    const events = pageIds
      .map((id) => this.events.get(id))
      .filter((e): e is CandleIntegrityEvent => e != null);

    return { events, total, limit, offset };
  }

  /** Return events in reverse chronological order (newest first) for timeline UI. */
  listReverseChrono(filters: EventListFilters = {}): EventListResult {
    const result = this.list(filters);
    result.events = result.events.reverse();
    return result;
  }

  private ensureRetention(): void {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoff).toISOString();
    for (const id of [...this.order]) {
      const ev = this.events.get(id);
      if (ev && ev.timestamp < cutoffIso) {
        this.events.delete(id);
        this.order.splice(this.order.indexOf(id), 1);
      }
    }
  }

  private dropOldest(): void {
    while (this.order.length > 0 && this.events.size >= this.maxEvents) {
      const id = this.order.shift();
      if (id) this.events.delete(id);
    }
  }
}
