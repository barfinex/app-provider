// src/inspector/inspector.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { InspectorController } from './inspector.controller';
import { InspectorService } from './inspector.service';
import { InspectorRepository } from './inspector.repository';

import { AppRegistryModule } from '../app-registry/app-registry.module';
import { ConnectorModule } from '../connector/connector.module';
import { OrderModule } from '../order/order.module';
import { QuestDBModule } from '../questdb/questdb.module';
import { EventSinkModule } from '../questdb/event-sink/event-sink.module';

@Module({
  imports: [
    HttpModule,
    QuestDBModule,
    forwardRef(() => AppRegistryModule),
    forwardRef(() => EventSinkModule),
    forwardRef(() => ConnectorModule),
    forwardRef(() => OrderModule),
  ],
  controllers: [InspectorController],
  providers: [InspectorService, InspectorRepository],
  exports: [InspectorService, InspectorRepository],
})
export class InspectorModule {}
