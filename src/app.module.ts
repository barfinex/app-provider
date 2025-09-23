import { Module } from '@nestjs/common';
// import { TypeOrmModule } from '@nestjs/typeorm';
// import { AppController } from './app.controller';
// import { AppService } from './app.service';
// import { ProductModule } from './product/product.module';
import { CandleModule } from './candle/candle.module';
// import { AccountModule } from './account2/account.module';
// import { ConfigModule } from '@nestjs/config';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { ConfigModule as CustomConfigModule } from '@barfinex/config';
import { TestModule } from './test/test.module';
// import { AccountService } from './account/account.service';
import { AccountModule } from './account/account.module';
import { OrderModule } from './order/order.module';
// import { OrderService } from './order/order.service';
import { SubscriptionModule } from './subscription/subscription.module';
import { ConnectorModule } from './connector/connector.module';
import { DetectorModule } from './detector/detector.module';
import { TypeOrmModule } from '@nestjs/typeorm';
// import { ClientsModule, Transport } from '@nestjs/microservices';
import { AssetModule } from './asset/asset.module';
import { SymbolModule } from './symbol/symbol.module';
import { PortainerModule } from './portainer/portainer.module';
import { AppController } from './app.controller';
import { ConnectorService } from './connector/connector.service';

import { ProviderWsBridgeModule } from '@barfinex/provider-ws-bridge';
import { SubscriptionType } from '@barfinex/types';
import { WsHealthGateway } from './ws-health.gateway';

@Module({
  imports: [
    CustomConfigModule,
    NestConfigModule.forRoot({
      envFilePath: process.env.NODE_ENV === 'production' ? '.env.production' : '.env.local',
      isGlobal: true, // Делает конфигурацию доступной во всем приложении
    }),
    TypeOrmModule.forRoot({
      type: 'mongodb',
      //url: process.env.MONGODB_URL,
      host: process.env.MONGO_HOST,
      port: Number(process.env.MONGO_PORT),
      username: process.env.MONGO_ROOT_USERNAME,
      password: process.env.MONGO_ROOT_PASSWORD,
      database: process.env.MONGO_DATABASE,
      entities: [__dirname + '/**/*.entity{.ts,.js}'],
      ssl: false,
      // useUnifiedTopology: true,
      autoLoadEntities: true,
      synchronize: true,
      // useNewUrlParser: true,
    }),

    ProviderWsBridgeModule.forRoot({
      redis: { host: process.env.REDIS_HOST || 'localhost', port: Number(process.env.REDIS_PORT || 6379) },
      subscriptions: (Object.values(SubscriptionType) as (string | number)[]).filter((v): v is string => typeof v === 'string'),
      parseJson: true,
      log: true,
    }),

    CandleModule,
    PortainerModule,
    DetectorModule,
    TestModule,
    AccountModule,
    AssetModule,
    SymbolModule,
    OrderModule,
    ConnectorModule,
    SubscriptionModule
  ],
  controllers: [AppController],
  providers: [WsHealthGateway],
})
export class AppModule { }
