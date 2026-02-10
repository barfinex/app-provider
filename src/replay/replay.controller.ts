import { Controller, Post, Body } from '@nestjs/common';
import { ReplayService } from './replay.service';
import { ReplayOptions } from './replay.types';

@Controller('replay')
export class ReplayController {
    constructor(private readonly replay: ReplayService) {}

    @Post('start')
    start(@Body() options: ReplayOptions) {
        return this.replay.startReplay(options);
    }

    @Post('stop')
    stop() {
        return this.replay.stopReplay();
    }
}
