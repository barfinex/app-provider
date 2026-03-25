import { randomUUID } from 'crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  HeartbeatAppDto,
  RegisterAppDto,
  RegisteredAppEntity,
  RegisteredAppType,
  UnregisterAppDto,
} from './app-registry.types';
import { AppRegistryRepository } from './app-registry.repository';

@Injectable()
export class AppRegistryService implements OnModuleInit {
  private readonly logger = new Logger(AppRegistryService.name);
  /** In-memory heartbeat overlay — QuestDB timestamp handling is unreliable for sub-second precision. */
  private readonly heartbeatOverlay = new Map<string, number>();

  constructor(private readonly repo: AppRegistryRepository) {}

  async onModuleInit(): Promise<void> {
    await this.ensureStudioKeysForExistingApps();
  }

  /**
   * Backfill studioKey for advisor/inspector (and detector) that were registered
   * before studioKey was required, so every list item has a stable key for Studio URLs.
   */
  private async ensureStudioKeysForExistingApps(): Promise<void> {
    try {
      const rows = await this.repo.findAll();
      const needsKey = rows.filter(
        (r) =>
          (r.appType === 'advisor' ||
            r.appType === 'inspector' ||
            r.appType === 'detector') &&
          typeof (r.meta as Record<string, unknown>)?.studioKey !== 'string',
      );
      for (const row of needsKey) {
        const meta = { ...(row.meta ?? {}), studioKey: randomUUID() } as Record<
          string,
          unknown
        >;
        await this.repo.upsert({
          ...row,
          meta,
        });
        this.logger.log(
          `[app-registry] backfilled studioKey for ${row.appType}:${row.appKey}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[app-registry] ensureStudioKeysForExistingApps failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async register(dto: RegisterAppDto): Promise<RegisteredAppEntity> {
    const now = Date.now();
    const existing = await this.repo.findOne(dto.appType, dto.appKey);
    let meta: Record<string, unknown> = {
      ...(existing?.meta ?? {}),
      ...(dto.meta ?? {}),
    };
    if (
      (dto.appType === 'detector' ||
        dto.appType === 'advisor' ||
        dto.appType === 'inspector') &&
      typeof meta.studioKey !== 'string'
    ) {
      meta = { ...meta, studioKey: randomUUID() };
    }
    const entity: RegisteredAppEntity = {
      appKey: dto.appKey,
      appType: dto.appType,
      baseUrl: this.normalizeBaseUrl(dto.baseUrl),
      displayName: dto.displayName ?? existing?.displayName,
      version: dto.version ?? existing?.version,
      ip: dto.ip ?? existing?.ip,
      meta,
      status: 'registered',
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeatAt: now,
      updatedAt: now,
      unregisteredAt: null,
    };
    this.heartbeatOverlay.set(`${entity.appType}:${entity.appKey}`, now);
    await this.repo.upsert(entity);
    return entity;
  }

  async unregister(dto: UnregisterAppDto): Promise<RegisteredAppEntity | null> {
    const existing = await this.repo.findOne(dto.appType, dto.appKey);
    if (!existing) return null;
    const now = Date.now();
    const entity: RegisteredAppEntity = {
      ...existing,
      status: 'unregistered',
      updatedAt: now,
      unregisteredAt: now,
      meta: {
        ...(existing.meta ?? {}),
        ...(dto.reason ? { unregisterReason: dto.reason } : {}),
      },
    };
    await this.repo.upsert(entity);
    return entity;
  }

  async heartbeat(dto: HeartbeatAppDto): Promise<RegisteredAppEntity> {
    const existing = await this.repo.findOne(dto.appType, dto.appKey);
    const now = Date.now();
    let meta: Record<string, unknown> = {
      ...(existing?.meta ?? {}),
      ...(dto.meta ?? {}),
    };
    if (
      (dto.appType === 'detector' ||
        dto.appType === 'advisor' ||
        dto.appType === 'inspector') &&
      typeof meta.studioKey !== 'string'
    ) {
      meta = { ...meta, studioKey: randomUUID() };
    }
    const entity: RegisteredAppEntity = {
      appKey: dto.appKey,
      appType: dto.appType,
      baseUrl: this.normalizeBaseUrl(dto.baseUrl || existing?.baseUrl || ''),
      displayName: existing?.displayName,
      version: existing?.version,
      ip: dto.ip ?? existing?.ip,
      meta,
      status: 'registered',
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeatAt: now,
      updatedAt: now,
      unregisteredAt: null,
    };
    this.heartbeatOverlay.set(`${entity.appType}:${entity.appKey}`, now);
    await this.repo.upsert(entity);
    return entity;
  }

  async list(options?: {
    appType?: RegisteredAppType;
    includeInactive?: boolean;
  }): Promise<
    Array<RegisteredAppEntity & { isActive: boolean; staleMs: number }>
  > {
    const ttlMs = Number(process.env.PROVIDER_APP_ACTIVE_TTL_MS || 60_000);
    const now = Date.now();
    const rows = await this.repo.findAll();
    const filtered = rows
      .filter((r) => (options?.appType ? r.appType === options.appType : true))
      .map((r) => {
        const overlayHb = this.heartbeatOverlay.get(`${r.appType}:${r.appKey}`);
        const effectiveHb = overlayHb ?? r.lastHeartbeatAt ?? 0;
        const staleMs = Math.max(0, now - effectiveHb);
        const isActive = r.status === 'registered' && staleMs <= ttlMs;
        return { ...r, lastHeartbeatAt: effectiveHb, isActive, staleMs };
      });

    if (options?.includeInactive) return filtered;
    return filtered.filter((r) => r.isActive);
  }

  /**
   * Ключи приложений (например детекторов), которые недавно слали heartbeat.
   * Используется, чтобы провайдер считал детектор выключенным, если чеков нет.
   */
  async getActiveAppKeys(appType: RegisteredAppType): Promise<Set<string>> {
    const rows = await this.list({ appType, includeInactive: true });
    const active = rows.filter((r) => r.isActive).map((r) => r.appKey);
    return new Set(active);
  }

  /**
   * Resolve target by appKey or by studioKey (UUID used in Studio URLs).
   * So requests to /advisors/:studioKey/* and /inspectors/:studioKey/* work.
   */
  async resolveActiveTarget(
    appType: RegisteredAppType,
    key: string,
  ): Promise<RegisteredAppEntity> {
    const all = await this.list({ appType, includeInactive: true });
    let found = all.find((x) => x.appType === appType && x.appKey === key);
    if (!found && key) {
      const metaKey = (row: RegisteredAppEntity) =>
        (row.meta as Record<string, unknown>)?.studioKey as string | undefined;
      found = all.find((x) => x.appType === appType && metaKey(x) === key);
    }
    if (!found) {
      throw new Error(`App not registered: ${appType}:${key}`);
    }
    if (!found.isActive) {
      throw new Error(
        `App is not active: ${appType}:${key} (status=${found.status}, staleMs=${found.staleMs})`,
      );
    }
    return found;
  }

  private normalizeBaseUrl(url: string): string {
    return String(url || '')
      .trim()
      .replace(/\/+$/, '');
  }
}
