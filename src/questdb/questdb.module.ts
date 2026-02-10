import { Module, forwardRef } from '@nestjs/common';

import { QuestDBWriteService } from './questdb-write.service';
import { QuestDBQueryService } from './questdb-query.service';
import { QuestDBDDLService } from './questdb-ddl.service';

// repositories
import { CandleRepository } from './repositories/candle.repository';
import { TradeRepository } from './repositories/trade.repository';
import { OrderRepository } from './repositories/order.repository';
import { OrderBookRepository } from './repositories/orderbook.repository';
import { SymbolRepository } from './repositories/symbol.repository';
import { ConnectorRepository } from './repositories/connector.repository';
import { DetectorRepository } from './repositories/detector.repository';
import { InspectorRepository } from './repositories/inspector.repository';

import { OrderBookSamplingModule } from './orderbook-sampling/orderbook-sampling.module';
import { EventSinkModule } from './event-sink/event-sink.module';

@Module({
    imports: [
        OrderBookSamplingModule,

        forwardRef(() => EventSinkModule), // ← фикс цикла
    ],

    providers: [
        QuestDBWriteService,
        QuestDBQueryService,
        QuestDBDDLService,

        CandleRepository,
        TradeRepository,
        OrderRepository,
        OrderBookRepository,
        SymbolRepository,
        ConnectorRepository,
        DetectorRepository,
        InspectorRepository,
    ],

    exports: [
        QuestDBWriteService,
        QuestDBQueryService,

        CandleRepository,
        TradeRepository,
        OrderRepository,
        OrderBookRepository,
        SymbolRepository,
        ConnectorRepository,
        DetectorRepository,
        InspectorRepository,

        OrderBookSamplingModule,
    ],
})
export class QuestDBModule { }
