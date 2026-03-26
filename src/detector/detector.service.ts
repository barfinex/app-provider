import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  forwardRef,
} from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';

import { catchError, map, lastValueFrom } from 'rxjs';

import { DetectorRepository, DetectorEntity } from './detector.repository';
import {
  Detector,
  DetectorListItem,
  DetectorStatus,
  MarketType,
  ConnectorType,
  TimeFrame,
  Trade,
  Instrument,
} from '@barfinex/types';
import { buildDetectorConfig } from '@barfinex/types';

import { ConnectorService } from '../connector/connector.service';
import { OrderService } from '../order/order.service';
import { AppRegistryService } from '../app-registry/app-registry.service';

function detectorStatus(opts: {
  isActive?: boolean;
  isBlocked?: boolean;
}): DetectorStatus {
  if (opts.isBlocked === true) return 'blocked';
  if (opts.isActive === false) return 'disabled';
  return 'active';
}

@Injectable()
export class DetectorService {
  constructor(
    private readonly http: HttpService,

    private readonly detectorRepository: DetectorRepository,

    @Inject(forwardRef(() => ConnectorService))
    private readonly connectorService: ConnectorService,

    @Inject(forwardRef(() => OrderService))
    private readonly orderService: OrderService,

    @Inject(forwardRef(() => AppRegistryService))
    private readonly appRegistry: AppRegistryService,
  ) {}

  // -------------------------------------------------------
  // GET LIST BY PROVIDER KEY
  // -------------------------------------------------------
  async getAllDetectorsByProviderKey(
    providerKey: string,
  ): Promise<DetectorListItem[]> {
    const [detectors, activeKeys] = await Promise.all([
      this.detectorRepository.find(),
      this.appRegistry.getActiveAppKeys('detector'),
    ]);

    return detectors
      .filter((d) =>
        d.options.providers?.some(
          (p: { key: string }) => p.key === providerKey,
        ),
      )
      .map((d) => ({
        ...d.options,
        status: activeKeys.has(d.options.key)
          ? detectorStatus({
              isActive: d.options.isActive,
              isBlocked: d.options.isBlocked,
            })
          : 'offline',
      }));
  }

  // -------------------------------------------------------
  // GET ALL DETECTORS
  // -------------------------------------------------------
  async getAllDetectors(): Promise<DetectorListItem[]> {
    const [entities, activeKeys] = await Promise.all([
      this.detectorRepository.find(),
      this.appRegistry.getActiveAppKeys('detector'),
    ]);
    return entities.map((e) => ({
      ...e.options,
      status: activeKeys.has(e.options.key)
        ? detectorStatus({
            isActive: e.options.isActive,
            isBlocked: e.options.isBlocked,
          })
        : 'offline',
    }));
  }

  // -------------------------------------------------------
  // CREATE DETECTOR
  // -------------------------------------------------------
  async createDetector(detector: Detector): Promise<Detector> {
    const existing = await this.detectorRepository.findOne({
      where: { key: detector.key },
    });

    if (existing) {
      throw new ConflictException(
        `Detector with key "${detector.key}" already exists`,
      );
    }

    const entity = this.detectorRepository.create({
      key: detector.key,
      name: detector.sysname,
      options: detector,
    });

    const saved = await this.detectorRepository.save(entity);
    return saved.options;
  }

  // -------------------------------------------------------
  // UPDATE DETECTOR BY KEY
  // -------------------------------------------------------
  async updateDetectorByKey(
    key: string,
    update: Partial<Detector>,
  ): Promise<DetectorEntity | null> {
    const entity = await this.detectorRepository.findOne({ where: { key } });
    if (!entity) return null;

    const merged: Detector = {
      ...entity.options,
      ...update,
    };

    entity.options = merged;
    entity.name = merged.sysname ?? entity.name;

    await this.detectorRepository.save(entity);
    return entity;
  }

  // -------------------------------------------------------
  // DELETE DETECTOR
  // -------------------------------------------------------
  async deleteDetectorByKey(key: string): Promise<boolean> {
    const existing = await this.detectorRepository.getByKey(key);

    if (!existing) return false;

    await this.detectorRepository.delete(key);

    return true;
  }

  // -------------------------------------------------------
  // DELETE ALL ORDERS FOR DETECTOR
  // -------------------------------------------------------
  async deleteAllOrders(options: {
    connectorType: ConnectorType;
    marketType: MarketType;
    symbols?: Instrument[];
    sysname: string;
  }): Promise<boolean> {
    const { connectorType, marketType, symbols } = options;
    return this.orderService.deleteAll({ connectorType, marketType });
  }

