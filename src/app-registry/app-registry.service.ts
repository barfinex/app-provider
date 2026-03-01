import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import {
  HeartbeatAppDto,
  RegisterAppDto,
  RegisteredAppEntity,
  RegisteredAppType,
  UnregisterAppDto,
} from './app-registry.types';
import { AppRegistryRepository } from './app-registry.repository';

@Injectable()
export class AppRegistryService {
  constructor(private readonly repo: AppRegistryRepository) {}

  async register(dto: RegisterAppDto): Promise<RegisteredAppEntity> {
    const now = Date.now();
    const existing = await this.repo.findOne(dto.appType, dto.appKey);
    let meta: Record<string, unknown> = {
      ...(existing?.meta ?? {}),
      ...(dto.meta ?? {}),
    };
    if (dto.appType === 'detector' && typeof meta.studioKey !== 'string') {
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
    if (dto.appType === 'detector' && typeof meta.studioKey !== 'string') {
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
    await this.repo.upsert(entity);
    return entity;
  }

  async list(options?: {
    appType?: RegisteredAppType;
    includeInactive?: boolean;
  }): Promise<Array<RegisteredAppEntity & { isActive: boolean; staleMs: number }>> {
    const ttlMs = Number(process.env.PROVIDER_APP_ACTIVE_TTL_MS || 60_000);
    const now = Date.now();
    const rows = await this.repo.findAll();
    const filtered = rows
      .filter(r => (options?.appType ? r.appType === options.appType : true))
      .map(r => {
        const staleMs = Math.max(0, now - (r.lastHeartbeatAt || 0));
        const isActive = r.status === 'registered' && staleMs <= ttlMs;
        return { ...r, isActive, staleMs };
      });

    if (options?.includeInactive) return filtered;
    return filtered.filter(r => r.isActive);
  }

  /**
   * Ключи приложений (например детекторов), которые недавно слали heartbeat.
   * Используется, чтобы провайдер считал детектор выключенным, если чеков нет.
   */
  async getActiveAppKeys(appType: RegisteredAppType): Promise<Set<string>> {
    const rows = await this.list({ appType, includeInactive: true });
    const active = rows.filter(r => r.isActive).map(r => r.appKey);
    return new Set(active);
  }

  async resolveActiveTarget(appType: RegisteredAppType, appKey: string): Promise<RegisteredAppEntity> {
    const all = await this.list({ appType, includeInactive: true });
    const found = all.find(x => x.appType === appType && x.appKey === appKey);
    if (!found) {
      throw new Error(`App not registered: ${appType}:${appKey}`);
    }
    if (!found.isActive) {
      throw new Error(
        `App is not active: ${appType}:${appKey} (status=${found.status}, staleMs=${found.staleMs})`,
      );
    }
    return found;
  }

  private normalizeBaseUrl(url: string): string {
    return String(url || '').trim().replace(/\/+$/, '');
  }
}
