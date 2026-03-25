import { Controller, Get, Logger } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { AppRegistryService } from '../app-registry/app-registry.service';
import { ConnectorService } from '../connector/connector.service';

export type AdvisorStatusEnum =
  | 'NOT_REGISTERED'
  | 'REGISTERED'
  | 'ACTIVE'
  | 'DEGRADED'
  | 'INACTIVE';
export type AdvisorHealthEnum = 'OK' | 'ERROR';

export interface ProviderAdvisorDto {
  /** Advisor app key (same as advisorId; for parity with detectors list) */
  key: string;
  advisorId: string;
  name: string;
  status: AdvisorStatusEnum;
  health: AdvisorHealthEnum;
  lastHeartbeat: number;
  symbols: string[];
  strategies: string[];
  /** Provider instance key this advisor is registered with (like detectors[].providers[].key) */
  providerKey?: string;
  /** Optional: baseUrl from registry */
  baseUrl?: string;
  /** Optional: version from registry */
  version?: string;
  /** Registry timestamps (no extra call) */
  registeredAt?: number;
  unregisteredAt?: number | null;
  updatedAt?: number;
  /** Last known IP */
  ip?: string;
  /** Whether heartbeat is within TTL */
  isActive?: boolean;
  /** Ms since last heartbeat */
  staleMs?: number;
}

export interface ProviderAdvisorsResponseDto {
  advisors: ProviderAdvisorDto[];
}

/** Explicit advisor presence for UI (single source of truth). */
export interface ProviderAdvisorSummaryDto {
  hasAdvisors: boolean;
  advisorCount: number;
}

@ApiTags('Provider')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('provider')
export class ProviderAdvisorsController {
  private readonly logger = new Logger(ProviderAdvisorsController.name);

  constructor(
    private readonly appRegistry: AppRegistryService,
    private readonly connectorService: ConnectorService,
  ) {}

  @Get('advisor-summary')
  @ApiOperation({
    summary: 'Advisor presence summary',
    description:
      'Returns whether this provider has any advisors and the count. Use for deterministic UI (no advisors = show empty state).',
  })
  @ApiOkResponse({ description: '{ hasAdvisors, advisorCount }' })
  async getAdvisorSummary(): Promise<ProviderAdvisorSummaryDto> {
    const rows = await this.appRegistry.list({
      appType: 'advisor',
      includeInactive: true,
    });
    const advisorCount = rows.length;
    const hasAdvisors = advisorCount > 0;
    this.logger.log({ advisorCount, hasAdvisors });
    return { hasAdvisors, advisorCount };
  }

  @Get('advisors')
  @ApiOperation({
    summary: 'List advisors',
    description:
      'Returns all advisors registered with this Provider. Status and health are derived from registry (heartbeat). Includes key, providerKey (like detectors), and registry timestamps.',
  })
  @ApiOkResponse({ description: '{ advisors: ProviderAdvisorDto[] }' })
  async listAdvisors(): Promise<ProviderAdvisorsResponseDto> {
    const rows = await this.appRegistry.list({
      appType: 'advisor',
      includeInactive: true,
    });
    const providerKey = this.connectorService.key;
    const advisors: ProviderAdvisorDto[] = rows.map((r) => {
      const status = this.toAdvisorStatus(r);
      const health: AdvisorHealthEnum =
        status === 'ACTIVE' ? 'OK' : status === 'DEGRADED' ? 'ERROR' : 'ERROR';
      const meta = (r.meta ?? {}) as Record<string, unknown>;
      const studioKey =
        typeof meta.studioKey === 'string' ? meta.studioKey : undefined;
      const symbols = Array.isArray(meta.symbols)
        ? (meta.symbols as string[])
        : [];
      const strategies = Array.isArray(meta.strategies)
        ? (meta.strategies as string[])
        : [];
      return {
        key: studioKey ?? r.appKey,
        advisorId: r.appKey,
        name: r.displayName ?? r.appKey,
        status,
        health,
        lastHeartbeat: r.lastHeartbeatAt ?? 0,
        symbols,
        strategies,
        providerKey: providerKey ?? undefined,
        baseUrl: r.baseUrl,
        version: r.version,
        registeredAt: r.registeredAt,
        unregisteredAt: r.unregisteredAt ?? undefined,
        updatedAt: r.updatedAt,
        ip: r.ip,
        isActive: r.isActive,
        staleMs: r.staleMs,
      };
    });
    return { advisors };
  }

  private toAdvisorStatus(r: {
    status: string;
    isActive: boolean;
    staleMs: number;
  }): AdvisorStatusEnum {
    if (r.status === 'unregistered') return 'NOT_REGISTERED';
    if (r.isActive) return 'ACTIVE';
    return r.staleMs > 0 ? 'INACTIVE' : 'REGISTERED';
  }
}
