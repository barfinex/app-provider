import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@barfinex/config';

import { SymbolRepository } from '../../../symbol/symbol.repository';
import { WebSocketService } from '../websocket.service';

import { BinanceService } from './binance.service';

// core
import { BinanceClientService } from './core/binance.client';
import { BinanceRedisService } from './core/binance.redis';

// api layers
import { BinanceAccountApi } from './api/binance.account.api';
import { BinanceMarketApi } from './api/binance.market.api';
import { BinanceOrderApi } from './api/binance.order.api';

// ws
import { BinanceWsManager } from './ws/binance.ws.manager';
import { BinanceSubscriptionService } from './ws/binance.subscription.service';

// 🔥 Candle
import { CandleModule } from '../../../candle/candle.module';

// 🔥 SymbolRepository deps
import { QuestDBModule } from '../../../questdb/questdb.module';
import { QuestDbIlpModule } from '../../../questdb/ilp/questdb-ilp.module';
import { EventSinkModule } from '../../../questdb/event-sink/event-sink.module';
import { ProviderMarketdataMetricsService } from '../../../runtime/provider-marketdata-metrics.service';

@Module({
    imports: [
        // ✅ даёт ConfigService
        ConfigModule,

        // CandleService
        forwardRef(() => CandleModule),

        // SymbolRepository deps
        QuestDBModule,
        QuestDbIlpModule,
        forwardRef(() => EventSinkModule),
    ],

    providers: [
        // CORE
        BinanceClientService,
        BinanceRedisService,

        // API
        BinanceAccountApi,
        BinanceMarketApi,
        BinanceOrderApi,

        // WS
        BinanceWsManager,
        BinanceSubscriptionService,
        ProviderMarketdataMetricsService,

        // FACADE
        BinanceService,

        // EXTERNAL
        WebSocketService,
        SymbolRepository,
    ],

    exports: [
        BinanceService,
        BinanceClientService,
        BinanceRedisService,
        BinanceWsManager,
    ],
})
export class BinanceModule { }
