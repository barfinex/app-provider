import { Module } from '@nestjs/common';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';
// import { OrderService } from '../order/order.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEntity } from '../order/order.entity';
// import { ClientsModule, Transport } from '@nestjs/microservices';
// import { ConfigModule as NestConfigModule } from '@nestjs/config';
// import { ConfigModule as CustomConfigModule } from '@barfinex/config';
import { DetectorEntity } from '../detector/detector.entity';
import { ConnectorModule } from '../connector/connector.module';

@Module({
    imports: [
        // CustomConfigModule,
        // NestConfigModule.forRoot(),
        TypeOrmModule.forFeature([OrderEntity, DetectorEntity]),
        ConnectorModule
    ],
    controllers: [AccountController],
    providers: [AccountService],
    exports: [AccountService]
})
export class AccountModule { }
