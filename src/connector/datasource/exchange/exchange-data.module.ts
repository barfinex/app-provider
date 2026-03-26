import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@barfinex/config';
import {
  ExchangeBinanceModule,
  BinanceClientService,
  BinanceAccountApi,
  BinanceMarketApi,
  BinanceOrderApi,
  BinanceWsManager,
} from '@barfinex/exchange-binance';

import { InstrumentRepository } from '../../../instrument/instrument.repository';

import { ExchangeDataService } from './exchange-data.service';

// core
import { ExchangeRedisService } from './core/exchange-redis.service';

// ws
import { ExchangeSubscriptionService } from './ws/exchange-subscription.service';

// 🔥 Candle
import { CandleModule } from '../../../candle/candle.module';

// 🔥 InstrumentRepository deps
import { QuestDBModule } from '../../../questdb/questdb.module';
import { QuestDbIlpModule } from '../../../questdb/ilp/questdb-ilp.module';
import { EventSinkModule } from '../../../questdb/event-sink/event-sink.module';
import { ProviderMarketdataMetricsService } from '../../../runtime/provider-marketdata-metrics.service';
import { HorizontalVolumeProfileService } from './horizontal-volume-profile.service';
import { LiquidityMapService } from './liquidity-map.service';
import { OwnershipModule } from '../../../ownership/ownership.module';
import { DiagnosticsModule } from '../../../diagnostics/diagnostics.module';

@Module({
  imports: [
    // ✅ даёт ConfigService
    ConfigModule,

    DiagnosticsModule,

    // Exchange Binance (provides BinanceClientService, BinanceAccountApi, BinanceMarketApi, BinanceOrderApi, BinanceWsManager)
    ExchangeBinanceModule,

    // CandleService
    forwardRef(() => CandleModule),

    // InstrumentRepository deps
    QuestDBModule,
    QuestDbIlpModule,
    forwardRef(() => EventSinkModule),

    // Ownership for fencing checks in ingestion handlers
    OwnershipModule,
  ],

  providers: [
    // CORE
    ExchangeRedisService,

    // WS
    ExchangeSubscriptionService,
    ProviderMarketdataMetricsService,
    HorizontalVolumeProfileService,
    LiquidityMapService,

    // FACADE
    ExchangeDataService,

    // EXTERNAL
    InstrumentRepository,
  ],

  exports: [
    ExchangeDataService,
    BinanceClientService,
    ExchangeRedisService,
    BinanceWsManager,
  ],
})
export class ExchangeDataModule {}
