import { Injectable } from '@nestjs/common';
import { TimeFrame, Candle } from '@barfinex/types';

import { CandleQueryService } from '../candle-query.service';
import { CandleWriterService } from '../candle-writer.service';
import { HoleDetector } from './hole-detector';
import { HigherTFService } from './higher-tf.service';
import { normalize } from '../aggregation/aggregation.utils';

@Injectable()
export class SymbolHistoryService {
    constructor(
        private readonly query: CandleQueryService,
        private readonly writer: CandleWriterService,
        private readonly higherTF: HigherTFService,
    ) { }

    async loadForSymbol(args: {
        connectorType: any;
        marketType: any;
        symbol: string;
        interval: TimeFrame;
        from: number;
        to: number;
        requestFn: Function;
    }): Promise<Candle[]> {

        const { connectorType, marketType, symbol, interval, from, to, requestFn } = args;

        const local = await this.query.loadRange({
            symbol,
            connectorType,
            marketType,
            interval,
            from,
            to,
        });

        const holes = HoleDetector.find(local, from, to, interval);
        if (!holes.length) return local;

        const filled: Candle[] = [...local];

        for (const hole of holes) {
            let raw = await requestFn(hole.from, hole.to, symbol, interval);

            if (interval === TimeFrame.week || interval === TimeFrame.month) {
                raw = await this.higherTF.load({
                    connectorType,
                    marketType,
                    symbol,
                    interval,
                    from: hole.from,
                    to: hole.to,
                    requestFn,
                });
            }

            await this.writer.bulkInsertHistory(
                symbol,
                interval,
                connectorType,
                marketType,
                raw,
            );

            filled.push(...raw);
        }

        return normalize(filled);
    }
}
