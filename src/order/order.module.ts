import { Module, forwardRef } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { OrderEntity } from './order.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DetectorEntity } from '../detector/detector.entity';
import { ConnectorEntity } from '../connector/connector.entity';
import { ConnectorModule } from '../connector/connector.module';
import { DetectorModule } from '../detector/detector.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([OrderEntity, DetectorEntity, ConnectorEntity]),
        forwardRef(() => DetectorModule),
        ConnectorModule
    ],
    controllers: [OrderController],
    providers: [OrderService],
    exports: [OrderService]
})
export class OrderModule { }
