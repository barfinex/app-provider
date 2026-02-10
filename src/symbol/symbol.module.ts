import { Module, forwardRef } from '@nestjs/common';

import { SymbolService } from './symbol.service';
import { SymbolController } from './symbol.controller';

import { SymbolRepository } from './symbol.repository';
import { SymbolEventAdapter } from '../questdb/event-sink/adapters/symbol.adapter';

import { ConnectorModule } from '../connector/connector.module';
import { QuestDBModule } from '../questdb/questdb.module';
import { EventSinkModule } from '../questdb/event-sink/event-sink.module';

// ✅ Импортируем ILP-модуль
import { QuestDbIlpModule } from '../questdb/ilp/questdb-ilp.module';

@Module({
    imports: [
        ConnectorModule,

        // ОБЯЗАТЕЛЬНЫЕ МОДУЛИ
        QuestDBModule,                    // → QuestDBQueryService
        forwardRef(() => EventSinkModule), // → EventSinkRepository

        // 🔥 ДОБАВЛЕНО: ILP Writer (QuestDbIlpWriterService)
        QuestDbIlpModule,
    ],

    controllers: [SymbolController],

    providers: [
        SymbolService,
        SymbolRepository,
        SymbolEventAdapter,
    ],

    exports: [
        SymbolService,
        SymbolRepository,
    ],
})
export class SymbolModule { }
