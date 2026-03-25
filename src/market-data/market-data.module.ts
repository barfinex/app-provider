import { Module } from '@nestjs/common';
import { QuestDBModule } from '../questdb/questdb.module';
import { BinanceModule } from '../connector/datasource/binance/binance.module';
import { MarketDataController } from './market-data.controller';
import { MarketDataRetentionService } from './market-data-retention.service';
import { MarketDataAggregationService } from './market-data-aggregation.service';

@Module({
  imports: [QuestDBModule, BinanceModule],
  controllers: [MarketDataController],
  providers: [MarketDataRetentionService, MarketDataAggregationService],
  exports: [MarketDataRetentionService],
})
export class MarketDataModule {}
