import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { ConfigModule as CustomConfigModule } from '@barfinex/config';

import { CandleModule } from './candle/candle.module';
import { AccountModule } from './account/account.module';
import { OrderModule } from './order/order.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { ConnectorModule } from './connector/connector.module';
import { BinanceModule } from './connector/datasource/binance/binance.module';
import { DetectorModule } from './detector/detector.module';
import { AssetModule } from './asset/asset.module';
import { SymbolModule } from './symbol/symbol.module';
import { PortainerModule } from './portainer/portainer.module';

import { ProviderWsBridgeModule } from '@barfinex/provider-ws-bridge';
import { resolveWsBridgeSubscriptions } from './ws-events/ws-bridge-channel-allowlist';

import { AppController } from './app.controller';
import { WsHealthGateway } from './ws-health.gateway';

// ⭐ Core modules
import { QuestDBModule } from './questdb/questdb.module';
import { EventSinkModule } from './questdb/event-sink/event-sink.module';
import { OrderBookSamplingModule } from './questdb/orderbook-sampling/orderbook-sampling.module';

import { ReplayModule } from './replay/replay.module';
import { SignalsModule } from './signals/signals.module';
import { ProxyModule } from './proxy/proxy.module';
import { AppRegistryModule } from './app-registry/app-registry.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { WsEventsModule } from './ws-events/ws-events.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ProviderApiTokenGuard } from './auth/provider-api-token.guard';
import { AdvisorProxyModule } from './advisor-proxy/advisor-proxy.module';
import { DetectorProxyModule } from './detector-proxy/detector-proxy.module';
import { InspectorProxyModule } from './inspector-proxy/inspector-proxy.module';
import { ProviderGatewayModule } from './provider-gateway/provider-gateway.module';
import { ProviderRuntimeHealthController } from './runtime/provider-runtime-health.controller';
import { ProviderMarketQualityController } from './runtime/provider-market-quality.controller';
import { ProviderRuntimeHealthService } from './runtime/provider-runtime-health.service';
import { ProviderMarketdataMetricsService } from './runtime/provider-marketdata-metrics.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
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
      subscriptions: resolveWsBridgeSubscriptions(),
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
    SignalsModule,
    AppRegistryModule,
    ProxyModule,
    AdvisorProxyModule,
    DetectorProxyModule,
    InspectorProxyModule,
    ProviderGatewayModule,
    WsEventsModule,
    DashboardModule,
    OrderModule,
    BinanceModule,
    ConnectorModule,
    SubscriptionModule,
    ReplayModule,
  ],

  controllers: [AppController, ProviderRuntimeHealthController, ProviderMarketQualityController],
  providers: [
    WsHealthGateway,
    ProviderRuntimeHealthService,
    ProviderMarketdataMetricsService,
    {
      provide: APP_GUARD,
      useClass: ProviderApiTokenGuard,
    },
  ],
})
export class AppModule { }
