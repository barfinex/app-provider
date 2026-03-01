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
import { ApiTags } from '@nestjs/swagger';
import {
  HeartbeatAppDto,
  RegisterAppDto,
  RegisteredAppType,
  UnregisterAppDto,
} from './app-registry.types';
import { AppRegistryService } from './app-registry.service';
import { DetectorService } from '../detector/detector.service';
import { ConnectorService } from '../connector/connector.service';

const REGISTRY_UNAVAILABLE_MESSAGE = 'App registry temporarily unavailable';

@ApiTags('AppRegistry')
@Controller('apps/registry')
export class AppRegistryController {
  private readonly logger = new Logger(AppRegistryController.name);

  constructor(
    private readonly registry: AppRegistryService,
    private readonly detectorService: DetectorService,
    private readonly connectorService: ConnectorService,
  ) {}

  @Post('register')
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
      return { ok: true, data: entity };
    } catch (err) {
      this.logRegistryError('register', err);
      throw new ServiceUnavailableException(REGISTRY_UNAVAILABLE_MESSAGE);
    }
  }

  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
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
      return { ok: true, data: entity };
    } catch (err) {
      this.logRegistryError('heartbeat', err);
      throw new ServiceUnavailableException(REGISTRY_UNAVAILABLE_MESSAGE);
    }
  }

  @Post('unregister')
  async unregister(@Body() body: UnregisterAppDto) {
    try {
      const entity = await this.registry.unregister(body);
      return { ok: true, data: entity };
    } catch (err) {
      this.logRegistryError('unregister', err);
      throw new ServiceUnavailableException(REGISTRY_UNAVAILABLE_MESSAGE);
    }
  }

  @Get()
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
  async getOne(
    @Param('appType') appType: RegisteredAppType,
    @Param('appKey') appKey: string,
  ) {
    try {
      const data = await this.registry.list({ appType, includeInactive: true });
      const row = data.find(x => x.appKey === appKey) ?? null;
      return { ok: true, data: row };
    } catch (err) {
      this.logRegistryError('getOne', err);
      throw new ServiceUnavailableException(REGISTRY_UNAVAILABLE_MESSAGE);
    }
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
