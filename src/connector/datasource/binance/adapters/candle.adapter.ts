import { Candle as BinanceCandle } from 'binance-api-node';
import {
    CandleHandler,
    Candle,
    MarketType,
    TimeFrame,
    ConnectorType,
} from '@barfinex/types';
import { CandleService } from '../../../../candle/candle.service';
import { isInvalidOhlc } from '../../../../candle/candle-validation';
import { Logger } from '@nestjs/common';

export interface CandleAdapterDeps {
    marketType: MarketType;
    interval: TimeFrame;
    connectorType: ConnectorType;
    candleService: CandleService;
    logger: Logger;
    handler: CandleHandler;
    context: any; // только для handler.call
}

type BinanceCandleSafe = Partial<BinanceCandle> & {
    symbol?: string;
    startTime?: number;
    closeTime?: number;
    isFinal?: boolean;
    open?: string | number;
    high?: string | number;
    low?: string | number;
    close?: string | number;
    volume?: string | number;
};

function toNum(v: unknown): number {
    const n =
        typeof v === 'number'
            ? v
            : typeof v === 'string'
                ? Number(v)
                : NaN;

    return Number.isFinite(n) ? n : NaN;
}

export function createCandleAdapter(deps: CandleAdapterDeps) {
    const {
        marketType,
        interval,
        connectorType,
        candleService,
        logger,
        handler,
        context,
    } = deps;

    return async (msg: BinanceCandleSafe) => {
        try {
            if (!msg || msg.isFinal !== true) return;

            const symbol = msg.symbol;
            const startTime = msg.startTime;
            const closeTime = typeof msg.closeTime === 'number' && Number.isFinite(msg.closeTime)
                ? msg.closeTime
                : undefined;

            if (!symbol || typeof symbol !== 'string') return;
            if (typeof startTime !== 'number' || !Number.isFinite(startTime)) return;

            const open = toNum(msg.open);
            const high = toNum(msg.high);
            const low = toNum(msg.low);
            const close = toNum(msg.close);
            const volume = toNum(msg.volume);

            // если пришли нечисла — пропускаем
            if (
                !Number.isFinite(open) ||
                !Number.isFinite(high) ||
                !Number.isFinite(low) ||
                !Number.isFinite(close) ||
                !Number.isFinite(volume)
            ) {
                logger.warn(
                    `[candleAdapter] invalid numbers: symbol=${symbol} market=${marketType} interval=${interval}`,
                );
                return;
            }

            // нули в OHLC не записываем и не эмитим
            if (isInvalidOhlc({ open, high, low, close })) {
                logger.warn(
                    `[candleAdapter] skip zero/invalid OHLC: symbol=${symbol} ts=${startTime} o=${open} h=${high} l=${low} c=${close}`,
                );
                return;
            }

            const candle: Candle = {
                open,
                high,
                low,
                close,
                volume,
                time: startTime,
                symbol: { name: symbol },
                interval,
                raw: closeTime === undefined ? msg : { ...msg, closeTime },
            };

            // уведомляем подписчиков (если handler действительно функция)
            if (typeof handler?.call === 'function') {
                await handler.call(context, marketType, candle);
            }

            // записываем финальную свечу
            await candleService.writeFinalCandle({
                symbol,
                interval,
                connectorType,
                marketType,
                candle: {
                    open,
                    high,
                    low,
                    close,
                    volume,
                    time: startTime,
                    interval,
                    symbol: { name: symbol },
                },
            });
        } catch (err: any) {
            const message = err?.message || String(err);
            const sym = (msg as any)?.symbol ?? 'unknown';
            logger.error(
                `[candleAdapter] error: symbol=${sym} market=${marketType} interval=${interval} :: ${message}`,
                err?.stack,
            );
        }
    };
}
