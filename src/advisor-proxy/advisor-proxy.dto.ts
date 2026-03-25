import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── Strategy Governance ──

export class ManualOverrideRequestDto {
  @ApiProperty({ description: 'Strategy ID to override' })
  strategyId: string;

  @ApiProperty({
    description: 'Override action',
    enum: ['promote', 'suppress', 'archive', 'restore'],
  })
  action: string;

  @ApiPropertyOptional({ description: 'Reason for the override' })
  reason?: string;

  @ApiPropertyOptional({ description: 'Trading pair symbol' })
  symbol?: string;

  @ApiPropertyOptional({ description: 'Experiment tag filter' })
  experimentTag?: string;
}

export class ClearManualOverrideRequestDto {
  @ApiProperty({ description: 'Strategy ID to clear override for' })
  strategyId: string;

  @ApiPropertyOptional({ description: 'Reason for clearing the override' })
  reason?: string;

  @ApiPropertyOptional({ description: 'Trading pair symbol' })
  symbol?: string;

  @ApiPropertyOptional({ description: 'Experiment tag filter' })
  experimentTag?: string;
}

// ── Strategy Synthesis ──

export class StrategySynthesisRequestDto {
  @ApiPropertyOptional({ description: 'Target symbol for the strategy' })
  symbol?: string;

  @ApiPropertyOptional({
    description: 'Experiment tag for the synthesized strategy',
  })
  experimentTag?: string;

  @ApiPropertyOptional({
    description: 'Number of strategies to synthesize',
    type: Number,
  })
  count?: number;
}

// ── Detector risk ──

export class ClosePositionRequestDto {
  @ApiProperty({ description: 'Trading pair symbol (e.g. BTCUSDT)' })
  symbol: string;

  @ApiProperty({
    description: 'Connector type',
    enum: ['binance', 'alpaca', 'tinkoff', 'dex', 'testnetBinanceFutures'],
  })
  connectorType: string;

  @ApiProperty({
    description: 'Market type',
    enum: ['spot', 'futures', 'margin'],
  })
  marketType: string;

  @ApiPropertyOptional({ description: 'Trade side', enum: ['LONG', 'SHORT'] })
  side?: string;

  @ApiPropertyOptional({ description: 'Quantity to close', type: Number })
  quantity?: number;

  @ApiProperty({ description: 'Reason for closing the position' })
  reason: string;
}

// ── Inspector ──

export class InspectorOptionsDto {
  @ApiProperty({ description: 'Inspector options object' })
  options: Record<string, unknown>;
}

export class SystemStanddownDto {
  @ApiPropertyOptional({
    description: 'Enable or disable system standdown',
    type: Boolean,
  })
  enabled?: boolean;
}