  // -------------------------------------------------------
  // UPDATE SUBSCRIPTIONS FOR CONNECTOR
  // -------------------------------------------------------
  async updateSubscribeCollectionInConnector(options: {
    connectorType: ConnectorType;
    marketType: MarketType;
    instruments: Instrument[];
    intervals?: TimeFrame[];
  }) {
    const { connectorType, marketType, instruments, intervals } = options;

    return this.connectorService.updateSubscribeCollection(
      connectorType,
      marketType,
      instruments,
      intervals,
    );
  }

  // -------------------------------------------------------
  // CREATE OR UPDATE DETECTOR (LEGACY)
  // -------------------------------------------------------
  async create(detector: Detector): Promise<Detector> {
    const { key } = detector;

    const existing = await this.detectorRepository.findOne({ where: { key } });

    if (existing) {
      existing.options = detector;
      await this.detectorRepository.save(existing);
      return existing.options;
    }

    const newDetector = this.detectorRepository.create({
      key,
      options: detector,
    });

    const saved = await this.detectorRepository.save(newDetector);
    return saved.options;
  }

  // -------------------------------------------------------
  // UPSERT DETECTOR FROM APP REGISTRY (register/heartbeat)
  // So GET /api/detectors shows running detectors.
  // Uses meta.studioKey (UUID for UI studio) and meta.detectorSnapshot (config at startup).
  // -------------------------------------------------------
  async upsertDetectorFromRegistration(
    params: {
      appKey: string;
      displayName?: string;
      baseUrl?: string;
      version?: string;
      meta?: Record<string, unknown>;
    },
    providerKey: string,
  ): Promise<Detector> {
    const { appKey, displayName, baseUrl, meta = {} } = params;
    const studioKey =
      typeof meta.studioKey === 'string' ? meta.studioKey : undefined;
    const snapshot = meta.detectorSnapshot as
      | Record<string, unknown>
      | undefined;
    const existing = await this.detectorRepository.findOne({
      where: { key: appKey },
    });

    const providerStub = {
      key: providerKey,
      apiToken: '',
      restApiUrl: '',
      accounts: [],
    };

    const baseFromSnapshot = snapshot
      ? {
          key: appKey,
          sysname: (snapshot.sysname as string) ?? displayName ?? appKey,
          restApiUrl: baseUrl ?? (snapshot.restApiUrl as string) ?? '',
          providers:
            Array.isArray(snapshot.providers) &&
            (snapshot.providers as any[]).length > 0
              ? (snapshot.providers as any[]).map((p: any) => ({
                  ...p,
                  apiToken: p.apiToken ?? '',
                  accounts: p.accounts ?? [],
                }))
              : [providerStub],
          instruments: Array.isArray(snapshot.instruments) ? snapshot.instruments : [],
          intervals: Array.isArray(snapshot.intervals)
            ? snapshot.intervals
            : [],
          subscriptions: Array.isArray(snapshot.subscriptions)
            ? snapshot.subscriptions
            : [],
          qualityGate: snapshot.qualityGate,
          performance: snapshot.performance,
          customConfig: snapshot.customConfig,
          plugins:
            snapshot.plugins && typeof snapshot.plugins === 'object'
              ? { modules: [], metas: (snapshot.plugins as any).metas ?? [] }
              : undefined,
          logLevel: snapshot.logLevel,
          currency: snapshot.currency,
          useSandbox: snapshot.useSandbox,
          useScratch: snapshot.useScratch,
          isBlocked: snapshot.isBlocked,
          isActive: snapshot.isActive,
        }
      : undefined;

    const detector = buildDetectorConfig({
      ...(baseFromSnapshot ?? {}),
      key: appKey,
      sysname: baseFromSnapshot?.sysname ?? displayName ?? appKey,
      restApiUrl: baseUrl ?? baseFromSnapshot?.restApiUrl ?? '',
      providers: baseFromSnapshot?.providers ?? [providerStub],
      instruments: baseFromSnapshot?.instruments ?? [],
      intervals: baseFromSnapshot?.intervals ?? [],
    } as any);

    const optionsWithStudioKey: Detector = {
      ...detector,
      ...(studioKey ? { studioKey } : {}),
    };

    if (existing) {
      const merged: Detector = {
        ...existing.options,
        sysname:
          baseFromSnapshot?.sysname ?? displayName ?? existing.options.sysname,
        restApiUrl: baseUrl ?? existing.options.restApiUrl,
        ...(studioKey ? { studioKey } : {}),
        ...(baseFromSnapshot
          ? {
              instruments: baseFromSnapshot.instruments,
              intervals: baseFromSnapshot.intervals,
              subscriptions: baseFromSnapshot.subscriptions,
              qualityGate: baseFromSnapshot.qualityGate,
              performance: baseFromSnapshot.performance,
              customConfig: baseFromSnapshot.customConfig,
              plugins: baseFromSnapshot.plugins,
              isActive:
                baseFromSnapshot.isActive !== undefined
                  ? baseFromSnapshot.isActive
                  : true,
              isBlocked:
                baseFromSnapshot.isBlocked !== undefined
                  ? baseFromSnapshot.isBlocked
                  : existing.options.isBlocked,
            }
          : { isActive: true }),
      };
      existing.options = merged;
      existing.name = merged.sysname ?? existing.name;
      await this.detectorRepository.save(existing);
      return existing.options;
    }

    const entity = this.detectorRepository.create({
      key: appKey,
      name: optionsWithStudioKey.sysname ?? displayName ?? appKey,
      options: optionsWithStudioKey,
    });
    await this.detectorRepository.save(entity);
    return entity.options;
  }

