// candle-writer.service.ts
import { Injectable } from '@nestjs/common';
import { QuestDBWriteService, ILPWriteOptions } from '../questdb/questdb-write.service';
import { Candle, TimeFrame } from '@barfinex/types';
import { LiveCandle } from './candle-cache.service';

/**
 * CandleWrite — формат записи в QuestDB.
 * Наследуем OHLCV из Candle, но заменяем:
 *  - symbol → string (tag)
 *  - time → ts (ms timestamp)
 *  - interval → string
 */
export interface CandleWrite
    extends Omit<Candle, 'symbol' | 'time' | 'interval'> {
    symbol: string;
    connectorType: string;
    marketType: string;
    interval: TimeFrame | string;
    ts: number; // milliseconds
}

@Injectable()
export class CandleWriterService {

    private readonly CHANNEL = 'candles' as const;

    constructor(private readonly writer: QuestDBWriteService) { }

    // ====================================================================
    //  1) Write ONE closed candle from CandleEngine (LiveCandle)
    // ====================================================================
    writeCandle(
        symbol: string,
        tf: TimeFrame,
        candle: LiveCandle,
        connectorType: string,
        marketType: string
    ) {
        const line: ILPWriteOptions = {
            table: 'candles',
            keys: {
                symbol,
                interval: tf,
                connectorType,
                marketType,
            },
            fields: {
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
            },
            timestampNs: candle.start * 1_000_000,
        };

        this.writer.write(this.CHANNEL, line);
    }

    // ====================================================================
    //  2) Explicit Final Candle Writer (used by CandleEngine propagate)
    // ====================================================================
    writeFinalCandle(
        symbol: string,
        tf: TimeFrame,
        candle: Candle,
        connectorType: string,
        marketType: string
    ) {
        const line: ILPWriteOptions = {
            table: 'candles',

            keys: {
                symbol,
                interval: tf,
                connectorType,
                marketType,
            },

            fields: {
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
            },

            // Candle.time === время свечи в ms → QuestDB требует ns
            timestampNs: candle.time * 1_000_000,
        };

        this.writer.write(this.CHANNEL, line);
    }

    // ====================================================================
    // 3) Write BATCH of candles (for CandleEngine or pipelines)
    // ====================================================================
    writeBatch(list: CandleWrite[]) {
        if (!list.length) return;

        const batch: ILPWriteOptions[] = list.map(c => {
            if (!Number.isFinite(c.ts)) {
                throw new Error(
                    `Invalid candle timestamp (ms): ${c.ts} for symbol=${c.symbol}`
                );
            }

            return {
                table: 'candles',
                keys: {
                    symbol: c.symbol,
                    connectorType: c.connectorType,
                    marketType: c.marketType,
                    interval: c.interval,
                },
                fields: {
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                    volume: c.volume,
                },
                // c.ts === milliseconds since epoch
                // QuestDB ILP requires nanoseconds
                timestampNs: Math.trunc(c.ts) * 1_000_000,
            };
        });

        this.writer.writeBatch(this.CHANNEL, batch);
    }


    // ====================================================================
    // 4) Historical INSERT (used by CandleService)
    // ====================================================================
    async bulkInsertHistory(
        symbol: string,
        interval: TimeFrame,
        connectorType: string,
        marketType: string,
        candles: Candle[]
    ) {
        if (!candles.length) return;

        const batch: ILPWriteOptions[] = candles.map(c => ({
            table: 'candles',
            keys: {
                symbol,
                interval,
                connectorType,
                marketType,
            },
            fields: {
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
            },
            timestampNs: c.time * 1_000_000,
        }));

        await this.writer.writeBatch(this.CHANNEL, batch);
    }
}
