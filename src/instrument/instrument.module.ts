import { Module, forwardRef } from '@nestjs/common';

import { InstrumentService } from './instrument.service';
import { InstrumentController } from './instrument.controller';

import { InstrumentRepository } from './instrument.repository';
import { InstrumentEventAdapter } from '../questdb/event-sink/adapters/instrument.adapter';

import { ConnectorModule } from '../connector/connector.module';
import { QuestDBModule } from '../questdb/questdb.module';
import { EventSinkModule } from '../questdb/event-sink/event-sink.module';

// ✅ Импортируем ILP-модуль
import { QuestDbIlpModule } from '../questdb/ilp/questdb-ilp.module';

@Module({
  imports: [
    ConnectorModule,

    // ОБЯЗАТЕЛЬНЫЕ МОДУЛИ
    QuestDBModule, // → QuestDBQueryService
    forwardRef(() => EventSinkModule), // → EventSinkRepository

    // 🔥 ДОБАВЛЕНО: ILP Writer (QuestDbIlpWriterService)
    QuestDbIlpModule,
  ],

  controllers: [InstrumentController],

  providers: [InstrumentService, InstrumentRepository, InstrumentEventAdapter],

  exports: [InstrumentService, InstrumentRepository],
})
export class InstrumentModule {}
