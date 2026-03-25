import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import { ReplaySession } from './replay.session';
import { ReplayOptions, ReplayEvent } from './replay.types';
import { EventSinkRepository } from '../questdb/event-sink/event-sink.repository';

@Injectable()
export class ReplayService {
  private session: ReplaySession | null = null;
  private readonly logger = new Logger('Replay');

  constructor(
    private readonly reader: QuestDBQueryService,
    private readonly sink: EventSinkRepository,
  ) {}

  async startReplay(options: ReplayOptions) {
    if (this.session) {
      this.session.stop();
    }

    const events = await this.loadEvents(options);

    this.session = new ReplaySession(events, options, (ev) => {
      // Отправляем событие в EventSink → Detector / WS / Processing pipeline
      this.sink.emit(ev.category, {
        category: ev.category as any,
        action: ev.action,
        data: ev.payload,
        timestamp: ev.ts,
      });
    });

    this.session.start();

    return {
      status: 'started',
      count: events.length,
      speed: options.speed ?? 1,
    };
  }

  stopReplay() {
    if (this.session) {
      this.session.stop();
      this.session = null;
    }
    return { status: 'stopped' };
  }

  private async loadEvents(options: ReplayOptions): Promise<ReplayEvent[]> {
    if (options.from > options.to) {
      throw new BadRequestException(
        'Invalid range: "from" must be less than or equal to "to".',
      );
    }

    const symbolFilter = options.symbols?.length
      ? `AND symbol IN (${options.symbols
          .map(
            (s) =>
              `'${String(s ?? '')
                .replace(/'/g, "''")
                .trim()}'`,
          )
          .join(',')})`
      : '';

    const sql = `
            SELECT 
                ts,
                split_part(eventType, '.', 1) AS category,
                split_part(eventType, '.', 2) AS action,
                payload
            FROM event_sink
            WHERE ts BETWEEN ${options.from} * 1000 AND ${options.to} * 1000
            ${symbolFilter}
            ORDER BY ts
        `;

    // Используем queryAsObjects — без ошибок .map(...)
    const rows = await this.reader.queryAsObjects(sql);

    return rows.map((r: any) => ({
      ts: Number(r.ts),
      category: r.category,
      action: r.action,
      payload: JSON.parse(r.payload),
    }));
  }
}
