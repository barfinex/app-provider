import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Single OHLCV candlestick. Data is retrieved from QuestDB time-series storage.
 * Used by detectors, indicators, analytics, and strategy engines.
 */
export class CandleDto {
  @ApiProperty({
    description: 'Candle open timestamp (ms)',
    example: 1704067200000,
  })
  ts!: number;

  @ApiProperty({ description: 'Open price', example: 43250.5 })
  open!: number;

  @ApiProperty({ description: 'High price', example: 43500.0 })
  high!: number;

  @ApiProperty({ description: 'Low price', example: 43100.0 })
  low!: number;

  @ApiProperty({ description: 'Close price', example: 43420.0 })
  close!: number;

  @ApiProperty({ description: 'Volume in base asset', example: 1250.5 })
  volume!: number;
}
