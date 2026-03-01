import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    ConnectorType,
    MarketType,
    Symbol,
    TimeFrame,
} from '@barfinex/types';

import { CANDLE_SUBSCRIPTIONS_UPDATED } from '../common/constants';
// import {
//     AlpacaService,
//     TinkoffService,
//     TestnetBinanceFuturesService,
// } from './datasource';
import { BinanceService } from './datasource/binance/binance.service';
import { CandleSyncService } from '../candle/sync/candle-sync.service';
import { QuestDBQueryService } from '../questdb/questdb-query.service';

@Injectable()
export class ConnectorSubscriptionService {
    private readonly logger = new Logger(ConnectorSubscriptionService.name);

    constructor(
        private readonly eventEmitter: EventEmitter2,
        private readonly binanceService: BinanceService,
        @Inject(forwardRef(() => CandleSyncService))
        private readonly candleSync: CandleSyncService,
        private readonly questDbQueryService: QuestDBQueryService,
        // private readonly alpacaService: AlpacaService,
        // private readonly tinkoffService: TinkoffService,
        // private readonly testnetBinanceFuturesService: TestnetBinanceFuturesService,
    ) { }

    // =========================================================================
    // 🔹 SUBSCRIBE
    // =========================================================================

    async subscribeCollection(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbols: Symbol[],
        intervals: TimeFrame[],
    ): Promise<any> {
        console.log('subscribeCollection');

        switch (connectorType) {
            case ConnectorType.binance:
                await this.binanceService.subscribe(
                    marketType,
                    symbols,
                    intervals,
                );
                break;

            case ConnectorType.alpaca:
                break;

            case ConnectorType.tinkoff:
                break;

            // case ConnectorType.testnetBinanceFutures:
            //     return await this.testnetBinanceFuturesService.subscribe(marketType, symbols, intervals);
            //     break;
        }
    }

    // =========================================================================
    // 🔹 UNSUBSCRIBE
    // =========================================================================

    async unsubscribeCollection(
        connectorType: ConnectorType,
    ): Promise<any> {
        switch (connectorType) {
            case ConnectorType.binance:
                await this.binanceService.unsubscribe();
                break;

            case ConnectorType.alpaca:
                break;

            case ConnectorType.tinkoff:
                break;

            // case ConnectorType.testnetBinanceFutures:
            //     return await this.testnetBinanceFuturesService.unsubscribe();
            //     break;
        }
    }

    // =========================================================================
    // 🔹 UPDATE SUBSCRIPTIONS
    // =========================================================================

    async updateSubscribeCollection(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbols: Symbol[],
        intervals?: TimeFrame[],
    ): Promise<void> {
        const payload = {
            connectorType,
            marketType,
            symbols,
            intervals: intervals ?? [],
        };
        this.logger.log(
            `Emitting CANDLE_SUBSCRIPTIONS_UPDATED ${connectorType}:${marketType} symbols=${payload.symbols.length} intervals=${(payload.intervals ?? []).length}`,
        );
        this.eventEmitter.emit(CANDLE_SUBSCRIPTIONS_UPDATED, payload);
        this.candleSync.onSubscriptionsUpdated(payload).catch((err) => {
            this.logger.error(`Candle warmup failed ${connectorType}:${marketType}`, err);
        });

        await this.candleSync.waitForWarmupCompletion();
        await this.questDbQueryService.waitForWalDrain('candles');

        switch (connectorType) {
            case ConnectorType.binance:
                await this.binanceService.updateSubscribeCollection(
                    marketType,
                    symbols,
                    intervals,
                );
                break;

            case ConnectorType.alpaca:
                break;

            case ConnectorType.tinkoff:
                break;
        }
    }
}
