import { Module } from '@nestjs/common';
import { AssetService } from './asset.service';
import { AssetController } from './asset.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrderEntity } from '../order/order.entity';
import { DetectorEntity } from '../detector/detector.entity';
// import { ConfigModule as NestConfigModule } from '@nestjs/config';
// import { ConfigModule as CustomConfigModule } from '@barfinex/config';
import { ConnectorEntity } from '../connector/connector.entity';
import { ConnectorModule } from '../connector/connector.module';
import { AccountModule } from '../account/account.module';

@Module({
    imports: [
        // CustomConfigModule,
        // NestConfigModule.forRoot(),
        TypeOrmModule.forFeature([OrderEntity, DetectorEntity, ConnectorEntity]),
        ConnectorModule,
        AccountModule
    ],
    controllers: [AssetController],
    providers: [AssetService]
})
export class AssetModule { }
