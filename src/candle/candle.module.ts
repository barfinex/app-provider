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

import { RequestFactoryService } from './providers/request-factory.service';
import { CandleWarmupGateService } from './warmup/candle-warmup-gate.service';
import { ConsoleWarmupProgressService } from './warmup/console-warmup-progress.service';
import { DetectorHistoryService } from './detector/detector-history.service';
import { CandleRepairService } from './repair/candle-repair.service';
import { CandleRepairRunner } from './repair/candle-repair.runner';
import { CandleIntegrityService } from './debug/candle-integrity.service';
import { CandleDebugJobStore } from './debug/candle-debug-job.store';
import { CandleRepairJobOrchestrator } from './debug/candle-repair-job.orchestrator';
import { CandleVerifyJobOrchestrator } from './debug/candle-verify-job.orchestrator';
import { CandleDebugDashboardService } from './debug/candle-debug-dashboard.service';
import { IntegrityAutoscanService } from './debug/integrity-autoscan.service';
import { IntegrityAlertService } from './debug/integrity-alert.service';
import { CandleDebugWatchdogService } from './debug/candle-debug-watchdog.service';
import { CandleIngestionHealthService } from './debug/candle-ingestion-health.service';
import { CandleIntegrityIncidentStore } from './debug/candle-integrity-incident.store';
import { CandleIntegrityEventStore } from './debug/candle-integrity-event.store';
import { CandleIntegrityPersistenceService } from './debug/candle-integrity-persistence.service';
import { CandleIntegrityRecoveryPolicyService } from './debug/candle-integrity-recovery-policy.service';
import { CandleIntegrityImpactScoreService } from './debug/candle-integrity-impact-score.service';
import { CandleSelfHealingOrchestratorService } from './debug/candle-self-healing-orchestrator.service';
import { CandleDebugTimelineService } from './debug/candle-debug-timeline.service';

import { ConfigModule } from '@barfinex/config';
import { DetectorModule } from '../detector/detector.module';
import { QuestDBModule } from '../questdb/questdb.module';
import { OwnershipModule } from '../ownership/ownership.module';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => DetectorModule),
    QuestDBModule, // обязательно: CandleQuery / Writer
    OwnershipModule,
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

    // Providers
    RequestFactoryService,
    CandleWarmupGateService,
    ConsoleWarmupProgressService,

    // Detector orchestration
    DetectorHistoryService,

    // Dataset integrity / repair
    CandleRepairService,
    CandleRepairRunner,
    CandleIntegrityService,
    CandleDebugJobStore,
    CandleRepairJobOrchestrator,
    CandleVerifyJobOrchestrator,
    CandleDebugDashboardService,
    IntegrityAutoscanService,
    IntegrityAlertService,
    CandleDebugWatchdogService,
    CandleIngestionHealthService,
    CandleIntegrityPersistenceService,
    CandleIntegrityIncidentStore,
    CandleIntegrityEventStore,
    CandleIntegrityRecoveryPolicyService,
    CandleIntegrityImpactScoreService,
    CandleSelfHealingOrchestratorService,
    CandleDebugTimelineService,

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
export class CandleModule {}
