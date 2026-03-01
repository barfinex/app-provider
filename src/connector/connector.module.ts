import { Module, forwardRef } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { EventEmitterModule } from '@nestjs/event-emitter';

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

import { SymbolRepository } from '../symbol/symbol.repository';

import { QuestDBModule } from '../questdb/questdb.module';
import { EventSinkModule } from '../questdb/event-sink/event-sink.module';
import { QuestDbIlpModule } from '../questdb/ilp/questdb-ilp.module';

import { BinanceModule } from './datasource/binance/binance.module';

@Module({
  imports: [
    ConfigModule,
    KeyModule,
    // EventEmitterModule.forRoot(),

    ClientsModule.register([
      {
        name: 'PROVIDER_SERVICE',
        transport: Transport.REDIS,
        options: {
          host: process.env.REDIS_HOST,
          port: +(process.env.REDIS_PORT ?? 6379),
          retryAttempts: 10,
          retryDelay: 5000,
        },
      },
    ]),

    forwardRef(() => AccountModule),
    forwardRef(() => DetectorModule),
    forwardRef(() => CandleModule),

    // QuestDB stack
    QuestDBModule,
    QuestDbIlpModule,
    EventSinkModule,

    // Datasources
    forwardRef(() => BinanceModule),
  ],

  controllers: [ConnectorController],

  providers: [
    // Facade
    ConnectorService,

    // Logic
    ConnectorReadService,
    ConnectorTradeService,
    ConnectorSubscriptionService,
    ConnectorLifecycle,
    ConnectorBuilder,

    // Repositories (ТОЛЬКО свои)
    SymbolRepository,
  ],

  exports: [
    ConnectorService,
    ConnectorReadService,
    ConnectorTradeService,
    ConnectorSubscriptionService,
    // ConnectorLifecycle,
    ConnectorBuilder,
  ],
})
export class ConnectorModule { }
