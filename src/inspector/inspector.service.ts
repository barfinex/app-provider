// src/inspector/inspector.service.ts
import {
  Injectable,
  Inject,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';

import { HttpService } from '@nestjs/axios';

import { InspectorRepository, InspectorEntity } from './inspector.repository';
import { Inspector, InspectorListItem, InspectorStatus } from '@barfinex/types';

import { ConnectorService } from '../connector/connector.service';
import { OrderService } from '../order/order.service';
import { AppRegistryService } from '../app-registry/app-registry.service';

const defaultInspectorOptions = (): Inspector => ({
  key: '',
  restApiUrl: '',
  general: { apiPort: 0 },
  connectors: [],
  apiPort: 0,
  riskManagement: {},
  assetManagement: {
    excludedAssets: [],
    preferredAssets: [],
    slippageTolerancePercent: 0,
    spreadTolerancePercent: 0,
  },
  tradeSettings: {
    maxPositionHoldTime: 0,
    maxPositionSizePercent: 0,
    minPositionSizePercent: 0,
    maxLeverage: 0,
    defaultLeverage: 0,
    trailingStopPercent: 0,
    trailingTakeProfitPercent: 0,
  },
  strategyLogic: {
    cooldownPeriod: 0,
    maxConsecutiveLosses: 0,
    minROIThreshold: 0,
    maxROIThreshold: 0,
  },
});

/** Inspector list item with optional providerKey (as returned by provider API). */
export type InspectorListItemWithProvider = InspectorListItem & {
  providerKey?: string;
};

@Injectable()
export class InspectorService {
  constructor(
    private readonly http: HttpService,

    private readonly inspectorRepository: InspectorRepository,

    @Inject(forwardRef(() => ConnectorService))
    private readonly connectorService: ConnectorService,

    @Inject(forwardRef(() => OrderService))
    private readonly orderService: OrderService,

    @Inject(forwardRef(() => AppRegistryService))
    private readonly appRegistry: AppRegistryService,
  ) {}

  // -------------------------------------------------------
  // GET ALL (with key, providerKey, status from registry)
  // -------------------------------------------------------
  async getAll(): Promise<InspectorListItemWithProvider[]> {
    const [entities, activeKeys] = await Promise.all([
      this.inspectorRepository.find(),
      this.appRegistry.getActiveAppKeys('inspector'),
    ]);
    return entities.map((e) => {
      const opts = e.options ?? {};
      const key = (opts.key as string) || e.name;
      const status: InspectorStatus = activeKeys.has(key)
        ? opts.isActive !== false
          ? 'active'
          : 'disabled'
        : 'offline';
      return {
        ...defaultInspectorOptions(),
        ...opts,
        key: key || e.name,
        providerKey: opts.providerKey as string | undefined,
        status,
      } as InspectorListItemWithProvider;
    });
  }

  // -------------------------------------------------------
  // CREATE OR UPDATE
  // -------------------------------------------------------
  async create(name: string, options: Inspector): Promise<InspectorEntity> {
    const existing = await this.inspectorRepository.findOne({
      where: { name },
    });

    if (existing) {
      existing.options = options;
      await this.inspectorRepository.update(name, {
        options,
        updatedAt: Date.now(),
      });
      return existing;
    }

    const entity = this.inspectorRepository.create({ name, options });
    await this.inspectorRepository.insert(entity);
    return entity;
  }

  // -------------------------------------------------------
  // GET (with default)
  // -------------------------------------------------------
  async get(sysname: string): Promise<Inspector> {
    const found = await this.inspectorRepository.findOne({
      where: { name: sysname },
    });
    return found ? found.options : defaultInspectorOptions();
  }

  // -------------------------------------------------------
  // UPSERT INSPECTOR FROM APP REGISTRY (register/heartbeat)
  // So GET /api/inspectors shows inspectors with key and providerKey (like detectors).
  // -------------------------------------------------------
  async upsertInspectorFromRegistration(
    params: {
      appKey: string;
      displayName?: string;
      baseUrl?: string;
      version?: string;
      meta?: Record<string, unknown>;
    },
    providerKey: string,
  ): Promise<InspectorEntity> {
    const { appKey, displayName, baseUrl, meta = {} } = params;
    const studioKey =
      typeof meta.studioKey === 'string' ? meta.studioKey : undefined;
    const snapshot = meta.inspectorSnapshot as
      | Record<string, unknown>
      | undefined;
    const existing = await this.inspectorRepository.findOne({
      where: { name: appKey },
      withDeleted: true,
    });

    const baseFromSnapshot = snapshot
      ? {
          key: appKey,
          restApiUrl: baseUrl ?? (snapshot.restApiUrl as string) ?? '',
          providerKey,
          ...snapshot,
        }
      : undefined;

    const options: Inspector & { providerKey?: string; studioKey?: string } = {
      ...defaultInspectorOptions(),
      ...baseFromSnapshot,
      key: appKey,
      restApiUrl: baseUrl ?? baseFromSnapshot?.restApiUrl ?? '',
      providerKey,
      ...(studioKey ? { studioKey } : {}),
    };

    if (existing) {
      existing.options = { ...existing.options, ...options };
      await this.inspectorRepository.save(existing);
      return existing;
    }

    const entity = this.inspectorRepository.create({
      name: appKey,
      options,
    });
    await this.inspectorRepository.save(entity);
    return entity;
  }

  /**
   * Mark inspector as offline when it unregisters from app registry.
   */
  async markOfflineByAppKey(appKey: string): Promise<void> {
    const existing = await this.inspectorRepository.findOne({
      where: { name: appKey },
      withDeleted: true,
    });
    if (!existing) return;
    existing.options = {
      ...existing.options,
      isActive: false,
    };
    await this.inspectorRepository.save(existing);
  }

  // -------------------------------------------------------
  // UPDATE
  // -------------------------------------------------------
  async update(name: string, options: Inspector): Promise<InspectorEntity> {
    const existing = await this.inspectorRepository.findOne({
      where: { name },
    });

    if (!existing) throw new NotFoundException(`Inspector "${name}" not found`);

    existing.options = options;

    await this.inspectorRepository.update(name, {
      options,
      updatedAt: Date.now(),
    });

    return existing;
  }

  // -------------------------------------------------------
  // DELETE
  // -------------------------------------------------------
  async delete(name: string): Promise<boolean> {
    const existing = await this.inspectorRepository.findOne({
      where: { name },
    });

    if (!existing) return false;

    await this.inspectorRepository.delete(name);
    return true;
  }
}
