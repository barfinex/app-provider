import { Injectable } from '@nestjs/common';
import { History, TimeFrame, Candle, Symbol } from '@barfinex/types';
import { AppError, ErrorEnvironment } from '../../error';

import { RequestFactoryService } from '../providers/request-factory.service';
import { SymbolHistoryService } from './symbol-history.service';
import { roundDay, DAY } from '../time/time.utils';

@Injectable()
export class HistoryLoaderService {
    constructor(
        private readonly requestFactory: RequestFactoryService,
        private readonly symbolHistory: SymbolHistoryService,
    ) { }

    async getHistory(options: History): Promise<Candle[]> {
        const { connectorType, marketType, symbols, interval, days, gapDays } = options;

        if (!days) {
            throw new AppError(
                ErrorEnvironment.History,
                'History start date does not passed use `--days N`',
            );
        }

        const requestFn = this.requestFactory.create(connectorType, marketType);

        const now = Date.now();
        const end = roundDay(now) - DAY * (gapDays ?? 0);
        const from = roundDay(end - DAY * days);

        const result: Candle[] = [];

        for (const s of symbols) {
            const symbol = typeof s === 'string' ? s : s.name;

            const list = await this.symbolHistory.loadForSymbol({
                connectorType,
                marketType,
                symbol,
                interval,
                from,
                to: end,
                requestFn,
            });

            result.push(...list);
        }

        return result.sort((a, b) => a.time - b.time);
    }

    async getSingle(args: {
        connectorType: any;
        marketType: any;
        symbol: Symbol;
        interval: TimeFrame;
    }) {
        const days = args.interval === TimeFrame.day ? 100 : 7;

        return this.getHistory({
            connectorType: args.connectorType,
            marketType: args.marketType,
            symbols: [args.symbol],
            interval: args.interval,
            days,
            gapDays: 0,
        });
    }
}
