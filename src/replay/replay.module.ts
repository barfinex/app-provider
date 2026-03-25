import { Module, forwardRef } from '@nestjs/common';

import { ReplayService } from './replay.service';
import { ReplayController } from './replay.controller';

import { QuestDBModule } from '../questdb/questdb.module';
import { EventSinkModule } from '../questdb/event-sink/event-sink.module';

@Module({
  imports: [
    QuestDBModule, // даёт QuestDBQueryService
    forwardRef(() => EventSinkModule), // даёт EventSinkRepository
  ],

  providers: [ReplayService],

  controllers: [ReplayController],

  exports: [ReplayService],
})
export class ReplayModule {}
