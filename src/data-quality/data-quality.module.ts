import { Module } from '@nestjs/common';
import { QuestDBModule } from '../questdb/questdb.module';
import { ExchangeDataModule } from '../connector/datasource/exchange/exchange-data.module';
import { AdvisorProxyModule } from '../advisor-proxy/advisor-proxy.module';
import { DataQualityController } from './data-quality.controller';
import { DataQualityService } from './data-quality.service';

@Module({
  imports: [QuestDBModule, ExchangeDataModule, AdvisorProxyModule],
  controllers: [DataQualityController],
  providers: [DataQualityService],
  exports: [DataQualityService],
})
export class DataQualityModule {}
