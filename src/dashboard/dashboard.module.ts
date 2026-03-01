import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { AccountModule } from '../account/account.module';
import { ConnectorModule } from '../connector/connector.module';
import { DetectorModule } from '../detector/detector.module';
import { InspectorModule } from '../inspector/inspector.module';
import { AppRegistryModule } from '../app-registry/app-registry.module';
import { EventSinkModule } from '../questdb/event-sink/event-sink.module';
import { WsEventsModule } from '../ws-events/ws-events.module';

@Module({
  imports: [
    AccountModule,
    ConnectorModule,
    DetectorModule,
    InspectorModule,
    AppRegistryModule,
    EventSinkModule,
    WsEventsModule,
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
