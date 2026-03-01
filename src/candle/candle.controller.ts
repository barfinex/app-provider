import {
    BadRequestException,
    Controller,
    Get,
    NotFoundException,
    Param,
    Query,
} from '@nestjs/common';
import { ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

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
    @ApiParam({
        name: 'connectorType',
        required: true,
        description: 'Connector type (for example: binance).',
    })
    @ApiParam({
        name: 'marketType',
        required: true,
        description: 'Market type (for example: spot, futures).',
    })
    @ApiParam({
        name: 'symbol',
        required: true,
        description: 'Trading symbol (for example: BTCUSDT).',
    })
    @ApiParam({
        name: 'interval',
        required: true,
        description: 'Timeframe (for example: min1, min5, h1, day).',
    })
    @ApiQuery({
        name: 'from',
        required: false,
        type: String,
        description:
            'Range start. Supports unix timestamp in milliseconds (e.g. 1771804800000) or ISO-8601 datetime (e.g. 2026-02-23T00:00:00Z).',
    })
    @ApiQuery({
        name: 'to',
        required: false,
        type: String,
        description:
            'Range end / anchor. Supports unix timestamp in milliseconds (e.g. 1771808400000) or ISO-8601 datetime (e.g. 2026-02-23T01:00:00Z).',
    })
    @ApiQuery({
        name: 'days',
        required: false,
        type: Number,
        description:
            'Optional lookback window in days when "from" is not provided. Must be a non-negative number.',
    })
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
        const fromTsInput = this.parseTimestampQueryParam(from, 'from');
        const toTsInput = this.parseTimestampQueryParam(to, 'to');
        const daysInput = this.parseDaysQueryParam(days);

        let anchorTs: number | null;

        // ---------------------------------------------------------------------
        // Anchor resolution (ЕДИНСТВЕННАЯ точка правды)
        // ---------------------------------------------------------------------

        // 1️⃣ Явно передан `to`
        if (toTsInput !== null) {
            anchorTs = toTsInput;
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

        if (!anchorTs || !Number.isFinite(anchorTs)) {
            throw new NotFoundException(
                `No candles found for ${symbol} ${connectorType} ${marketType} ${interval}`
            );
        }

        // ---------------------------------------------------------------------
        // Range resolution
        // ---------------------------------------------------------------------
        const { fromTs, toTs } = this.resolveRange(
            interval,
            anchorTs,
            fromTsInput,
            toTsInput,
            daysInput,
        );

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
        fromTsInput?: number | null,
        toTsInput?: number | null,
        daysInput?: number | null,
    ): { fromTs: number | null; toTs: number } {

        // ✅ ПРАВАЯ ГРАНИЦА ВСЕГДА = anchorTs (если явно не передали to)
        const toTs = toTsInput !== null && toTsInput !== undefined
            ? toTsInput
            : anchorTs;

        let fromTs: number;

        if (fromTsInput !== null && fromTsInput !== undefined) {
            fromTs = fromTsInput;
        } else if (daysInput !== null && daysInput !== undefined) {
            fromTs = toTs - daysInput * 24 * 60 * 60 * 1000;
        } else {
            // дефолтные окна
            fromTs =
                interval === TimeFrame.min1
                    ? toTs - 6 * 60 * 60 * 1000       // 6 часов
                    : toTs - 7 * 24 * 60 * 60 * 1000; // 7 дней
        }

        if (!Number.isFinite(toTs)) {
            throw new BadRequestException(
                'Invalid query parameter "to". Expected unix timestamp in milliseconds or ISO-8601 datetime.',
            );
        }

        if (fromTs > toTs) {
            throw new BadRequestException(
                'Invalid range: "from" must be less than or equal to "to".',
            );
        }

        if (!Number.isFinite(fromTs) || fromTs > toTs) {
            return { fromTs: null, toTs };
        }

        return { fromTs, toTs };
    }

    private parseTimestampQueryParam(
        value: string | undefined,
        paramName: 'from' | 'to',
    ): number | null {
        if (value == null || value.trim() === '') {
            return null;
        }

        const trimmed = value.trim();
        const asNumber = Number(trimmed);
        if (Number.isFinite(asNumber)) {
            return asNumber;
        }

        const parsed = Date.parse(trimmed);
        if (Number.isFinite(parsed)) {
            return parsed;
        }

        throw new BadRequestException(
            `Invalid query parameter "${paramName}". Expected unix timestamp in milliseconds or ISO-8601 datetime.`,
        );
    }

    private parseDaysQueryParam(value: string | undefined): number | null {
        if (value == null || value.trim() === '') {
            return null;
        }

        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
            throw new BadRequestException(
                'Invalid query parameter "days". Expected a non-negative number.',
            );
        }
        return parsed;
    }
}
