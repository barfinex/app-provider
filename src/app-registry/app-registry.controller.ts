import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiParam,
  ApiQuery,
  ApiOkResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import {
  HeartbeatAppDto,
  RegisterAppDto,
  RegisteredAppType,
  UnregisterAppDto,
} from './app-registry.types';
import { AppRegistryService } from './app-registry.service';
import { DetectorService } from '../detector/detector.service';
import { InspectorService } from '../inspector/inspector.service';
import { ConnectorService } from '../connector/connector.service';

const REGISTRY_UNAVAILABLE_MESSAGE = 'App registry temporarily unavailable';

@ApiTags('AppRegistry')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('apps/registry')
export class AppRegistryController {
  private readonly logger = new Logger(AppRegistryController.name);

  constructor(
    private readonly registry: AppRegistryService,
    private readonly detectorService: DetectorService,
    private readonly inspectorService: InspectorService,
    private readonly connectorService: ConnectorService,
  ) {}

  @Post('register')
  @ApiOperation({
    summary: 'Register app',
    description:
      'Registers an app (detector, inspector, advisor) with the Provider. For detectors, also upserts into /api/detectors.',
  })
  @ApiBody({
    description:
      'appKey, appType (advisor|inspector|detector), baseUrl, displayName?, version?, ip?, meta?',
    schema: {
      type: 'object',
      required: ['appKey', 'appType', 'baseUrl'],
      properties: {
        appKey: { type: 'string' },
        appType: { type: 'string', enum: ['advisor', 'inspector', 'detector'] },
        baseUrl: { type: 'string' },
        displayName: { type: 'string' },
        version: { type: 'string' },
        ip: { type: 'string' },
        meta: { type: 'object' },
      },
    },
  })
  @ApiOkResponse({ description: '{ ok: true, data: entity }' })
  async register(
    @Body() body: RegisterAppDto,
    @Req() req: { ip?: string; headers?: Record<string, unknown> },
  ) {
    try {
      const ip = body.ip || req.ip || this.extractForwardedIp(req.headers);
      const entity = await this.registry.register({
        ...body,
        ip,
      });
      if (body.appType === 'detector') {
        const providerKey = this.connectorService.key;
        if (providerKey) {
          try {
            await this.detectorService.upsertDetectorFromRegistration(
              {
                appKey: body.appKey,
                displayName: body.displayName,
                baseUrl: body.baseUrl,
                version: body.version,
                meta: entity.meta,
              },
              providerKey,
            );
            this.logger.log(
              `[detector] upserted in /api/detectors: ${body.appKey}`,
            );
          } catch (detErr) {
            this.logger.warn(
              `[detector] upsert failed for ${body.appKey}: ${
                detErr instanceof Error ? detErr.message : String(detErr)
              }`,
            );
          }
        }
      }
      if (body.appType === 'inspector') {
        const providerKey = this.connectorService.key;
        if (providerKey) {
          try {
            await this.inspectorService.upsertInspectorFromRegistration(
              {
                appKey: body.appKey,
                displayName: body.displayName,
                baseUrl: body.baseUrl,
                version: body.version,
                meta: entity.meta,
              },
              providerKey,
            );
            this.logger.log(
              `[inspector] upserted in /api/inspectors: ${body.appKey}`,
            );
          } catch (inspErr) {
            this.logger.warn(
              `[inspector] upsert failed for ${body.appKey}: ${
                inspErr instanceof Error ? inspErr.message : String(inspErr)
              }`,
            );
          }
        }
      }
      return { ok: true, data: entity };
    } catch (err) {
      this.logRegistryError('register', err);
      throw new ServiceUnavailableException(REGISTRY_UNAVAILABLE_MESSAGE);
    }
  }

  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'App heartbeat',
    description:
      'Heartbeat for a registered app. Keeps registration alive; for detectors, updates detector list.',
  })
  @ApiBody({
    description: 'appKey, appType, baseUrl?, ip?, meta?',
    schema: {
      type: 'object',
      required: ['appKey', 'appType'],
      properties: {
        appKey: { type: 'string' },
        appType: { type: 'string', enum: ['advisor', 'inspector', 'detector'] },
        baseUrl: { type: 'string' },
        ip: { type: 'string' },
        meta: { type: 'object' },
      },
    },
  })
  @ApiOkResponse({ description: '{ ok: true, data: entity }' })
  async heartbeat(
    @Body() body: HeartbeatAppDto,
    @Req() req: { ip?: string; headers?: Record<string, unknown> },
  ) {
    try {
      const ip = body.ip || req.ip || this.extractForwardedIp(req.headers);
      const entity = await this.registry.heartbeat({
        ...body,
        ip,
      });
      if (body.appType === 'detector') {
        const providerKey = this.connectorService.key;
        if (providerKey) {
          try {
            await this.detectorService.upsertDetectorFromRegistration(
              {
                appKey: body.appKey,
                displayName: entity.displayName,
                baseUrl: body.baseUrl ?? entity.baseUrl,
                version: entity.version,
                meta: entity.meta,
              },
              providerKey,
            );
          } catch {
            // non-fatal: heartbeat succeeded, detector list update is best-effort
          }
        }
      }
      if (body.appType === 'inspector') {
        const providerKey = this.connectorService.key;
        if (providerKey) {
          try {
            await this.inspectorService.upsertInspectorFromRegistration(
              {
                appKey: body.appKey,
                displayName: entity.displayName,
                baseUrl: body.baseUrl ?? entity.baseUrl,
                version: entity.version,
                meta: entity.meta,
              },
              providerKey,
            );
          } catch {
            // non-fatal: heartbeat succeeded, inspector list update is best-effort
          }
        }
      }
      return { ok: true, data: entity };
    } catch (err) {
      this.logRegistryError('heartbeat', err);
      throw new ServiceUnavailableException(REGISTRY_UNAVAILABLE_MESSAGE);
    }
  }

  @Post('unregister')
  @ApiOperation({
    summary: 'Unregister app',
    description:
      'Unregisters an app by appKey and appType. App remains in registry with status unregistered (shown as disabled in Studio).',
  })
  @ApiBody({
    description: 'appKey, appType, reason?',
    schema: {
      type: 'object',
      required: ['appKey', 'appType'],
      properties: {
        appKey: { type: 'string' },
        appType: { type: 'string', enum: ['advisor', 'inspector', 'detector'] },
        reason: { type: 'string' },
      },
    },
  })
  @ApiOkResponse({ description: '{ ok: true, data: entity }' })
  async unregister(@Body() body: UnregisterAppDto) {
    try {
      const entity = await this.registry.unregister(body);
      if (body.appType === 'detector') {
        try {
          await this.detectorService.markOfflineByAppKey(body.appKey);
          this.logger.log(
            `[detector] marked offline in detectors list: ${body.appKey}`,
          );
        } catch (detErr) {
          this.logger.warn(
            `[detector] markOffline failed for ${body.appKey}: ${
              detErr instanceof Error ? detErr.message : String(detErr)
            }`,
          );
        }
      }
      if (body.appType === 'inspector') {
        try {
          await this.inspectorService.markOfflineByAppKey(body.appKey);
          this.logger.log(
            `[inspector] marked offline in inspectors list: ${body.appKey}`,
          );
        } catch (inspErr) {
          this.logger.warn(
            `[inspector] markOffline failed for ${body.appKey}: ${
              inspErr instanceof Error ? inspErr.message : String(inspErr)
            }`,
          );
        }
      }
      return { ok: true, data: entity };
    } catch (err) {
      this.logRegistryError('unregister', err);
      throw new ServiceUnavailableException(REGISTRY_UNAVAILABLE_MESSAGE);
    }
  }

  @Get('advisors')
  @ApiOperation({
    summary: 'List advisors',
    description:
      'Returns all advisors (active and unregistered) for Studio. Same shape as detectors list; includes providerKey.',
  })
  @ApiOkResponse({ description: '{ ok: true, data: RegisteredAppListItem[] }' })
  async listAdvisors() {
    try {
      const data = await this.registry.list({
        appType: 'advisor',
        includeInactive: true,
      });
      const providerKey = this.connectorService.key;
      const items = await Promise.all(
        data.map(async (r) => {
          const item = this.toAppListItem(r, providerKey);
          if (item.status === 'active' && r.baseUrl) {
            try {
              const res = await fetch(`${r.baseUrl}/advisor/health`, {
                signal: AbortSignal.timeout(3000),
              });
              if (res.ok) {
                const health = (await res.json()) as Record<string, unknown>;
                const symbolCount = Number(health.marketStateSymbols ?? 0);
                const throttle = health.throttleState as
                  | Record<string, unknown>
                  | undefined;
                const instrumentNames = throttle
                  ? Object.keys(throttle)
                  : Array.from(
                      { length: symbolCount },
                      (_, i) => `symbol_${i}`,
                    );
                return {
                  ...item,
                  symbols: instrumentNames,
                  strategies: Object.keys(throttle ?? {}),
                  health: 'OK',
                };
              }
            } catch {
              /* advisor unreachable — keep defaults */
            }
          }
          return {
            ...item,
            symbols: [],
            strategies: [],
            health: item.status === 'active' ? 'OK' : undefined,
          };
        }),
      );
      return { ok: true, data: items };
    } catch (err) {
      this.logRegistryError('listAdvisors', err);
      throw new ServiceUnavailableException(REGISTRY_UNAVAILABLE_MESSAGE);
    }
  }

  @Get('inspectors')
  @ApiOperation({
    summary: 'List inspectors',
    description:
      'Returns all inspectors (active and unregistered) for Studio. Same shape as detectors list; includes providerKey.',
  })
  @ApiOkResponse({ description: '{ ok: true, data: RegisteredAppListItem[] }' })
  async listInspectors() {
    try {
      const data = await this.registry.list({
        appType: 'inspector',
        includeInactive: true,
      });
      const providerKey = this.connectorService.key;
      const items = data.map((r) => this.toAppListItem(r, providerKey));
      return { ok: true, data: items };
    } catch (err) {
      this.logRegistryError('listInspectors', err);
      throw new ServiceUnavailableException(REGISTRY_UNAVAILABLE_MESSAGE);
    }
  }

  @Get()
  @ApiOperation({
    summary: 'List registered apps',
    description:
      'Returns all registered apps. Optional filter by appType and includeInactive.',
  })
  @ApiQuery({
    name: 'appType',
    required: false,
    description: 'Filter by app type',
  })
  @ApiQuery({
    name: 'includeInactive',
    required: false,
    description: 'Include inactive (default false)',
  })
  @ApiOkResponse({ description: '{ ok: true, count, data }' })
  async list(
    @Query('appType') appType?: RegisteredAppType,
    @Query('includeInactive') includeInactive = 'false',
  ) {
    try {
      const data = await this.registry.list({
        appType,
        includeInactive: String(includeInactive) === 'true',
      });
      return { ok: true, count: data.length, data };
    } catch (err) {
      this.logRegistryError('list', err);
      throw new ServiceUnavailableException(REGISTRY_UNAVAILABLE_MESSAGE);
    }
  }

  @Get(':appType/:appKey')
  @ApiOperation({
    summary: 'Get one registered app',
    description: 'Returns a single app by appType and appKey.',
  })
  @ApiParam({
    name: 'appType',
    description: 'App type (detector, inspector, advisor)',
  })
  @ApiParam({ name: 'appKey', description: 'App key' })
  @ApiOkResponse({ description: '{ ok: true, data: row }' })
  async getOne(
    @Param('appType') appType: RegisteredAppType,
    @Param('appKey') appKey: string,
  ) {
    try {
      const data = await this.registry.list({ appType, includeInactive: true });
      const row = data.find((x) => x.appKey === appKey) ?? null;
      return { ok: true, data: row };
    } catch (err) {
      this.logRegistryError('getOne', err);
      throw new ServiceUnavailableException(REGISTRY_UNAVAILABLE_MESSAGE);
    }
  }

  /** Studio-friendly list item: key, displayName, baseUrl, status (active | offline | unregistered), providerKey. */
  private toAppListItem(
    r: {
      appKey: string;
      displayName?: string;
      baseUrl: string;
      version?: string;
      status: 'registered' | 'unregistered';
      lastHeartbeatAt: number;
      registeredAt: number;
      unregisteredAt?: number | null;
      isActive: boolean;
      meta?: Record<string, unknown>;
    },
    providerKey?: string,
  ): {
    key: string;
    displayName?: string;
    baseUrl: string;
    version?: string;
    status: 'active' | 'offline' | 'unregistered';
    lastHeartbeatAt: number;
    registeredAt: number;
    unregisteredAt?: number | null;
    providerKey?: string;
  } {
    const status: 'active' | 'offline' | 'unregistered' =
      r.status === 'unregistered'
        ? 'unregistered'
        : r.isActive
        ? 'active'
        : 'offline';
    const meta = r.meta;
    const studioKey =
      meta && typeof meta.studioKey === 'string' ? meta.studioKey : undefined;
    return {
      key: studioKey ?? r.appKey,
      displayName: r.displayName,
      baseUrl: r.baseUrl,
      version: r.version,
      status,
      lastHeartbeatAt: r.lastHeartbeatAt,
      registeredAt: r.registeredAt,
      unregisteredAt: r.unregisteredAt ?? undefined,
      ...(providerKey ? { providerKey } : {}),
    };
  }

  private logRegistryError(operation: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    this.logger.warn(
      `[app-registry] ${operation} failed (returning 503): ${message}`,
    );
    if (stack) this.logger.debug(stack);
  }

  private extractForwardedIp(
    headers?: Record<string, unknown>,
  ): string | undefined {
    if (!headers) return undefined;
    const xff = headers['x-forwarded-for'];
    if (!xff) return undefined;
    const value = Array.isArray(xff) ? xff[0] : xff;
    return String(value).split(',')[0]?.trim();
  }
}