  /**
   * Mark detector as offline when it unregisters from app registry.
   * Does not delete; detector stays in list with status offline/disabled.
   */
  async markOfflineByAppKey(appKey: string): Promise<void> {
    const existing = await this.detectorRepository.findOne({
      where: { key: appKey },
    });
    if (!existing) return;
    existing.options = {
      ...existing.options,
      isActive: false,
    };
    await this.detectorRepository.save(existing);
  }

  // -------------------------------------------------------
  // GET ACTIVE SYMBOLS
  // -------------------------------------------------------
  async getAllActiveSymbols(): Promise<Instrument[]> {
    const detectors = await this.detectorRepository.find();

    const result: Instrument[] = [];

    for (const d of detectors) {
      if (!d.options.isActive) continue;
      for (const s of d.options.instruments) {
        if (!result.find((q) => q.symbol === s.symbol)) {
          result.push({ symbol: s.symbol });
        }
      }
    }

    return result;
  }

  // -------------------------------------------------------
  // GET DETECTOR BY KEY OR SYSNAME
  // -------------------------------------------------------
  async getDetector(options: {
    sysname?: string;
    key?: string;
  }): Promise<Detector> {
    const { sysname, key } = options;

    const empty: Detector = {
      key: '',
      sysname: '',
      logLevel: '',
      currency: '',
      useNotifications: {
        telegram: { token: '', chatId: '', messageFormat: '', isActive: false },
      },
      advisor: {
        key: '',
        restApiUrl: '',
        providerApi: '',
        connectorTypes: [],
        marketTypes: [],
        takeProfitPercent: 0,
        stopLossPercent: 0,
        commisions: [],
        aiIntegration: {
          apiKey: '',
          defaultModel: '',
          responseTemperature: 0,
          maxTokens: 0,
          supportedFeatures: [],
        },
        cacheSettings: {
          cacheHost: '',
          cachePort: 0,
          defaultTTL: 0,
        },
        scenarioAnalysis: {
          enabled: false,
          predefinedScenarios: [],
          maxAnalysisDepth: 0,
          customScenarios: [],
        },
        logging: {
          verbose: false,
          logFilePath: '',
          externalMonitoring: false,
        },
        portfolioOptimization: {
          enabled: false,
          riskTolerance: 'low',
          strategies: [],
        },
      },
      restApiUrl: '',
      providers: [],
      instruments: [],
      orders: [],
      intervals: [],
      indicators: [],
      useSandbox: false,
      useScratch: false,
      subscriptions: [],
    };

    const where = sysname ? { name: sysname } : key ? { key } : null;

    if (!where) return empty;

    const detector = await this.detectorRepository.findOne({ where });

    return detector ? detector.options : empty;
  }

  // -------------------------------------------------------
  // GET PRICES FROM PROVIDER
  // -------------------------------------------------------
  async getPrices(options: {
    sysname?: string;
    key?: string;
    instruments: Instrument[];
  }): Promise<{ [k: string]: { value: number; moment: number } }> {
    const detector = await this.getDetector(options);

    const result: Record<string, { value: number; moment: number }> = {};

    for (const provider of detector.providers) {
      if (!provider.restApiUrl) continue;

      try {
        const url = `${provider.restApiUrl}/symbols/lasttrades`;
        const request = this.http
          .get(url)
          .pipe(map((res) => res.data))
          .pipe(
            catchError((err) => {
              throw new ForbiddenException(`${url} ${err}`);
            }),
          );

        const trades: { [k: string]: Trade } = await lastValueFrom(request);

        for (const k of Object.keys(trades)) {
          result[k] = {
            value: trades[k].price,
            moment: trades[k].time,
          };
        }
      } catch {}

      return result;
    }

    return result;
  }

