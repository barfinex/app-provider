import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InspectorController } from './inspector.controller';
import { InspectorEntity } from './inspector.entity';
import { InspectorService } from './inspector.service';
import { ConnectorEntity } from '../connector/connector.entity';
import { OrderEntity } from '../order/order.entity';
// import { ConfigModule as NestConfigModule } from '@nestjs/config';
// import { ConfigModule as CustomConfigModule } from '@barfinex/config';
import { ConnectorModule } from '../connector/connector.module';
import { OrderModule } from '../order/order.module';
import { HttpModule } from '@nestjs/axios';

@Module({
    imports: [
        // CustomConfigModule,
        // NestConfigModule.forRoot(),
        TypeOrmModule.forFeature([InspectorEntity, ConnectorEntity, OrderEntity]),
        forwardRef(() => ConnectorModule),
        forwardRef(() => OrderModule),
        HttpModule,
    ],
    controllers: [InspectorController],
    providers: [InspectorService],
    exports: [InspectorService]
})

export class InspectorModule { }
