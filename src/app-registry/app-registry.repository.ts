import { Injectable } from '@nestjs/common';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import { RegisteredAppEntity, RegisteredAppType } from './app-registry.types';

@Injectable()
export class AppRegistryRepository {
  constructor(private readonly reader: QuestDBQueryService) {}

  private esc(str: string): string {
    return str.replace(/'/g, "''");
  }

  private rowToEntity(row: Record<string, unknown>): RegisteredAppEntity {
    let meta: Record<string, unknown> | undefined;
    const rawMeta = row.meta;
    if (typeof rawMeta === 'string' && rawMeta.trim()) {
      try {
        meta = JSON.parse(rawMeta);
      } catch {
        meta = undefined;
      }
    }

    return {
      appKey: String(row.appKey ?? ''),
      appType: String(row.appType ?? '') as RegisteredAppType,
      baseUrl: String(row.baseUrl ?? ''),
      displayName: row.displayName ? String(row.displayName) : undefined,
      version: row.version ? String(row.version) : undefined,
      ip: row.ip ? String(row.ip) : undefined,
      meta,
      status: String(row.status ?? 'registered') as
        | 'registered'
        | 'unregistered',
      registeredAt: this.toMs(row.registeredAt),
      lastHeartbeatAt: this.toMs(row.lastHeartbeatAt),
      updatedAt: this.toMs(row.updatedAt),
      unregisteredAt: row.unregisteredAt ? this.toMs(row.unregisteredAt) : null,
    };
  }

  /** Normalize timestamp to ms. QuestDB may return seconds, microseconds, or ms. */
  private toMs(v: unknown): number {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (n > 1e15) return Math.round(n / 1000); // microseconds → ms
    if (n < 1e12) return Math.round(n * 1000); // seconds → ms
    return Math.round(n); // already ms
  }

  async findAll(): Promise<RegisteredAppEntity[]> {
    const rows = await this.reader.queryAsObjects(`
      SELECT
        appKey,
        appType,
        baseUrl,
        displayName,
        version,
        ip,
        meta,
        status,
        registeredAt,
        lastHeartbeatAt,
        updatedAt,
        unregisteredAt
      FROM app_registry
      ORDER BY updatedAt DESC
    `);
    return rows.map((row) => this.rowToEntity(row));
  }

  async findOne(
    appType: RegisteredAppType,
    appKey: string,
  ): Promise<RegisteredAppEntity | null> {
    const row = await this.reader.queryOne(`
      SELECT
        appKey,
        appType,
        baseUrl,
        displayName,
        version,
        ip,
        meta,
        status,
        registeredAt,
        lastHeartbeatAt,
        updatedAt,
        unregisteredAt
      FROM app_registry
      WHERE appType='${this.esc(appType)}' AND appKey='${this.esc(appKey)}'
      LIMIT 1
    `);
    return row ? this.rowToEntity(row as Record<string, unknown>) : null;
  }

  async upsert(entity: RegisteredAppEntity): Promise<void> {
    const existing = await this.findOne(entity.appType, entity.appKey);
    if (!existing) {
      await this.reader.query(`
        INSERT INTO app_registry (
          appKey,
          appType,
          baseUrl,
          displayName,
          version,
          ip,
          meta,
          status,
          registeredAt,
          lastHeartbeatAt,
          updatedAt,
          unregisteredAt
        ) VALUES (
          '${this.esc(entity.appKey)}',
          '${this.esc(entity.appType)}',
          '${this.esc(entity.baseUrl)}',
          ${entity.displayName ? `'${this.esc(entity.displayName)}'` : 'null'},
          ${entity.version ? `'${this.esc(entity.version)}'` : 'null'},
          ${entity.ip ? `'${this.esc(entity.ip)}'` : 'null'},
          '${this.esc(JSON.stringify(entity.meta ?? {}))}',
          '${this.esc(entity.status)}',
          ${entity.registeredAt},
          ${entity.lastHeartbeatAt},
          ${entity.updatedAt},
          ${entity.unregisteredAt ?? 'null'}
        )
      `);
      return;
    }

    // QuestDB: do not UPDATE designated timestamp column (updatedAt) or registration time (registeredAt)
    await this.reader.query(`
      UPDATE app_registry
      SET
        baseUrl='${this.esc(entity.baseUrl)}',
        displayName=${
          entity.displayName ? `'${this.esc(entity.displayName)}'` : 'null'
        },
        version=${entity.version ? `'${this.esc(entity.version)}'` : 'null'},
        ip=${entity.ip ? `'${this.esc(entity.ip)}'` : 'null'},
        meta='${this.esc(JSON.stringify(entity.meta ?? {}))}',
        status='${this.esc(entity.status)}',
        lastHeartbeatAt=${entity.lastHeartbeatAt},
        unregisteredAt=${entity.unregisteredAt ?? 'null'}
      WHERE appType='${this.esc(entity.appType)}' AND appKey='${this.esc(
      entity.appKey,
    )}'
    `);
  }
}
