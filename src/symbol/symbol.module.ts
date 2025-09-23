import { Module } from '@nestjs/common';
import { SymbolService } from './symbol.service';
import { SymbolController } from './symbol.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
// import { OrderEntity } from '../order/order.entity';
// import { DetectorEntity } from '../detector/detector.entity';
// import { ConfigModule as NestConfigModule } from '@nestjs/config';
// import { ConfigModule as CustomConfigModule } from '@barfinex/config';
// import { ConnectorEntity } from '../connector/connector.entity';
import { ConnectorModule } from '../connector/connector.module';
// import { AccountModule } from '../account/account.module';
import { SymbolEntity } from './symbol.entity';

@Module({
    imports: [
        // CustomConfigModule,
        // NestConfigModule.forRoot(),
        TypeOrmModule.forFeature([SymbolEntity]),
        ConnectorModule,
    ],
    controllers: [SymbolController],
    providers: [SymbolService]
})
export class SymbolModule { }
