import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Market quality report for a symbol: health score, orderbook, trades, candles. */
export class MarketQualityDto {
  @ApiProperty({ description: 'Trading symbol', example: 'BTCUSDT' })
  symbol!: string;

  @ApiProperty({ description: 'Health score (0–100)', example: 85 })
  healthScore!: number;

  @ApiProperty({ description: 'Whether the report is valid' })
  valid!: boolean;

  @ApiProperty({ description: 'Whether critical issues were found' })
  critical!: boolean;

  @ApiPropertyOptional({ description: 'Per-component statuses' })
  componentStatuses?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Reasons for score/report' })
  reasons?: string[];

  @ApiPropertyOptional({ description: 'Report generation timestamp' })
  checkedAt?: number;

  @ApiPropertyOptional({ description: 'Best bid price' })
  bestBid?: number;

  @ApiPropertyOptional({ description: 'Best ask price' })
  bestAsk?: number;

  @ApiPropertyOptional({ description: 'Mid price' })
  mid?: number;

  @ApiPropertyOptional({ description: 'Spread' })
  spread?: number;

  @ApiPropertyOptional({ description: 'Spread in percent' })
  spreadPct?: number;

  @ApiPropertyOptional({ description: 'Orderbook depth' })
  orderbookDepth?: number;

  @ApiPropertyOptional({ description: 'Trade count in window' })
  tradeCount?: number;

  @ApiPropertyOptional({ description: 'Buy volume' })
  buyVolume?: number;

  @ApiPropertyOptional({ description: 'Sell volume' })
  sellVolume?: number;

  @ApiPropertyOptional({ description: 'VWAP' })
  vwap?: number;

  @ApiPropertyOptional({ description: 'Average trade size' })
  avgTradeSize?: number;

  @ApiPropertyOptional({ description: 'Max trade size' })
  maxTradeSize?: number;

  @ApiPropertyOptional({ description: 'Candles count H1' })
  candlesCountH1?: number;

  @ApiPropertyOptional({ description: 'Candles count H4' })
  candlesCountH4?: number;

  @ApiPropertyOptional({ description: 'Candles count D1' })
  candlesCountD1?: number;
}