  // -------------------------------------------------------
  // GET INDICATOR STATE
  // -------------------------------------------------------
  async getSymbolIndocatorState(options: {
    sysname?: string;
    key?: string;
    instrument: Instrument;
    selectIndicators: string[];
    interval: TimeFrame;
  }): Promise<any> {
    const detector = await this.getDetector(options);

    let result = [];

    for (const provider of detector.providers) {
      if (!provider.restApiUrl) continue;

      try {
        const url = `${provider.restApiUrl}/symbols/${options.instrument.symbol}/indicators/${options.interval}?selectIndicators=${options.selectIndicators}`;
        const request = this.http
          .get(url)
          .pipe(map((res) => res.data))
          .pipe(
            catchError((err) => {
              throw new ForbiddenException(`${url} ${err}`);
            }),
          );

        result = await lastValueFrom(request);
      } catch {}
    }

    return result;
  }

  // -------------------------------------------------------
  // GET CANDLES STATE (пока пусто)
  // -------------------------------------------------------
  async getInstrumentCandlesState(options: {
    sysname?: string;
    key?: string;
    instrument: Instrument;
    interval: TimeFrame;
    orderBy: string;
  }): Promise<any> {
    return null;
  }

  // -------------------------------------------------------
  // DETECTOR SYMBOL SUMMARY
  // -------------------------------------------------------
  async getInstruments(sysname: string): Promise<any> {
    const detector = await this.getDetector({ sysname });
    const result = [];

    for (const provider of detector.providers) {
      if (!provider.connectors) continue;

      for (const connector of provider.connectors) {
        for (const market of connector.markets) {
          const connectorLastTrade = await this.connectorService.getPrices(
            connector.connectorType,
            market.marketType,
            market.instruments,
          );

          const detectorLastPrice = await this.getPrices({
            sysname,
            instruments: detector.instruments,
          });

          for (const symbol of detector.instruments) {
            result.push({
              name: symbol.symbol,
              leverage: symbol.leverage,
              defaultQuantity: symbol.quantity,
              intervals: detector.intervals,
              orders: [],
              connectorLastTrade: connectorLastTrade[symbol.symbol] || {
                value: 0,
                moment: null,
              },
              detectorLastPrice: detectorLastPrice[symbol.symbol] || {
                value: 0,
                moment: null,
              },
            });
          }
        }
      }
    }

    return result;
  }

  async getSymbolState(sysname: string, symbol: string): Promise<any> {
    return {};
  }

  async getPluginState(sysname: string, pluginSysname: string): Promise<any> {
    return {};
  }

  async getCapitalEfficiency(
    key: string,
    endpoint:
      | 'overview'
      | 'utilization'
      | 'suppression'
      | 'symbols'
      | 'reservations'
      | 'stability',
    query?: {
      from?: string;
      to?: string;
      instanceId?: string;
      symbol?: string;
    },
  ): Promise<any> {
    const detector = await this.getDetector({ key });
    const detectorApi = detector?.restApiUrl?.trim();
    if (!detectorApi) {
      throw new ForbiddenException(
        `Detector "${key}" does not expose restApiUrl`,
      );
    }

    const url = `${detectorApi}/detector/capital-efficiency/${endpoint}`;
    const request = this.http
      .get(url, { params: query ?? {} })
      .pipe(map((res) => res.data))
      .pipe(
        catchError((err) => {
          throw new ForbiddenException(`${url} ${err}`);
        }),
      );

    return lastValueFrom(request);
  }

  // -------------------------------------------------------
  // LEGACY UPDATE
  // -------------------------------------------------------
  async update(
    name: string,
    options: Detector,
  ): Promise<DetectorEntity | null> {
    const detector = await this.detectorRepository.findOne({ where: { name } });
    if (!detector) return null;

    detector.options = options;
    await this.detectorRepository.save(detector);
    return detector;
  }

  // -------------------------------------------------------
  // LEGACY DELETE
  // -------------------------------------------------------
  async delete(name: string): Promise<boolean> {
    const detector = await this.detectorRepository.findOne({ where: { name } });
    if (!detector) return false;

    await this.detectorRepository.delete(detector.key);
    return true;
  }
}
