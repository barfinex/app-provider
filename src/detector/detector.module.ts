import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';

import { DetectorController } from './detector.controller';
import { DetectorEntity } from './detector.entity';
import { DetectorService } from './detector.service';

import { ConnectorModule } from '../connector/connector.module';
import { OrderModule } from '../order/order.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([DetectorEntity]), // ✅ только свои репозитории
        forwardRef(() => ConnectorModule),          // ✅ если нужен ConnectorService/BinanceService
        forwardRef(() => OrderModule),              // ✅ если нужен OrderService
        HttpModule,
    ],
    controllers: [DetectorController],
    providers: [DetectorService],
    exports: [DetectorService],                   // ✅ отдаём сервис наружу
})
export class DetectorModule { }
