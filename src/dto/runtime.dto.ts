import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Provider instance identity and ingestion metrics. */
export class ProviderRuntimeInstanceDto {
  @ApiProperty({
    description: 'Provider instance identifier',
    example: 'provider-01',
  })
  instanceId!: string;

  @ApiProperty({ description: 'Uptime in milliseconds', example: 180000 })
  uptimeMs!: number;

  @ApiProperty({
    description: 'Owned ingestion scopes (e.g. BINANCE:SPOT)',
    example: ['BINANCE:SPOT', 'BINANCE:FUTURES'],
    type: [String],
  })
  ownedScopes!: string[];

  @ApiProperty({
    description: 'Symbol shard IDs this instance owns',
    example: ['shard0', 'shard1'],
    type: [String],
  })
  shards!: string[];

  @ApiProperty({
    description: 'Current trade message rate (msg/s)',
    example: 520,
  })
  tradeRate!: number;

  @ApiProperty({
    description: 'Current orderbook update rate (msg/s)',
    example: 140,
  })
  orderbookRate!: number;
}

/** Ingestion cluster metrics: trade rate, orderbook rate, symbol throughput. */
export class ProviderRuntimeMetricsDto {
  @ApiProperty({ description: 'Trade message rate (msg/s)', example: 520 })
  tradeRate!: number;

  @ApiProperty({ description: 'Orderbook update rate (msg/s)', example: 140 })
  orderbookRate!: number;

  @ApiPropertyOptional({
    description: 'Symbol-level throughput when available',
    type: [Object],
  })
  symbols?: unknown[];
}

/** Ownership record for a single scope (connector:market or connector:market:shard). */
export class ProviderOwnershipRecordDto {
  @ApiProperty({
    description: 'Ownership key (e.g. BINANCE:SPOT or BINANCE:SPOT:shard0)',
  })
  ownershipKey!: string;

  @ApiProperty({ description: 'Instance ID that owns this scope' })
  ownerInstanceId!: string;

  @ApiPropertyOptional({ description: 'Fencing token for leader election' })
  fencingToken?: number;

  @ApiPropertyOptional({ description: 'Lease expiration timestamp' })
  leaseExpiresAt?: number;

  @ApiPropertyOptional({ description: 'Last heartbeat timestamp' })
  lastHeartbeat?: number;

  @ApiProperty({ description: 'Current instance ID' })
  localInstanceId!: string;

  @ApiProperty({
    description: "Local role: 'owner' or 'standby'",
    enum: ['owner', 'standby'],
  })
  localRole!: string;

  @ApiProperty({ description: 'Local state for this scope' })
  localState!: string;
}

/** Symbol sharding state: instance, owned shards, symbols per shard. */
export class ProviderShardsDto {
  @ApiProperty({ description: 'Provider instance ID' })
  instanceId!: string;

  @ApiProperty({ description: 'Whether symbol sharding is enabled' })
  shardingEnabled!: boolean;

  @ApiProperty({ description: 'Total shard count' })
  shardCount!: number;

  @ApiProperty({
    description: 'Shard IDs owned by this instance',
    type: [String],
  })
  localShardIds!: string[];

  @ApiProperty({
    description: 'Owned shards with connector/market',
    type: [Object],
  })
  ownedShards!: {
    ownershipKey: string;
    connectorType: string;
    marketType: string;
    shardId: number;
  }[];

  @ApiPropertyOptional({
    description: 'Symbols per shard when available',
    type: [Object],
  })
  symbolsPerShard?: {
    connectorType: string;
    marketType: string;
    shardId: number;
    symbols: string[];
  }[];
}
