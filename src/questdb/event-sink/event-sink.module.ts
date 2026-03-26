import { Module, forwardRef } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { EventSinkRepository } from './event-sink.repository';
import { EventSinkInterceptor } from './event-sink.interceptor';
import { EventSinkController } from './event-sink.controller';

// adapters
import { CandleEventAdapter } from './adapters/candle.adapter';
import { ConnectorEventAdapter } from './adapters/connector.adapter';
import { DetectorEventAdapter } from './adapters/detector.adapter';
import { InspectorEventAdapter } from './adapters/inspector.adapter';
import { OrderEventAdapter } from './adapters/order.adapter';
import { OrderBookEventAdapter } from './adapters/orderbook.adapter';
import { InstrumentEventAdapter } from './adapters/instrument.adapter';
import { TradeEventAdapter } from './adapters/trade.adapter';

// QuestDB integration
import { QuestDBModule } from '../questdb.module';

@Module({
  imports: [
    forwardRef(() => QuestDBModule), // ← фикс цикла
  ],

  controllers: [EventSinkController],

  providers: [
    EventSinkRepository,

    {
      provide: APP_INTERCEPTOR,
      useClass: EventSinkInterceptor,
    },

    // adapters
    CandleEventAdapter,
    ConnectorEventAdapter,
    DetectorEventAdapter,
    InspectorEventAdapter,
    OrderEventAdapter,
    OrderBookEventAdapter,
    InstrumentEventAdapter,
    TradeEventAdapter,
  ],

  exports: [
    EventSinkRepository,

    CandleEventAdapter,
    ConnectorEventAdapter,
    DetectorEventAdapter,
    InspectorEventAdapter,
    OrderEventAdapter,
    OrderBookEventAdapter,
    InstrumentEventAdapter,
    TradeEventAdapter,
  ],
})
export class EventSinkModule {}
