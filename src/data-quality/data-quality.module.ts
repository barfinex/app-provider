import { Module } from '@nestjs/common';
import { QuestDBModule } from '../questdb/questdb.module';
import { BinanceModule } from '../connector/datasource/binance/binance.module';
import { AdvisorProxyModule } from '../advisor-proxy/advisor-proxy.module';
import { DataQualityController } from './data-quality.controller';
import { DataQualityService } from './data-quality.service';

@Module({
  imports: [QuestDBModule, BinanceModule, AdvisorProxyModule],
  controllers: [DataQualityController],
  providers: [DataQualityService],
  exports: [DataQualityService],
})
export class DataQualityModule {}
