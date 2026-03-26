import { Module, forwardRef } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EventBusClientProxyCompat, EventBusModule } from '@barfinex/event-bus';

import { ConnectorController } from './connector.controller';
import { ConnectorService } from './connector.service';

import { ConnectorReadService } from './connector.read.service';
import { ConnectorTradeService } from './connector.trade.service';
import { ConnectorSubscriptionService } from './connector.subscription.service';
import { ConnectorLifecycle } from './connector.lifecycle';
import { ConnectorBuilder } from './connector.builder';

import { DetectorModule } from '../detector/detector.module';
import { CandleModule } from '../candle/candle.module';
import { AccountModule } from '../account/account.module';

import { ConfigModule } from '@barfinex/config';
import { KeyModule } from '@barfinex/key';

import { InstrumentRepository } from '../instrument/instrument.repository';

import { QuestDBModule } from '../questdb/questdb.module';
import { EventSinkModule } from '../questdb/event-sink/event-sink.module';
import { QuestDbIlpModule } from '../questdb/ilp/questdb-ilp.module';

import { ExchangeDataModule } from './datasource/exchange/exchange-data.module';
import { ExchangeManagerModule } from './exchange-manager/exchange-manager.module';
import { OwnershipModule } from '../ownership/ownership.module';

@Module({
  imports: [
    ConfigModule,
    KeyModule,
    OwnershipModule,
    // EventEmitterModule.forRoot(),

    EventBusModule.forRoot({
      loggerContext: 'ProviderEventBus',
    }),

    forwardRef(() => AccountModule),
    forwardRef(() => DetectorModule),
    forwardRef(() => CandleModule),

    // QuestDB stack
    QuestDBModule,
    QuestDbIlpModule,
    EventSinkModule,

    // Datasources
    forwardRef(() => ExchangeDataModule),

    // Exchange management (catalog, activate/deactivate, credentials)
    ExchangeManagerModule,
  ],

  controllers: [ConnectorController],

  providers: [
    {
      provide: 'PROVIDER_SERVICE',
      useExisting: EventBusClientProxyCompat,
    },
    // Facade
    ConnectorService,

    // Logic
    ConnectorReadService,
    ConnectorTradeService,
    ConnectorSubscriptionService,
    ConnectorLifecycle,
    ConnectorBuilder,

    // Repositories (ТОЛЬКО свои)
    InstrumentRepository,
  ],

  exports: [
    ConnectorService,
    ConnectorReadService,
    ConnectorTradeService,
    ConnectorSubscriptionService,
    // ConnectorLifecycle,
    ConnectorBuilder,
    ExchangeManagerModule,
  ],
})
export class ConnectorModule {}
