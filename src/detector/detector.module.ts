// src/detector/detector.module.ts

import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { DetectorService } from './detector.service';
import { DetectorController } from './detector.controller';

import { DetectorRepository } from './detector.repository';

// Needed for data dependencies
import { QuestDBModule } from '../questdb/questdb.module';
import { EventSinkModule } from '../questdb/event-sink/event-sink.module';

// App modules
import { ConnectorModule } from '../connector/connector.module';
import { OrderModule } from '../order/order.module';
import { AppRegistryModule } from '../app-registry/app-registry.module';

@Module({
    imports: [
        HttpModule,

        // ⭐ MUST BE IMPORTED ⭐
        QuestDBModule,                  // → даёт QuestDBQueryService
        forwardRef(() => EventSinkModule), // → даёт EventSinkRepository

        // App architecture
        forwardRef(() => ConnectorModule),
        forwardRef(() => OrderModule),
        forwardRef(() => AppRegistryModule), // для статуса offline, если детектор не шлёт чеки
    ],

    controllers: [
        DetectorController,
    ],

    providers: [
        DetectorService,
        DetectorRepository,
    ],

    exports: [
        DetectorService,
        DetectorRepository,
    ],
})
export class DetectorModule { }
