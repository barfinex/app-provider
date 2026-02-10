// src/inspector/inspector.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { InspectorController } from './inspector.controller';
import { InspectorService } from './inspector.service';
import { InspectorRepository } from './inspector.repository';

import { ConnectorModule } from '../connector/connector.module';
import { OrderModule } from '../order/order.module';

@Module({
    imports: [
        HttpModule,
        forwardRef(() => ConnectorModule),
        forwardRef(() => OrderModule),
    ],
    controllers: [InspectorController],
    providers: [InspectorService, InspectorRepository],
    exports: [InspectorService, InspectorRepository],
})
export class InspectorModule { }
