import { Module, forwardRef } from '@nestjs/common';
import { AppRegistryController } from './app-registry.controller';
import { AppRegistryService } from './app-registry.service';
import { AppRegistryRepository } from './app-registry.repository';
import { QuestDBModule } from '../questdb/questdb.module';
import { DetectorModule } from '../detector/detector.module';
import { InspectorModule } from '../inspector/inspector.module';
import { ConnectorModule } from '../connector/connector.module';

@Module({
  imports: [
    QuestDBModule,
    forwardRef(() => DetectorModule),
    forwardRef(() => InspectorModule),
    forwardRef(() => ConnectorModule),
  ],
  controllers: [AppRegistryController],
  providers: [AppRegistryService, AppRegistryRepository],
  exports: [AppRegistryService, AppRegistryRepository],
})
export class AppRegistryModule {}
