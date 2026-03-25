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
import { HorizontalVolumeProfileRepository } from './repositories/horizontal-volume-profile.repository';
import { LiquidityMapRepository } from './repositories/liquidity-map.repository';
import { RawTradeRepository } from './repositories/raw-trade.repository';
import { TradeFeaturesRepository } from './repositories/trade-features.repository';
import { OrderbookTopRepository } from './repositories/orderbook-top.repository';
import { OrderbookSnapshotsRepository } from './repositories/orderbook-snapshots.repository';
import { OrderbookFeaturesRepository } from './repositories/orderbook-features.repository';

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
    HorizontalVolumeProfileRepository,
    LiquidityMapRepository,
    RawTradeRepository,
    TradeFeaturesRepository,
    OrderbookTopRepository,
    OrderbookSnapshotsRepository,
    OrderbookFeaturesRepository,
  ],

  exports: [
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
    HorizontalVolumeProfileRepository,
    LiquidityMapRepository,
    RawTradeRepository,
    TradeFeaturesRepository,
    OrderbookTopRepository,
    OrderbookSnapshotsRepository,
    OrderbookFeaturesRepository,

    OrderBookSamplingModule,
  ],
})
export class QuestDBModule {}
