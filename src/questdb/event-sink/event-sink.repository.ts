import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { QuestDBWriteService } from '../questdb-write.service';
import { QuestDBQueryService } from '../questdb-query.service';
import { EventSinkPayload } from './event-sink.type';
import { EventSinkGateway } from './event-sink.gateway';

interface QueuedEvent {
  eventType: string;
  event: EventSinkPayload;
}

export interface PaginateOptions {
  page: number;
  limit: number;
  category?: string;
  symbol?: string;
  from?: number;
  to?: number;
  search?: string;
  includePayload?: boolean;
}

@Injectable()
export class EventSinkRepository implements OnModuleInit, OnModuleDestroy {
  private queue: QueuedEvent[] = [];
  private flushInterval!: NodeJS.Timeout;
  private readonly startedAt = Date.now();
  private readonly runtimeWindowMaxMinutes = Math.max(
    1,
    Number(process.env.DASHBOARD_RUNTIME_EVENTS_WINDOW_MINUTES || 1440),
  );
  private readonly runtimeMinuteBuckets = new Map<number, number>();

  private readonly CHANNEL = 'events';

  private readonly FLUSH_INTERVAL_MS = Number(
    process.env.EVENTSINK_FLUSH_INTERVAL ?? 50,
  );
  private readonly MAX_BATCH_SIZE = Number(
    process.env.EVENTSINK_BATCH_SIZE ?? 500,
  );
  private readonly QUEUE_MAX_SIZE = Math.max(
    this.MAX_BATCH_SIZE,
    Number(process.env.EVENTSINK_QUEUE_MAX_SIZE ?? this.MAX_BATCH_SIZE * 10),
  );
  private droppedEventsTotal = 0;

  /** 🔒 Защита от 1970 */
  private static readonly MIN_REASONABLE_TS = 946684800000; // 2000-01-01 UTC

  constructor(
    private readonly writer: QuestDBWriteService,
    private readonly reader: QuestDBQueryService,

    @Optional()
    private readonly gateway?: EventSinkGateway,
  ) {}

  // -----------------------------------
  // 🔁 AUTO-FLUSH
  // -----------------------------------
  onModuleInit() {
    this.flushInterval = setInterval(
      () => this.flush(),
      this.FLUSH_INTERVAL_MS,
    );
  }

  async onModuleDestroy() {
    clearInterval(this.flushInterval);
    await this.flush();
  }

  // -----------------------------------
  // 📨 EMIT (batch + websocket)
  // -----------------------------------
  emit(eventType: string, event: EventSinkPayload) {
    if (process.env.EVENTSINK_ENABLED === 'false') return;

    this.queue.push({ eventType, event });
    if (this.queue.length > this.QUEUE_MAX_SIZE) {
      const dropped = this.queue.length - this.QUEUE_MAX_SIZE;
      this.queue.splice(0, dropped);
      this.droppedEventsTotal += dropped;
      console.warn(
        `[EventSinkQueueOverflow] dropped=${dropped} dropped_total=${this.droppedEventsTotal} queue_size=${this.queue.length} queue_max=${this.QUEUE_MAX_SIZE}`,
      );
    }
    this.recordRuntimeEventTs(event.timestamp);

    // WS broadcast
    if (this.gateway) {
      this.gateway.broadcast({
        ...event,
        eventType: `${event.category}.${event.action}`,
      });
    }

    if (this.queue.length >= this.MAX_BATCH_SIZE) {
      void this.flush();
    }
  }

  // -----------------------------------
  // ✍️ FLUSH → writeBatch()
  // -----------------------------------
  async flush() {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.queue.length);

