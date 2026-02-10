import { Injectable } from '@nestjs/common';
import { TimeFrame, Candle } from '@barfinex/types';

import { CandleQueryService } from '../candle-query.service';
import { CandleWriterService } from '../candle-writer.service';
import { HoleDetector } from './hole-detector';
import { aggregate } from '../aggregation/aggregation.utils';

@Injectable()
export class HigherTFService {
    constructor(
        private readonly query: CandleQueryService,
        private readonly writer: CandleWriterService,
    ) { }

    async load(args: {
        connectorType: any;
        marketType: any;
        symbol: string;
        interval: TimeFrame;
        from: number;
        to: number;
        requestFn: Function;
    }): Promise<Candle[]> {

        const { connectorType, marketType, symbol, interval, from, to, requestFn } = args;

        const localDay = await this.query.loadRange({
            symbol,
            connectorType,
            marketType,
            interval: TimeFrame.day,
            from,
            to,
        });

        let dayCandles = [...localDay];

        const holes = HoleDetector.find(dayCandles, from, to, TimeFrame.day);

        for (const hole of holes) {
            const fetched = await requestFn(hole.from, hole.to, symbol, TimeFrame.min1);
            const dayFromM1 = aggregate(fetched, TimeFrame.day);

            await this.writer.bulkInsertHistory(
                symbol,
                TimeFrame.day,
                connectorType,
                marketType,
                dayFromM1,
            );

            dayCandles.push(...dayFromM1);
        }

        return aggregate(dayCandles, interval);
    }
}
