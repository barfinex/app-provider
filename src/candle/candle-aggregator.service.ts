import { Injectable } from '@nestjs/common';
import { TimeFrame } from '@barfinex/types';

import { CandleCacheService, LiveCandle } from './candle-cache.service';

const PARENT: Record<TimeFrame, TimeFrame | null> = {
    min1: TimeFrame.min5,
    min5: TimeFrame.min15,
    min15: TimeFrame.min30,
    min30: TimeFrame.h1,
    h1: TimeFrame.h2,
    h2: TimeFrame.h4,
    h4: TimeFrame.day,
    day: null,
    week: null,
    month: null,
};

export interface ClosedParentCandle {
    tf: TimeFrame;
    candle: LiveCandle;
}

@Injectable()
export class CandleAggregatorService {

    constructor(private readonly cache: CandleCacheService) { }


    propagate(
        symbol: string,
        tf: TimeFrame,
        closed: LiveCandle,
        ts: number
    ): ClosedParentCandle[] {

        const out: ClosedParentCandle[] = [];

        let currTF = tf;
        let currClosed = closed;

        while (true) {
            const parent = PARENT[currTF];
            if (!parent) break;

            const upd = this.cache.update(
                symbol,
                parent,
                currClosed.close,
                currClosed.volume,
                ts
            );

            if (upd.closed) {
                out.push({
                    tf: parent,
                    candle: upd.closed
                });

                currTF = parent;
                currClosed = upd.closed;

                continue; // идём выше
            }

            break;
        }

        return out;
    }
}
