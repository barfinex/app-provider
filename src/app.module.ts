import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { ConfigModule as CustomConfigModule } from '@barfinex/config';

import { CandleModule } from './candle/candle.module';
import { AccountModule } from './account/account.module';
import { OrderModule } from './order/order.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { ConnectorModule } from './connector/connector.module';
import { DetectorModule } from './detector/detector.module';
import { AssetModule } from './asset/asset.module';
import { SymbolModule } from './symbol/symbol.module';
import { PortainerModule } from './portainer/portainer.module';

import { ProviderWsBridgeModule } from '@barfinex/provider-ws-bridge';
import { SubscriptionType } from '@barfinex/types';

import { AppController } from './app.controller';
import { WsHealthGateway } from './ws-health.gateway';

// ⭐ Core modules
import { QuestDBModule } from './questdb/questdb.module';
import { EventSinkModule } from './questdb/event-sink/event-sink.module';
import { OrderBookSamplingModule } from './questdb/orderbook-sampling/orderbook-sampling.module';

import { ReplayModule } from './replay/replay.module';
import { EventEmitterModule } from '@nestjs/event-emitter';

@Module({
  imports: [
    CustomConfigModule,
    NestConfigModule.forRoot({
      envFilePath:
        process.env.NODE_ENV === 'production'
          ? '.env.production'
          : '.env.local',
      isGlobal: true,
    }),
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      maxListeners: 20,
    }),

    // ⭐ 1. Infra for analytics — must be global
    EventSinkModule,

    // ⭐ 2. QuestDB engine
    QuestDBModule,

    // ⭐ 3. Sampling service (needs access to EventSinkRepository → must be imported here)
    OrderBookSamplingModule,

    // External I/O modules
    ProviderWsBridgeModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
      },
      subscriptions: (Object.values(SubscriptionType) as (string | number)[])
        .filter((v): v is string => typeof v === 'string'),
      parseJson: true,
      log: true,
    }),

    // Business modules
    CandleModule,
    PortainerModule,
    DetectorModule,
    AccountModule,
    AssetModule,
    SymbolModule,
    OrderModule,
    ConnectorModule,
    SubscriptionModule,
    ReplayModule,
  ],

  controllers: [AppController],
  providers: [WsHealthGateway],
})
export class AppModule { }
