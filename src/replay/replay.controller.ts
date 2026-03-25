import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBody, ApiOkResponse } from '@nestjs/swagger';
import { ReplayService } from './replay.service';
import { ReplayOptions } from './replay.types';

@ApiTags('Replay')
@Controller('replay')
export class ReplayController {
  constructor(private readonly replay: ReplayService) {}

  @Post('start')
  @ApiOperation({
    summary: 'Start replay',
    description:
      'Starts a replay with the given options (e.g. from/to, symbol). Used for backtesting or replaying market data.',
  })
  @ApiBody({ description: 'Replay options (ReplayOptions)' })
  @ApiOkResponse({ description: 'Replay start result' })
  start(@Body() options: ReplayOptions) {
    return this.replay.startReplay(options);
  }

  @Post('stop')
  @ApiOperation({
    summary: 'Stop replay',
    description: 'Stops the currently running replay.',
  })
  @ApiOkResponse({ description: 'Replay stop result' })
  stop() {
    return this.replay.stopReplay();
  }
}
