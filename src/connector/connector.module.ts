import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { ConnectorController } from './connector.controller';
import { ConnectorService } from './connector.service';

import { ConnectorEntity } from './connector.entity';
import { DetectorEntity } from '../detector/detector.entity';
import { SymbolEntity } from '../symbol/symbol.entity';

import { DetectorModule } from '../detector/detector.module';
import { CandleModule } from '../candle/candle.module'; // ⬅️ ДОБАВЛЕНО

import { BinanceService, TinkoffService, AlpacaService, TestnetBinanceFuturesService, TestnetBinanceSpotService } from './datasource';
import { WebSocketService } from './datasource/websocket.service';
import { AccountService } from '../account/account.service';

import { ConfigModule } from '@barfinex/config';
import { KeyModule } from '@barfinex/key';

@Module({
  imports: [
    ConfigModule,
    EventEmitterModule.forRoot(),
    TypeOrmModule.forFeature([ConnectorEntity, DetectorEntity, SymbolEntity]),
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
    forwardRef(() => DetectorModule),
    forwardRef(() => CandleModule), // ⬅️ ДОБАВЛЕНО: даёт CandleService в контексте
    KeyModule,
  ],
  controllers: [ConnectorController],
  providers: [
    ConnectorService,
    AccountService,
    WebSocketService,
    BinanceService,
    AlpacaService,
    TinkoffService,
    TestnetBinanceFuturesService,
    TestnetBinanceSpotService,
  ],
  // Если где-то снаружи инжектится BinanceService/др. источники — экспортни их:
  exports: [ConnectorService, BinanceService, AlpacaService, TinkoffService, TestnetBinanceFuturesService, TestnetBinanceSpotService],
})
export class ConnectorModule { }
