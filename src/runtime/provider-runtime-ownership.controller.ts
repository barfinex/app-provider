import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiOkResponse,
  ApiParam,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { ProviderInstanceService } from '../ownership/provider-instance.service';
import { ProviderOwnershipService } from '../ownership/provider-ownership.service';
import { InstrumentShardService } from '../ownership/instrument-shard.service';
import { ProviderMetricsService } from './provider-metrics.service';
import {
  ownershipScopeKey,
  parseOwnershipKeyToScope,
} from '../ownership/ownership.types';
import {
  ProviderRuntimeInstanceDto,
  ProviderRuntimeMetricsDto,
  ProviderShardsDto,
} from '../dto';

@ApiTags('Runtime')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('provider/runtime')
export class ProviderRuntimeOwnershipController {
  constructor(
    private readonly instance: ProviderInstanceService,
    private readonly ownership: ProviderOwnershipService,
    private readonly instrumentShardService: InstrumentShardService,
    private readonly metrics: ProviderMetricsService,
  ) {}

  @Get('instance')
  @ApiOperation({
    summary: 'Provider instance identity',
    description:
      'Returns current Provider instance id, hostname, pid, boot time, uptime. Used for ingestion cluster state and instance identity.',
  })
  @ApiOkResponse({
    description: 'Instance id, hostname, pid, boot time, uptime',
  })
  getInstance() {
    return this.instance.getRuntimeMetadata();
  }

  @Get('ownership')
  @ApiOperation({
    summary: 'Ingestion cluster ownership',
    description:
      'Returns all ingestion ownership records and local state. Shows which instance owns each scope (e.g. BINANCE:SPOT).',
  })
  @ApiOkResponse({
    description:
      'instanceId and ownerships[] with ownershipKey, ownerInstanceId, localRole, localState',
  })
  async getOwnership() {
    const records = await this.ownership.listAllOwnerships();
    const localInstanceId = this.instance.providerInstanceId;
    const out = records.map((r) => {
      const scope = parseOwnershipKeyToScope(r.ownershipKey);
      const local = this.ownership.getScopeState(scope);
      return {
        ownershipKey: r.ownershipKey,
        ownerInstanceId: r.ownerInstanceId,
        fencingToken: r.fencingToken,
        leaseExpiresAt: r.leaseExpiresAt,
        lastHeartbeat: r.lastHeartbeat,
        localInstanceId,
        localRole: r.ownerInstanceId === localInstanceId ? 'owner' : 'standby',
        localState: local.state,
      };
    });
    return { instanceId: localInstanceId, ownerships: out };
  }

  @Get('ownership/:scope')
  @ApiOperation({
    summary: 'Ownership for one scope',
    description:
      'Returns ownership and local state for a single scope (e.g. BINANCE:SPOT or BINANCE:SPOT:shard0).',
  })
  @ApiParam({
    name: 'scope',
    example: 'BINANCE:SPOT',
    description: 'Scope key (connector:market or connector:market:shardN)',
  })
  @ApiOkResponse({
    description: 'Ownership record and local state for the scope',
  })
  async getOwnershipByScope(@Param('scope') scopeParam: string) {
    const scope = parseOwnershipKeyToScope(scopeParam);
    const key = ownershipScopeKey(scope);
    const record = await this.ownership.getOwnershipRecord(scope);
    const local = this.ownership.getScopeState(scope);
    const localInstanceId = this.instance.providerInstanceId;
    return {
      ownershipKey: key,
      record: record ?? null,
      localInstanceId,
      localRole:
        record?.ownerInstanceId === localInstanceId ? 'owner' : 'standby',
      localState: local.state,
      fencingToken: local.fencingToken,
    };
  }

  @Get('shards')
  @ApiOperation({
    summary: 'Instrument shard distribution',
    description:
      'Returns symbol sharding state: instance id, owned shards, shard count. Used for ingestion cluster and shard distribution.',
  })
  @ApiOkResponse({
    description:
      'instanceId, shardingEnabled, shardCount, localShardIds, ownedShards',
    type: ProviderShardsDto,
  })
  getShards() {
    const instanceId = this.instance.providerInstanceId;
    const enabled = this.instrumentShardService.isEnabled();
    const shardCount = this.instrumentShardService.getShardCount();
    const localShardIds = this.instrumentShardService.getLocalShardIds();
    const tracked = this.ownership.getTrackedScopes();
    const ownedShards = tracked
      .filter((s) => s.shardId !== undefined && s.shardId !== null)
      .map((s) => ({
        ownershipKey: `${s.connectorType}:${s.marketType}:shard${s.shardId}`,
        connectorType: s.connectorType,
        marketType: s.marketType,
        shardId: s.shardId,
      }));
    return {
      instanceId,
      shardingEnabled: enabled,
      shardCount,
      localShardIds,
      ownedShards,
      symbolsPerShard: [] as {
        connectorType: string;
        marketType: string;
        shardId: number;
        symbols: string[];
      }[],
    };
  }

  @Get('instances')
  @ApiOperation({
    summary: 'Provider runtime instances',
    description:
      'Returns Provider instance(s) with uptime, owned scopes, shards, trade rate, orderbook rate. ' +
      'Ingestion cluster state; typically one instance per process.',
  })
  @ApiOkResponse({
    description:
      'Array of instance id, uptimeMs, ownedScopes, shards, tradeRate, orderbookRate',
    type: ProviderRuntimeInstanceDto,
    isArray: true,
  })
  getInstances() {
    const meta = this.instance.getRuntimeMetadata();
    const ownedScopes = this.ownership
      .getTrackedScopes()
      .filter((s) => this.ownership.isActiveOwner(s))
      .map((s) => ownershipScopeKey(s));
    const localShardIds = this.instrumentShardService.getLocalShardIds();
    const shards = localShardIds.map((id) => `shard${id}`);
    const { tradeRate, orderbookRate } = this.metrics.getMetrics();
    return [
      {
        instanceId: meta.providerInstanceId,
        uptimeMs: meta.uptimeMs,
        ownedScopes,
        shards,
        tradeRate,
        orderbookRate,
      },
    ];
  }

  @Get('metrics')
  @ApiOperation({
    summary: 'Ingestion metrics',
    description:
      'Returns ingestion metrics: trade rate, orderbook rate, symbol throughput. Used for observability.',
  })
  @ApiOkResponse({
    description: 'tradeRate, orderbookRate, symbols[]',
    type: ProviderRuntimeMetricsDto,
  })
  getMetrics() {
    return this.metrics.getMetrics();
  }
}