    try {
      const mapped = batch
        .map((item) => {
          const e = item.event;

          const tsMs = Math.trunc(e.timestamp ?? Date.now());

          // 🔒 Защита от 1970 / NaN / отрицательных дат
          if (
            !Number.isFinite(tsMs) ||
            tsMs < EventSinkRepository.MIN_REASONABLE_TS
          ) {
            return null;
          }

          return {
            table: 'event_sink',
            keys: {
              eventType: `${e.category}.${e.action}`,
              symbol: e.symbol ?? '',
              connectorType: e.connectorType ?? '',
              marketType: e.marketType ?? '',
            },
            fields: {
              payload: this.safeStringify(e.data),
            },
            timestampNs: BigInt(tsMs) * 1_000_000n,
          };
        })
        .filter(Boolean) as Parameters<typeof this.writer.writeBatch>[1];

      if (!mapped.length) return;

      await this.writer.writeBatch(this.CHANNEL, mapped);
    } catch (err) {
      console.error('❌ EventSinkRepository flush failed:', err);
    }
  }

  getRuntimeStats(windowMinutes: number): {
    eventsLast1m: number;
    eventsLastWindow: number;
    startedAt: number;
    maxWindowMinutes: number;
  } {
    const safeWindow = Math.max(
      1,
      Math.min(
        this.runtimeWindowMaxMinutes,
        Math.floor(Number(windowMinutes) || 1),
      ),
    );
    const nowMinute = Math.floor(Date.now() / 60_000);
    this.pruneRuntimeBuckets(nowMinute);
    return {
      eventsLast1m: this.countRuntimeEventsForLastMinutes(1, nowMinute),
      eventsLastWindow: this.countRuntimeEventsForLastMinutes(
        safeWindow,
        nowMinute,
      ),
      startedAt: this.startedAt,
      maxWindowMinutes: this.runtimeWindowMaxMinutes,
    };
  }

  // =====================================================================
  // 📌 PAGINATION FOR UI
  // =====================================================================
  async getPaginated(options: PaginateOptions) {
    let { page, limit, category, symbol, from, to, search, includePayload } =
      options;

    page = Math.max(1, Number(page) || 1);
    // Full payload rows can exceed QuestDB PG send buffer quickly.
    // Keep compact mode as default and allow payload only with tighter limit.
    const wantsPayload = includePayload === true;
    limit = wantsPayload
      ? Math.min(10, Math.max(1, Number(limit) || 10))
      : Math.min(200, Math.max(1, Number(limit) || 50));

    const where: string[] = [];

    if (category) where.push(`eventType ~ '^${this.escape(category)}\\.'`);
    if (symbol) where.push(`symbol = '${this.escape(symbol)}'`);

    if (from) where.push(`ts >= ${Number(from) * 1000}L`);
    if (to) where.push(`ts <= ${Number(to) * 1000}L`);

    if (search) where.push(`payload ~ '${this.escape(search)}'`);

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * limit;
    const limitClause =
      offset > 0 ? `LIMIT ${offset}, ${limit}` : `LIMIT ${limit}`;

    const selectWithPayload = `
        SELECT ts,
               eventType,
               symbol,
               connectorType,
               marketType,
               payload
      `;
    const selectWithoutPayload = `
        SELECT ts,
               eventType,
               symbol,
               connectorType,
               marketType
      `;
    const selectClause = wantsPayload
      ? selectWithPayload
      : selectWithoutPayload;

    const sql = `
        ${selectClause}
        FROM event_sink
        ${whereSQL}
        ORDER BY ts DESC
        ${limitClause}
    `;

    let data: any[] = [];
    try {
      data = await this.reader.queryAsObjects(sql);
    } catch (error: any) {
      const message = String(error?.message ?? error ?? '');
      const isBufferOverflow = message.includes(
        'not enough space in send buffer',
      );
      if (wantsPayload && isBufferOverflow) {
        const fallbackSql = `
          ${selectWithoutPayload}
          FROM event_sink
          ${whereSQL}
          ORDER BY ts DESC
          ${limitClause}
        `;
        data = await this.reader.queryAsObjects(fallbackSql);
      } else {
        throw error;
      }
    }

    const hasPayload =
      wantsPayload && data.some((row) => row?.payload !== undefined);
    if (!hasPayload) {
      data = data.map((row) => ({ ...row, payload: null }));
    }

    const countSql = `
        SELECT count()
        FROM event_sink
        ${whereSQL}
    `;

    const total = Number(await this.reader.queryValue(countSql));

    return { data, total };
  }

  // =====================================================================
  // 🛡 SQL Injection Safe Escape
  // =====================================================================
  private safeStringify(data: unknown): string {
    try {
      return JSON.stringify(data);
    } catch {
      try {
        const seen = new WeakSet();
        return JSON.stringify(data, (_key, value) => {
          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) return '[Circular]';
            seen.add(value);
          }
          return value;
        });
      } catch {
        return '{"error":"unserializable"}';
      }
    }
  }

  private escape(str: string): string {
    return str.replace(/'/g, "''");
  }

  private recordRuntimeEventTs(ts?: number): void {
    const tsMs = Math.trunc(Number(ts ?? Date.now()));
    if (
      !Number.isFinite(tsMs) ||
      tsMs < EventSinkRepository.MIN_REASONABLE_TS
    ) {
      return;
    }
    const minuteTs = Math.floor(tsMs / 60_000);
    this.runtimeMinuteBuckets.set(
      minuteTs,
      (this.runtimeMinuteBuckets.get(minuteTs) ?? 0) + 1,
    );
    this.pruneRuntimeBuckets(Math.floor(Date.now() / 60_000));
  }

  private pruneRuntimeBuckets(nowMinute: number): void {
    const minMinute = nowMinute - this.runtimeWindowMaxMinutes + 1;
    for (const minute of this.runtimeMinuteBuckets.keys()) {
      if (minute < minMinute) this.runtimeMinuteBuckets.delete(minute);
    }
  }

  private countRuntimeEventsForLastMinutes(
    minutes: number,
    nowMinute: number,
  ): number {
    let total = 0;
    for (let i = 0; i < minutes; i += 1) {
      total += this.runtimeMinuteBuckets.get(nowMinute - i) ?? 0;
    }
    return total;
  }
}
