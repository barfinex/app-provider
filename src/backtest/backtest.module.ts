import { Module } from '@nestjs/common';
import { BacktestService } from './backtest.service';
import { BacktestController } from './backtest.controller';
import { QuestDBModule } from '../questdb/questdb.module';

@Module({
  imports: [
    // QuestDBModule provides QuestDBQueryService for historical candle loading
    QuestDBModule,
    // EventBusService is available globally via ConnectorModule's EventBusModule.forRoot()
  ],
  providers: [BacktestService],
  controllers: [BacktestController],
  exports: [BacktestService],
})
export class BacktestModule {}
