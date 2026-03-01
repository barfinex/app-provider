import { Injectable } from '@nestjs/common';
import { TimeFrame, Candle } from '@barfinex/types';

import { CandleQueryService } from '../candle-query.service';
import { CandleWriterService } from '../candle-writer.service';
import { HoleDetector } from './hole-detector';
import { aggregate } from '../aggregation/aggregation.utils';

interface WarmupLogMeta {
    opId: string;
    ctx: {
        symbol: string;
        tf: TimeFrame;
        connectorType: string;
        marketType: string;
    };
}

@Injectable()
export class HigherTFService {
    constructor(
        private readonly query: CandleQueryService,
        private readonly writer: CandleWriterService,
    ) { }

    private createWarmupOpId(): string {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
    }

    async load(args: {
        connectorType: any;
        marketType: any;
        symbol: string;
        interval: TimeFrame;
        from: number;
        to: number;
        requestFn: Function;
        logMeta?: WarmupLogMeta;
    }): Promise<Candle[]> {

        const { connectorType, marketType, symbol, interval, from, to, requestFn, logMeta } = args;
        const ctx = logMeta?.ctx ?? ({
            symbol,
            tf: interval,
            connectorType: String(connectorType),
            marketType: String(marketType),
        } as const);
        const meta = logMeta ?? { opId: this.createWarmupOpId(), ctx };

        const localDay = await this.query.loadRange({
            symbol: ctx.symbol,
            connectorType: ctx.connectorType,
            marketType: ctx.marketType,
            interval: TimeFrame.day,
            from,
            to,
            logMeta: meta,
        });

        let dayCandles = [...localDay];

        const holes = HoleDetector.find(dayCandles, from, to, TimeFrame.day);

        for (const hole of holes) {
            const fetched = await requestFn(hole.from, hole.to, ctx.symbol, TimeFrame.min1);
            const dayFromM1 = aggregate(fetched, TimeFrame.day);

            await this.writer.bulkInsertHistory(
                ctx.symbol,
                TimeFrame.day,
                ctx.connectorType,
                ctx.marketType,
                dayFromM1,
                meta,
            );

            dayCandles.push(...dayFromM1);
        }

        return aggregate(dayCandles, interval);
    }
}
