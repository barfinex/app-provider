import { Controller, Post, Get, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBody, ApiOkResponse } from '@nestjs/swagger';
import { BacktestService } from './backtest.service';
import { BacktestOptions } from './backtest.types';

@ApiTags('Backtest')
@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtest: BacktestService) {}

  @Post('start')
  @ApiOperation({
    summary: 'Start backtest',
    description: `
Start a backtest session. Two modes are supported:

**historical** — replays candles already stored in QuestDB, publishing each one as
PROVIDER_MARKETDATA_CANDLE to Redis so the active Detector processes them
with its real strategy pipeline. Requires \`from\`, \`to\` (Unix ms).

**synthetic** — generates Geometric Brownian Motion candles that resemble market
dynamics (random walk with configurable volatility and drift). No DB data needed.

\`speed\` controls the playback rate: 1 = real-time based on candle timestamps,
100 = 100× faster, 0 = instant (fire-and-forget with 1ms gap).
        `.trim(),
  })
  @ApiBody({ description: 'BacktestOptions', type: Object })
  @ApiOkResponse({ description: 'Backtest start result' })
  start(@Body() options: BacktestOptions) {
    return this.backtest.startBacktest(options);
  }

  @Post('stop')
  @ApiOperation({
    summary: 'Stop backtest',
    description:
      'Stops the currently running backtest session and returns the final status.',
  })
  @ApiOkResponse({ description: 'Backtest status after stop' })
  stop() {
    return this.backtest.stopBacktest();
  }

  @Get('status')
  @ApiOperation({
    summary: 'Get backtest status',
    description:
      'Returns current backtest session status: running, progress, mode, speed.',
  })
  @ApiOkResponse({ description: 'BacktestStatus' })
  status() {
    return this.backtest.getStatus();
  }
}
