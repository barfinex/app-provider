import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
    ConnectorType,
    MarketType,
    TimeFrame,
} from '@barfinex/types';

import { CandleQueryService } from './candle-query.service';
import { CandleService } from './candle.service';
import { toDomainInterval } from './time/time.utils';

@ApiTags('Candles')
@Controller('candles')
export class CandleController {
    constructor(
        private readonly query: CandleQueryService,
        private readonly candleService: CandleService,
    ) { }

    // =========================================================================
    // 🔹 GET /candles/:connectorType/:marketType/:symbol/:interval
    // =========================================================================
    @Get(':connectorType/:marketType/:symbol/:interval')
    async getCandles(
        @Param('connectorType') connectorType: ConnectorType,
        @Param('marketType') marketType: MarketType,
        @Param('symbol') symbol: string,
        @Param('interval') intervalRaw: string,

        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('days') days?: string,
    ) {
        // 🔐 ЕДИНСТВЕННАЯ точка нормализации таймфрейма
        const interval = toDomainInterval(intervalRaw) as TimeFrame;

        let anchorTs: number | null;

        // ---------------------------------------------------------------------
        // Anchor resolution (ЕДИНСТВЕННАЯ точка правды)
        // ---------------------------------------------------------------------

        // 1️⃣ Явно передан `to`
        if (to) {
            anchorTs = Number(to);
        }

        // 3️⃣ Initial load → last ts from DB
        else {
            anchorTs = await this.query.loadLastTimestamp({
                symbol,
                connectorType,
                marketType,
                interval,
            });
        }


        console.log("anchorTs:", anchorTs);


        if (!anchorTs || !Number.isFinite(anchorTs)) {
            throw new Error(
                `No candles found for ${symbol} ${connectorType} ${marketType} ${interval}`
            );
        }

        // ---------------------------------------------------------------------
        // Range resolution
        // ---------------------------------------------------------------------
        const { fromTs, toTs } = this.resolveRange(
            interval,
            anchorTs,
            from,
            to,
            days,
        );


        console.log("fromTs:", fromTs);
        console.log("toTs:", toTs);


        if (fromTs === null) {
            return [];
        }

        return this.query.loadRangeNormalized({
            connectorType,
            marketType,
            symbol,
            interval,
            from: fromTs,
            to: toTs,
        });
    }

    // =========================================================================
    // 🔹 GET /candles/detector/:detectorSysname/symbol/:symbol/:interval
    // =========================================================================
    @Get('/detector/:detectorSysname/symbol/:symbol/:interval')
    async getByDetector(
        @Param('detectorSysname') detectorSysname: string,
        @Param('symbol') symbol: string,
        @Param('interval') intervalRaw: string,
    ) {
        const interval = toDomainInterval(intervalRaw) as TimeFrame;

        return this.candleService.getByDetectorSysname(
            detectorSysname,
            symbol,
            interval,
        );
    }

    // =========================================================================
    // Helpers
    // =========================================================================
    private resolveRange(
        interval: TimeFrame,
        anchorTs: number,
        from?: string,
        to?: string,
        days?: string,
    ): { fromTs: number | null; toTs: number } {

        // ✅ ПРАВАЯ ГРАНИЦА ВСЕГДА = anchorTs (если явно не передали to)
        const toTs = to
            ? Number(to)
            : anchorTs;

        let fromTs: number;

        if (from) {
            fromTs = Number(from);
        } else if (days) {
            fromTs = toTs - Number(days) * 24 * 60 * 60 * 1000;
        } else {
            // дефолтные окна
            fromTs =
                interval === TimeFrame.min1
                    ? toTs - 6 * 60 * 60 * 1000       // 6 часов
                    : toTs - 7 * 24 * 60 * 60 * 1000; // 7 дней
        }

        if (!Number.isFinite(fromTs) || fromTs > toTs) {
            return { fromTs: null, toTs };
        }

        return { fromTs, toTs };
    }

}
