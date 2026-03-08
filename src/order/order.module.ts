// src/order/order.module.ts

import { Module, forwardRef } from '@nestjs/common';

import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { OrderRepository } from './order.repository';
import { OrderIdempotencyService } from './order-idempotency.service';

import { OrderEventAdapter } from '../questdb/event-sink/adapters/order.adapter';

// 🔁 cyclic dependencies
import { ConnectorModule } from '../connector/connector.module';
import { DetectorModule } from '../detector/detector.module';

// 🧱 infra
import { QuestDBModule } from '../questdb/questdb.module';
import { EventSinkModule } from '../questdb/event-sink/event-sink.module';

@Module({
    imports: [
        // 🔁 cycles
        forwardRef(() => ConnectorModule),
        forwardRef(() => DetectorModule),

        // 🧱 infra
        QuestDBModule,
        EventSinkModule,
    ],

    controllers: [
        OrderController,
    ],

    providers: [
        OrderService,
        OrderIdempotencyService,
        OrderRepository,
        OrderEventAdapter,
    ],

    exports: [
        OrderService,
        OrderRepository,
    ],
})
export class OrderModule { }
