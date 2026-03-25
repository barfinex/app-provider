import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Candle integrity incident status. */
export class CandleIntegrityIncidentDto {
  @ApiProperty({ description: 'Incident ID' })
  id!: string;

  @ApiProperty({
    description: 'Status',
    enum: [
      'OPEN',
      'AUTO_REPAIR_RUNNING',
      'AUTO_REPAIR_FAILED',
      'RESOLVED',
      'ESCALATED',
      'IGNORED',
    ],
  })
  status!: string;

  @ApiPropertyOptional({
    description: 'Severity',
    enum: ['INFO', 'WARN', 'CRITICAL'],
  })
  severity?: string;

  @ApiPropertyOptional({
    description: 'Category',
    enum: ['STRUCTURAL', 'OPERATIONAL', 'INGESTION'],
  })
  category?: string;

  @ApiPropertyOptional({
    description: 'Type',
    enum: [
      'DUPLICATES',
      'SEAM_ISSUE',
      'OUT_OF_ORDER',
      'GAPS',
      'STALE_SERIES',
      'CONNECTOR_STALL',
      'MIXED',
    ],
  })
  type?: string;

  @ApiPropertyOptional({ description: 'Symbol' })
  symbol?: string;

  @ApiPropertyOptional({ description: 'Connector type' })
  connectorType?: string;

  @ApiPropertyOptional({ description: 'Market type' })
  marketType?: string;

  @ApiPropertyOptional({ description: 'Interval' })
  interval?: string;

  @ApiPropertyOptional({ description: 'Created at' })
  createdAt?: number;

  @ApiPropertyOptional({ description: 'Updated at' })
  updatedAt?: number;
}

/** Candle repair request body. */
export class CandleRepairRequestDto {
  @ApiProperty({
    description: 'Repair mode: dry-run (report only) or apply (perform repair)',
    enum: ['dry-run', 'apply'],
  })
  mode!: 'dry-run' | 'apply';

  @ApiPropertyOptional({
    description:
      'Optional series filter. If omitted, all series are considered.',
    type: 'object',
    properties: {
      connectorType: { type: 'string', example: 'BINANCE' },
      marketType: { type: 'string', example: 'SPOT' },
      symbol: { type: 'string', example: 'BTCUSDT' },
      interval: { type: 'string', example: '1m' },
    },
  })
  series?: {
    connectorType: string;
    marketType: string;
    symbol: string;
    interval: string;
  };
}

/** Debug job status (repair or verify). */
export class CandleDebugJobStatusDto {
  @ApiProperty({ description: 'Job ID' })
  jobId!: string;

  @ApiProperty({ description: 'Job type', enum: ['repair', 'verify'] })
  type!: string;

  @ApiProperty({
    description: 'Status',
    enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
  })
  status!: string;

  @ApiPropertyOptional({ description: 'Progress percentage' })
  progressPercent?: number;

  @ApiPropertyOptional({ description: 'Created at' })
  createdAt?: number;

  @ApiPropertyOptional({ description: 'Updated at' })
  updatedAt?: number;
}

/** Integrity report summary for a series. */
export class CandleIntegrityReportDto {
  @ApiProperty({ description: 'Connector type' })
  connectorType!: string;

  @ApiProperty({ description: 'Market type' })
  marketType!: string;

  @ApiProperty({ description: 'Symbol' })
  symbol!: string;

  @ApiProperty({ description: 'Interval' })
  interval!: string;

  @ApiProperty({ description: 'Duplicate row count' })
  duplicateRows!: number;

  @ApiProperty({ description: 'Gap count' })
  gapCount!: number;

  @ApiProperty({ description: 'Out-of-order count' })
  outOfOrderCount!: number;

  @ApiPropertyOptional({ description: 'Missing time ranges' })
  missingRanges?: { from: number; to: number }[];

  @ApiPropertyOptional({ description: 'Total rows' })
  totalRows?: number;

  @ApiPropertyOptional({ description: 'Start timestamp' })
  startTimestamp?: number | null;

  @ApiPropertyOptional({ description: 'End timestamp' })
  endTimestamp?: number | null;
}
