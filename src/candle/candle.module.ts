import { Module, forwardRef } from '@nestjs/common';
import { CandleController } from './candle.controller';

import { CandleService } from './candle.service';
import { CandleSyncService } from './sync/candle-sync.service';
import { CandleEngineService } from './candle-engine.service';
import { CandleWriterService } from './candle-writer.service';
import { CandleCacheService } from './candle-cache.service';
import { CandleAggregatorService } from './candle-aggregator.service';
import { CandleQueryService } from './candle-query.service';

// 🔹 новые сервисы после декомпозиции
import { HistoryLoaderService } from './history/history-loader.service';
import { SymbolHistoryService } from './history/symbol-history.service';
import { HigherTFService } from './history/higher-tf.service';
import { DerivedCandleService } from './derived/derived-candle.service';

import { RequestFactoryService } from './providers/request-factory.service';
import { CandleWarmupGateService } from './warmup/candle-warmup-gate.service';
import { ConsoleWarmupProgressService } from './warmup/console-warmup-progress.service';
import { DetectorHistoryService } from './detector/detector-history.service';

import { ConfigModule } from '@barfinex/config';
import { DetectorModule } from '../detector/detector.module';
import { QuestDBModule } from '../questdb/questdb.module';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => DetectorModule),
    QuestDBModule, // обязательно: CandleQuery / Writer
  ],

  controllers: [CandleController],

  providers: [
    // Facade / orchestration
    CandleService,

    // Existing infra
    CandleEngineService,
    CandleWriterService,
    CandleCacheService,
    CandleAggregatorService,
    CandleQueryService,

    // History pipeline (НОВЫЕ)
    HistoryLoaderService,
    SymbolHistoryService,
    HigherTFService,
    DerivedCandleService,

    // Providers
    RequestFactoryService,
    CandleWarmupGateService,
    ConsoleWarmupProgressService,

    // Detector orchestration
    DetectorHistoryService,

    // Подкачка при старте и периодическое докачивание свечей
    CandleSyncService,
  ],

  exports: [
    CandleService,
    CandleQueryService,
    CandleWriterService,
    CandleSyncService,
  ],
})
export class CandleModule { }
