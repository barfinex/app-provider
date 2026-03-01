import { Injectable, Logger } from '@nestjs/common';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import { OrderEventAdapter } from '../questdb/event-sink/adapters/order.adapter';

export interface OrderEntity {
  id: string;
  externalId?: string | null;

  connectorType: string;
  marketType: string;
  symbol: string;

  side?: string | null;
  type?: string | null;
  price?: number | null;

  sourceSysname: string;
  sourceType: string;
  sourceBaseApiUrl?: string | null;

  time: number;
  updateTime?: number | null;

  quantity?: number | null;
  quantityExecuted?: number | null;

  priceClose?: number | null;
  closeTime?: number | null;

  useSandbox: boolean;

  status: 'active' | 'closed' | 'deleted';
  deletedAt?: number | null;
}

@Injectable()
export class OrderRepository {
  private readonly logger = new Logger(OrderRepository.name);

  constructor(
    private readonly reader: QuestDBQueryService,
    private readonly events: OrderEventAdapter,
  ) {}

  private esc(str: string): string {
    return str.replace(/'/g, "''");
  }

  // ---------------------------------------------------------
  // SELECT
  // ---------------------------------------------------------

  async getAll(): Promise<OrderEntity[]> {
    return this.reader.queryAsObjects(`
      SELECT *
      FROM orders
      WHERE status='active'
      ORDER BY time DESC
    `);
  }

  async getById(id: string): Promise<OrderEntity | null> {
    return this.reader.queryOne(`
      SELECT *
      FROM orders
      WHERE id='${this.esc(id)}' AND status!='deleted'
      LIMIT 1
    `);
  }

  async getByExternalId(externalId: string): Promise<OrderEntity | null> {
    return this.reader.queryOne(`
      SELECT *
      FROM orders
      WHERE externalId='${this.esc(externalId)}' AND status!='deleted'
      LIMIT 1
    `);
  }

  async exists(id: string): Promise<boolean> {
    const count = await this.reader.queryValue(`
      SELECT count(*) FROM orders
      WHERE id='${this.esc(id)}' AND status!='deleted'
    `);

    return Number(count ?? 0) > 0;
  }

  async find(where: string): Promise<OrderEntity[]> {
    return this.reader.queryAsObjects(`
      SELECT *
      FROM orders
      WHERE ${where} AND status!='deleted'
      ORDER BY time DESC
    `);
  }

  async findAndCount(where: string, limit?: number, offset?: number) {
    const hasLimit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0;
    const safeOffset =
      typeof offset === 'number' && Number.isFinite(offset) && offset > 0
        ? Math.floor(offset)
        : 0;
    const limitClause = hasLimit
      ? safeOffset > 0
        ? `LIMIT ${safeOffset}, ${Math.floor(limit!)}`
        : `LIMIT ${Math.floor(limit!)}`
      : '';

    const rows = await this.reader.queryAsObjects(`
      SELECT *
      FROM orders
      WHERE ${where} AND status!='deleted'
      ORDER BY time DESC
      ${limitClause}
    `);

    const count = await this.reader.queryValue(`
      SELECT count(*) FROM orders
      WHERE ${where} AND status!='deleted'
    `);

    return [rows, Number(count ?? 0)] as [OrderEntity[], number];
  }

  // ---------------------------------------------------------
  // INSERT
  // ---------------------------------------------------------

  async insert(entity: OrderEntity): Promise<void> {
    await this.reader.query(`
      INSERT INTO orders (
        id, externalId, connectorType, marketType, symbol,
        side, type, price,
        sourceSysname, sourceType, sourceBaseApiUrl,
        time, updateTime,
        quantity, quantityExecuted,
        priceClose, closeTime,
        useSandbox,
        status, deletedAt
      ) VALUES (
        '${this.esc(entity.id)}',
        '${this.esc(entity.externalId ?? '')}',
        '${this.esc(entity.connectorType)}',
        '${this.esc(entity.marketType)}',
        '${this.esc(entity.symbol)}',

        '${this.esc(entity.side ?? '')}',
        '${this.esc(entity.type ?? '')}',
        ${entity.price ?? 'null'},

        '${this.esc(entity.sourceSysname)}',
        '${this.esc(entity.sourceType)}',
        '${this.esc(entity.sourceBaseApiUrl ?? '')}',

        ${entity.time},
        ${entity.updateTime ?? entity.time},

        ${entity.quantity ?? 'null'},
        ${entity.quantityExecuted ?? 'null'},

        ${entity.priceClose ?? 'null'},
        ${entity.closeTime ?? 'null'},

        ${entity.useSandbox ? 1 : 0},

        '${entity.status ?? 'active'}',
        ${entity.deletedAt ?? 'null'}
      )
    `);

    this.events.emitUpdate(entity);
  }

  // ---------------------------------------------------------
  // UPDATE
  // ---------------------------------------------------------

  async update(id: string, patch: Partial<OrderEntity>): Promise<void> {
    const sets = Object.entries(patch)
      .map(([key, val]) => {
        if (val === null) return `${key}=null`;
        if (typeof val === 'string') return `${key}='${this.esc(val)}'`;
        return `${key}=${val}`;
      })
      .join(',');

    await this.reader.query(`
      UPDATE orders
      SET ${sets}, updateTime=now()
      WHERE id='${this.esc(id)}' AND status!='deleted'
    `);

    const updated = await this.getById(id);
    if (updated) this.events.emitUpdate(updated);
  }

  // ---------------------------------------------------------
  // SOFT DELETE
  // ---------------------------------------------------------

  async delete(id: string): Promise<void> {
    const existing = await this.getById(id);

    await this.reader.query(`
      UPDATE orders
      SET status='deleted', deletedAt=now(), updateTime=now()
      WHERE id='${this.esc(id)}'
    `);

    if (existing) this.events.emitDelete(existing);
  }

  async deleteWhere(where: string): Promise<void> {
    const items = await this.find(where);

    await this.reader.query(`
      UPDATE orders
      SET status='deleted', deletedAt=now(), updateTime=now()
      WHERE ${where}
    `);

    for (const entity of items) {
      this.events.emitDelete(entity);
    }
  }

  async count(where: string): Promise<number> {
    const value = await this.reader.queryValue(`
      SELECT count(*)
      FROM orders
      WHERE ${where} AND status!='deleted'
    `);

    return Number(value ?? 0);
  }
}
