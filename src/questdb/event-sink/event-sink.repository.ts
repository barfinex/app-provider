import { Injectable, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
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
}

@Injectable()
export class EventSinkRepository implements OnModuleInit, OnModuleDestroy {
    private queue: QueuedEvent[] = [];
    private flushInterval!: NodeJS.Timeout;

    private readonly CHANNEL = 'events';

    private readonly FLUSH_INTERVAL_MS = Number(process.env.EVENTSINK_FLUSH_INTERVAL ?? 50);
    private readonly MAX_BATCH_SIZE = Number(process.env.EVENTSINK_BATCH_SIZE ?? 500);

    constructor(
        private readonly writer: QuestDBWriteService,
        private readonly reader: QuestDBQueryService,

        @Optional()
        private readonly gateway?: EventSinkGateway,
    ) { }

    // -----------------------------------
    // 🔁 AUTO-FLUSH
    // -----------------------------------
    onModuleInit() {
        this.flushInterval = setInterval(() => this.flush(), this.FLUSH_INTERVAL_MS);
    }

    onModuleDestroy() {
        clearInterval(this.flushInterval);
        return this.flush();
    }

    // -----------------------------------
    // 📨 EMIT (batch + websocket)
    // -----------------------------------
    emit(eventType: string, event: EventSinkPayload) {
        if (process.env.EVENTSINK_ENABLED === 'false') return;

        this.queue.push({ eventType, event });

        // WS broadcast
        if (this.gateway) {
            this.gateway.broadcast({
                ...event,
                eventType: `${event.category}.${event.action}`,
            });
        }

        if (this.queue.length >= this.MAX_BATCH_SIZE) this.flush();
    }

    // -----------------------------------
    // ✍️ FLUSH → writeBatch()
    // -----------------------------------
    async flush() {
        if (this.queue.length === 0) return;

        const batch = this.queue.splice(0, this.queue.length);

        try {
            this.writer.writeBatch(
                this.CHANNEL,
                batch.map(item => {
                    const e = item.event;

                    return {
                        table: 'event_sink',
                        keys: {
                            eventType: `${e.category}.${e.action}`,
                            symbol: e.symbol ?? '',
                            connectorType: e.connectorType ?? '',
                            marketType: e.marketType ?? '',
                        },
                        fields: {
                            payload: JSON.stringify(e.data),
                        },
                        timestampNs: (e.timestamp ?? Date.now()) * 1_000_000,
                    };
                })
            );
        } catch (err) {
            console.error('❌ EventSinkRepository flush failed:', err);
        }
    }


    // =====================================================================
    // 📌 PAGINATION FOR UI
    // =====================================================================
    async getPaginated(options: PaginateOptions) {
        let { page, limit, category, symbol, from, to, search } = options;

        page = Math.max(1, Number(page) || 1);
        limit = Math.min(500, Math.max(1, Number(limit) || 50));

        const where: string[] = [];

        if (category) where.push(`eventType ~ '^${this.escape(category)}\\.'`);
        if (symbol) where.push(`symbol = '${this.escape(symbol)}'`);

        // QuestDB expects timestamp as ISO, but we can convert ms → designated
        if (from) where.push(`ts >= to_timestamp(${Number(from)}::long)`);
        if (to) where.push(`ts <= to_timestamp(${Number(to)}::long)`);

        if (search) where.push(`payload ~ '${this.escape(search)}'`);

        const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const offset = (page - 1) * limit;

        const sql = `
        SELECT ts,
               eventType,
               symbol,
               connectorType,
               marketType,
               payload
        FROM event_sink
        ${whereSQL}
        ORDER BY ts DESC
        LIMIT ${limit}
        OFFSET ${offset}
    `;

        const data = await this.reader.queryAsObjects(sql);

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
    private escape(str: string): string {
        return str.replace(/'/g, "''");
    }
}
