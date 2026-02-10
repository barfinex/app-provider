// src/asset/asset.module.ts
import { Module, forwardRef } from '@nestjs/common';

import { AssetService } from './asset.service';
import { AssetController } from './asset.controller';

import { ConnectorModule } from '../connector/connector.module';
import { AccountModule } from '../account/account.module';
import { OrderModule } from '../order/order.module';
import { DetectorModule } from '../detector/detector.module';

@Module({
    imports: [
        forwardRef(() => ConnectorModule),
        forwardRef(() => AccountModule),
        forwardRef(() => OrderModule),
        forwardRef(() => DetectorModule),
    ],
    controllers: [AssetController],
    providers: [AssetService],
    exports: [AssetService],
})
export class AssetModule { }
