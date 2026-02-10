import { Injectable } from '@nestjs/common';
import { TimeFrame } from '@barfinex/types';

import { CandleCacheService, LiveCandle } from './candle-cache.service';
import { CandleAggregatorService } from './candle-aggregator.service';
import { CandleWriterService } from './candle-writer.service';

@Injectable()
export class CandleEngineService {

    constructor(
        private readonly cache: CandleCacheService,
        private readonly aggregator: CandleAggregatorService,
        private readonly writer: CandleWriterService,
    ) { }

    /**
     * Основной вход: каждый трейд → обновление всех свечей.
     */
    onTrade(params: {
        symbol: string;
        price: number;
        volume: number;
        ts: number;
        connectorType: string;
        marketType: string;
    }) {
        const { symbol, price, volume, ts, connectorType, marketType } = params;

        const baseTF = TimeFrame.min1;

        // === 1) Обновляем min1 свечу ===
        const updated = this.cache.update(symbol, baseTF, price, volume, ts);

        // === 2) Если min1 свеча закрылась → записываем и делаем cascade ===
        if (updated.closed) {
            const closed = updated.closed as LiveCandle;

            // 2.1) сохраняем закрытую min1 свечу
            this.writer.writeCandle(
                symbol,
                baseTF,
                closed,
                connectorType,
                marketType
            );

            // 2.2) каскадная агрегация (5m → 15m → 30m → …)
            const cascade = this.aggregator.propagate(
                symbol,
                baseTF,
                closed,
                ts
            );

            // 2.3) если закрылись родительские свечи — пишем и их
            for (const item of cascade) {
                this.writer.writeCandle(
                    symbol,
                    item.tf,
                    item.candle,
                    connectorType,
                    marketType
                );
            }
        }
    }
}
