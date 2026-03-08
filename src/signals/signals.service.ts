import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    ConnectorType,
    DataMaturity,
    DetectorInput,
    MarketType,
    TimeFrame,
    TradeSide,
} from '@barfinex/types';
import { ContextBiasDetector, HtfRangeZoneDetector } from '@barfinex/detector';
import { CandleService } from '../candle/candle.service';
import { CandleQueryService } from '../candle/candle-query.service';
import { BinanceService } from '../connector/datasource/binance/binance.service';
import { OrderBookRepository } from '../questdb/repositories/orderbook.repository';
import { TradeRepository } from '../questdb/repositories/trade.repository';

type CandlesCacheKey = string;
type CachedCandles = {
    h1: any[];
    h4: any[];
    d1: any[];
    updatedAtMs: { h1: number; h4: number; d1: number };
};

type ContextFeatures = {
    computedAt: number;
    detectorsFired: string[];
    bias?: 'LONG' | 'SHORT' | 'NEUTRAL';
    regime?: string;
    levels?: Record<string, number>;
    zones?: Array<{
        type: string;
        range: [number, number];
        timeframe?: 'h1' | 'h4' | 'd1';
        score?: number;
    }>;
};

@Injectable()
export class SignalsService {
    private readonly logger = new Logger(SignalsService.name);
    private readonly candlesCache = new Map<CandlesCacheKey, CachedCandles>();
    private static readonly MIN_CONTEXT_CANDLES = 50;

    constructor(
        private readonly candleService: CandleService,
        private readonly candleQueryService: CandleQueryService,
        private readonly orderBookRepository: OrderBookRepository,
        private readonly tradeRepository: TradeRepository,
        @Optional() private readonly binanceService?: BinanceService,
    ) { }

    async buildSignalContext(options: {
        symbol: string;
        connectorType: ConnectorType;
        marketType: MarketType;
        days?: { d1?: number; h4?: number; h1?: number };
        candlesKey?: string;
        candlesMode?: string;
    }) {
        const { symbol, connectorType, marketType } = options;
        const daysD1 = this.sanitizeDays(options.days?.d1, 365);
        const daysH4 = this.sanitizeDays(options.days?.h4, 180);
        const daysH1 = this.sanitizeDays(options.days?.h1, 90);

        const candlesKey: CandlesCacheKey = `candles:${connectorType}:${marketType}:${symbol}:d1=${daysD1}:h4=${daysH4}:h1=${daysH1}`;
        const candles = await this.getCandlesCached({
            key: candlesKey,
            connectorType,
            marketType,
            symbol,
            days: { d1: daysD1, h4: daysH4, h1: daysH1 },
        });
        let normalizedCandles = {
            h1: this.normalizeCandles(candles.h1),
            h4: this.normalizeCandles(candles.h4),
            d1: this.normalizeCandles(candles.d1),
        };
        let effectiveCandlesKey = candlesKey;
        const hasAnyCandles =
            normalizedCandles.h1.length > 0 ||
            normalizedCandles.h4.length > 0 ||
            normalizedCandles.d1.length > 0;
        if (!hasAnyCandles && marketType !== MarketType.spot) {
            const spotCandlesKey: CandlesCacheKey = `candles:${connectorType}:${MarketType.spot}:${symbol}:d1=${daysD1}:h4=${daysH4}:h1=${daysH1}`;
            const spotCandles = await this.getCandlesCached({
                key: spotCandlesKey,
                connectorType,
                marketType: MarketType.spot,
                symbol,
                days: { d1: daysD1, h4: daysH4, h1: daysH1 },
            });
            const normalizedSpotCandles = {
                h1: this.normalizeCandles(spotCandles.h1),
                h4: this.normalizeCandles(spotCandles.h4),
                d1: this.normalizeCandles(spotCandles.d1),
            };
            const hasSpotCandles =
                normalizedSpotCandles.h1.length > 0 ||
                normalizedSpotCandles.h4.length > 0 ||
                normalizedSpotCandles.d1.length > 0;
            if (hasSpotCandles) {
                normalizedCandles = normalizedSpotCandles;
                effectiveCandlesKey = spotCandlesKey;
            }
        }

        const [orderBookRows, trades] = await Promise.all([
            this.orderBookRepository.getLatest(symbol),
            this.tradeRepository.getTrades(symbol, 400),
        ]);

        const orderBook = this.buildOrderBookSnapshot(symbol, orderBookRows ?? []);
        const orderFlow = this.buildOrderFlowSnapshot(symbol, trades ?? []);
        const fallbackMid = Number(orderBook?.mid ?? NaN);
        if (!(orderFlow.tradeCount > 0)) {
            orderFlow.tradeCount = 1;
        }
        if (!((orderFlow.buyVolume ?? 0) + (orderFlow.sellVolume ?? 0) > 0)) {
            orderFlow.buyVolume = 0.5;
            orderFlow.sellVolume = 0.5;
            orderFlow.aggressiveBuyVolume = 0.5;
            orderFlow.aggressiveSellVolume = 0.5;
        }
        if (!(Number(orderFlow.vwap) > 0) && Number.isFinite(fallbackMid) && fallbackMid > 0) {
            orderFlow.vwap = fallbackMid;
        }
        const totalVolume = Math.max(0, Number(orderFlow.buyVolume ?? 0) + Number(orderFlow.sellVolume ?? 0));
        if (!(Number(orderFlow.avgTradeSize) > 0) && Number(orderFlow.tradeCount ?? 0) > 0) {
            orderFlow.avgTradeSize = totalVolume / Number(orderFlow.tradeCount ?? 1);
        }
        if (!(Number(orderFlow.maxTradeSize) > 0)) {
            orderFlow.maxTradeSize = Math.max(
                Number(orderFlow.avgTradeSize ?? 0),
                Number(orderFlow.buyVolume ?? 0),
                Number(orderFlow.sellVolume ?? 0),
            );
        }
        const maturity = this.resolveMaturity(normalizedCandles.d1?.length ?? 0);
        const latestD1Time = Number(normalizedCandles.d1?.[normalizedCandles.d1.length - 1]?.time ?? 0);
        const latestH4Time = Number(normalizedCandles.h4?.[normalizedCandles.h4.length - 1]?.time ?? 0);
        const latestH1Time = Number(normalizedCandles.h1?.[normalizedCandles.h1.length - 1]?.time ?? 0);
        const candlesCacheKey = `${effectiveCandlesKey}:${latestD1Time}:${latestH4Time}:${latestH1Time}`;

        const mode = String(options.candlesMode ?? 'FULL').toUpperCase();
        const canOmitCandles =
            mode !== 'FULL' &&
            typeof options.candlesKey === 'string' &&
            options.candlesKey.length > 0 &&
            options.candlesKey === candlesCacheKey;

        const responseCandles = canOmitCandles
            ? { cacheKey: candlesCacheKey }
            : {
                cacheKey: candlesCacheKey,
                h1: normalizedCandles.h1,
                h4: normalizedCandles.h4,
                d1: normalizedCandles.d1,
            };

        const contextFeatures = this.computeContextFeatures({
            symbol,
            connectorType,
            marketType,
            maturity,
            windows: {
                candlesDays: Math.max(1, normalizedCandles.d1?.length ?? 0),
                flowMinutes: 3,
                bookMinutes: 1,
            },
            candles: {
                cacheKey: candlesCacheKey,
                h1: normalizedCandles.h1,
                h4: normalizedCandles.h4,
                d1: normalizedCandles.d1,
            },
            orderFlow,
            orderBook,
        });

        return {
            connectorType,
            marketType,
            dataContext: {
                maturity,
                windows: {
                    candlesDays: Math.max(1, normalizedCandles.d1?.length ?? 0),
                    flowMinutes: 3,
                    bookMinutes: 1,
                },
            },
            candles: responseCandles,
            orderBook,
            orderFlow,
            contextFeatures,
        };
    }

    private buildOrderBookSnapshot(symbol: string, rows: any[]) {
        const bids = rows.filter((x: any) => String(x.side).toLowerCase() === 'bid');
        const asks = rows.filter((x: any) => String(x.side).toLowerCase() === 'ask');

        const bestBid = bids.reduce((max, x: any) => Math.max(max, Number(x.price ?? 0)), 0);
        const bestAsk = asks.reduce((min, x: any) => {
            const p = Number(x.price ?? 0);
            if (!p) return min;
            return min === 0 ? p : Math.min(min, p);
        }, 0);
        const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
        const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : 0;
        const spreadPct = bestBid > 0 && spread > 0 ? (spread / bestBid) * 100 : 0;

        const bidVol = bids.reduce((sum, x: any) => sum + Number(x.volume ?? 0), 0);
        const askVol = asks.reduce((sum, x: any) => sum + Number(x.volume ?? 0), 0);
        const imbalance = bidVol / (askVol + 1e-9);

        const bidWallUsd = bids
            .sort((a: any, b: any) => Number(b.volume ?? 0) - Number(a.volume ?? 0))
            .slice(0, 3)
            .reduce(
                (sum, x: any) => sum + Number(x.price ?? 0) * Number(x.volume ?? 0),
                0,
            );
        const askWallUsd = asks
            .sort((a: any, b: any) => Number(b.volume ?? 0) - Number(a.volume ?? 0))
            .slice(0, 3)
            .reduce(
                (sum, x: any) => sum + Number(x.price ?? 0) * Number(x.volume ?? 0),
                0,
            );

        const bidWalls = bids
            .slice()
            .sort((a: any, b: any) => Number(b.volume ?? 0) - Number(a.volume ?? 0))
            .slice(0, 3)
            .map((x: any) => ({ price: Number(x.price ?? 0), volume: Number(x.volume ?? 0) }));
        const askWalls = asks
            .slice()
            .sort((a: any, b: any) => Number(b.volume ?? 0) - Number(a.volume ?? 0))
            .slice(0, 3)
            .map((x: any) => ({ price: Number(x.price ?? 0), volume: Number(x.volume ?? 0) }));

        return {
            snapshotKey: `book:${symbol}:${Date.now()}`,
            depth: rows.length,
            imbalance,
            bestBid,
            bestAsk,
            mid,
            spread,
            spreadPct,
            bidWallUsd,
            askWallUsd,
            walls: {
                bid: bidWalls,
                ask: askWalls,
            },
        };
    }

    private buildOrderFlowSnapshot(symbol: string, rows: any[]) {
        const nowMs = Date.now();
        const shortWindowMs = 10_000;
        const longWindowMs = 180_000;

        let longBuy = 0;
        let longSell = 0;
        let shortBuy = 0;
        let shortSell = 0;
        let tradeCount = 0;
        let maxTradeSize = 0;
        let sumTradeSize = 0;
        let vwapNum = 0;
        let vwapDen = 0;

        for (const row of rows) {
            const tsMs = this.toMillis(row.ts);
            if (!tsMs || nowMs - tsMs > longWindowMs) continue;
            const volume = Number(row.volume ?? 0);
            const price = Number(row.price ?? 0);
            const side = String(row.side ?? '').toUpperCase();
            const isBuy = side === TradeSide.LONG || side === 'BUY' || side === 'BID';
            if (isBuy) longBuy += volume;
            else longSell += volume;
            if (nowMs - tsMs <= shortWindowMs) {
                if (isBuy) shortBuy += volume;
                else shortSell += volume;
            }

            tradeCount += 1;
            if (Number.isFinite(volume)) {
                sumTradeSize += volume;
                if (volume > maxTradeSize) maxTradeSize = volume;
            }
            if (Number.isFinite(price) && price > 0 && Number.isFinite(volume) && volume > 0) {
                vwapNum += price * volume;
                vwapDen += volume;
            }
        }

        const longTotal = longBuy + longSell;
        const deltaRatio = longTotal > 0 ? longBuy / longTotal : 0.5;
        const cvd = longBuy - longSell;
        const delta = cvd;
        const shortTotal = shortBuy + shortSell;
        const shortDeltaRatio = shortTotal > 0 ? shortBuy / shortTotal : 0.5;
        const absorptionScore = Math.abs(shortDeltaRatio - deltaRatio);
        const avgTradeSize = tradeCount > 0 ? sumTradeSize / tradeCount : 0;
        const vwap = vwapDen > 0 ? vwapNum / vwapDen : null;

        return {
            snapshotKey: `flow:${symbol}:${Date.now()}`,
            shortWindowSec: 10,
            longWindowSec: 180,
            deltaRatio,
            cvd,
            aggressiveBuyVolume: longBuy,
            aggressiveSellVolume: longSell,
            absorptionScore,
            tradeCount,
            avgTradeSize,
            maxTradeSize,
            buyVolume: longBuy,
            sellVolume: longSell,
            delta,
            vwap,
        };
    }

    private resolveMaturity(days: number): DataMaturity {
        if (days >= 30) return DataMaturity.FULL;
        if (days >= 7) return DataMaturity.INTRADAY;
        if (days >= 1) return DataMaturity.FAST;
        return DataMaturity.INSUFFICIENT;
    }

    private toMillis(value: unknown): number | null {
        if (!value) return null;
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        const date = new Date(String(value));
        const ms = date.getTime();
        return Number.isFinite(ms) ? ms : null;
    }

    private sanitizeDays(value: number | undefined, fallback: number): number {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) return fallback;
        return Math.max(1, Math.min(3650, Math.floor(n)));
    }

    private normalizeCandles(rows: unknown): Array<{
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }> {
        if (!Array.isArray(rows)) return [];
        const deduped = new Map<number, {
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }>();
        for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            const candle = row as Record<string, unknown>;
            const time = this.resolveTimestampMs(candle.time ?? candle.ts ?? candle.closeTime);
            const close = Number(candle.close ?? 0);
            const openRaw = Number(candle.open);
            const highRaw = Number(candle.high);
            const lowRaw = Number(candle.low);
            const volume = Number(candle.volume ?? 0);
            if (time === null || time <= 0) continue;
            const normalizedTime = Number(time);
            if (!(Number.isFinite(close) && close > 0)) continue;
            const open = Number.isFinite(openRaw) && openRaw > 0 ? openRaw : close;
            const highCandidate = Number.isFinite(highRaw) && highRaw > 0 ? highRaw : close;
            const lowCandidate = Number.isFinite(lowRaw) && lowRaw > 0 ? lowRaw : close;
            const high = Math.max(highCandidate, open, close);
            const low = Math.min(lowCandidate, open, close);
            deduped.set(normalizedTime, {
                time: normalizedTime,
                open,
                high,
                low,
                close,
                volume: Number.isFinite(volume) && volume >= 0 ? volume : 0,
            });
        }
        return Array.from(deduped.values()).sort((a, b) => a.time - b.time);
    }

    private resolveTimestampMs(value: unknown): number | null {
        if (value instanceof Date) {
            const ts = value.getTime();
            return Number.isFinite(ts) && ts > 0 ? Math.trunc(ts) : null;
        }
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            return value < 1_000_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
        }
        if (typeof value === 'string' && value.trim().length > 0) {
            const numeric = Number(value);
            if (Number.isFinite(numeric) && numeric > 0) {
                return numeric < 1_000_000_000_000 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
            }
            const parsed = Date.parse(value.trim());
            if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        return null;
    }

    private mergeCandles(
        base: Array<{
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }>,
        incoming: Array<{
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }>,
    ) {
        const merged = new Map<number, {
            time: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }>();
        for (const row of base) merged.set(row.time, row);
        for (const row of incoming) merged.set(row.time, row);
        return Array.from(merged.values()).sort((a, b) => a.time - b.time);
    }

    private resolveMinCandlesRequired(interval: TimeFrame): number {
        if (interval === TimeFrame.h1 || interval === TimeFrame.h4 || interval === TimeFrame.day) {
            return SignalsService.MIN_CONTEXT_CANDLES;
        }
        return 1;
    }

    private normalizeMarketType(marketType: MarketType): string {
        const value = String(marketType ?? '').trim().toLowerCase();
        if (value === 'futures' || value === 'future' || value === 'perp' || value === 'perpetual') {
            return MarketType.futures;
        }
        return MarketType.spot;
    }

    private getLiveSnapshotCandles(symbol: string, interval: TimeFrame): Array<{
        time: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }> {
        const snapshot = this.binanceService?.getMarketQualitySnapshot(symbol);
        if (!snapshot) return [];
        const key: 'h1' | 'h4' | 'd1' =
            interval === TimeFrame.h4
                ? 'h4'
                : interval === TimeFrame.day
                    ? 'd1'
                    : 'h1';
        const raw = Array.isArray(snapshot.candles?.[key]) ? snapshot.candles[key] : [];
        return this.normalizeCandles(raw);
    }

    private async getCandlesCached(args: {
        key: CandlesCacheKey;
        connectorType: ConnectorType;
        marketType: MarketType;
        symbol: string;
        days: { d1: number; h4: number; h1: number };
    }): Promise<{ h1: any[]; h4: any[]; d1: any[] }> {
        const { key, connectorType, marketType, symbol, days } = args;
        const now = Date.now();
        const cached = this.candlesCache.get(key);

        // TTLs aligned with timeframe updates (с запасом).
        const ttl = {
            h1: 55 * 60_000,
            h4: 235 * 60_000,
            d1: 23 * 60 * 60_000,
        };

        const needH1 =
            !cached ||
            (cached.h1?.length ?? 0) < SignalsService.MIN_CONTEXT_CANDLES ||
            now - cached.updatedAtMs.h1 > ttl.h1;
        const needH4 =
            !cached ||
            (cached.h4?.length ?? 0) < SignalsService.MIN_CONTEXT_CANDLES ||
            now - cached.updatedAtMs.h4 > ttl.h4;
        const needD1 =
            !cached ||
            (cached.d1?.length ?? 0) < SignalsService.MIN_CONTEXT_CANDLES ||
            now - cached.updatedAtMs.d1 > ttl.d1;

        if (!needH1 && !needH4 && !needD1) {
            return { h1: cached.h1, h4: cached.h4, d1: cached.d1 };
        }

        const [h1, h4, d1] = await Promise.all([
            needH1
                ? this.loadCandlesWithStoreFirst(
                    connectorType,
                    marketType,
                    symbol,
                    TimeFrame.h1,
                    days.h1,
                )
                : Promise.resolve(cached?.h1 ?? []),
            needH4
                ? this.loadCandlesWithStoreFirst(
                    connectorType,
                    marketType,
                    symbol,
                    TimeFrame.h4,
                    days.h4,
                )
                : Promise.resolve(cached?.h4 ?? []),
            needD1
                ? this.loadCandlesWithStoreFirst(
                    connectorType,
                    marketType,
                    symbol,
                    TimeFrame.day,
                    days.d1,
                )
                : Promise.resolve(cached?.d1 ?? []),
        ]);

        const next: CachedCandles = {
            h1,
            h4,
            d1,
            updatedAtMs: {
                h1: needH1 ? now : cached?.updatedAtMs.h1 ?? now,
                h4: needH4 ? now : cached?.updatedAtMs.h4 ?? now,
                d1: needD1 ? now : cached?.updatedAtMs.d1 ?? now,
            },
        };
        this.candlesCache.set(key, next);
        return { h1: next.h1, h4: next.h4, d1: next.d1 };
    }

    private async loadCandlesWithStoreFirst(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbol: string,
        interval: TimeFrame,
        days: number,
    ): Promise<any[]> {
        const normalizedSymbol = String(symbol || '').trim().toUpperCase();
        const normalizedConnectorType = String(connectorType || '').trim().toLowerCase();
        const normalizedMarketType = this.normalizeMarketType(marketType);
        const minRequired = this.resolveMinCandlesRequired(interval);
        let merged: any[] = [];

        const anchorTs =
            (await this.candleQueryService.loadLastTimestamp({
                symbol: normalizedSymbol,
                connectorType: normalizedConnectorType,
                marketType: normalizedMarketType,
                interval,
            })) ?? Date.now();
        const toMs = Math.trunc(anchorTs);
        const fromMs = toMs - this.daysToMs(days);
        const fromStore = await this.candleQueryService.loadRangeNormalized({
            symbol: normalizedSymbol,
            connectorType: normalizedConnectorType,
            marketType: normalizedMarketType,
            interval,
            from: fromMs,
            to: toMs,
        });
        const normalizedFromStore = this.normalizeCandles(fromStore);
        if (normalizedFromStore.length > 0) {
            merged = this.mergeCandles(merged, normalizedFromStore);
            this.logger.log(
                `[candles_source] symbol=${normalizedSymbol} tf=${interval} source=questdb_range count=${normalizedFromStore.length} from=${fromMs} to=${toMs}`,
            );
        }

        if (merged.length < minRequired) {
            const fallbackCount = Math.max(this.resolveFallbackLastN(interval, days), minRequired * 2);
            const lastN = await this.candleQueryService.loadLastN(normalizedSymbol, interval, fallbackCount);
            const normalizedLastN = this.normalizeCandles(lastN);
            if (normalizedLastN.length > 0) {
                merged = this.mergeCandles(merged, normalizedLastN);
                this.logger.log(
                    `[candles_source] symbol=${normalizedSymbol} tf=${interval} source=questdb_lastN count=${normalizedLastN.length} limit=${fallbackCount}`,
                );
            }
        }

        if (merged.length < minRequired) {
            this.logger.log(
                `[candles_source] symbol=${normalizedSymbol} tf=${interval} source=history_loader days=${days}`,
            );
            const historyCandles = await this.candleService.get(
                connectorType,
                normalizedMarketType as MarketType,
                { name: normalizedSymbol },
                interval,
                { days },
            );
            const normalizedHistory = this.normalizeCandles(historyCandles);
            if (normalizedHistory.length > 0) {
                merged = this.mergeCandles(merged, normalizedHistory);
            }
        }

        if (merged.length < minRequired) {
            const liveCandles = this.getLiveSnapshotCandles(normalizedSymbol, interval);
            if (liveCandles.length > 0) {
                merged = this.mergeCandles(merged, liveCandles);
                this.logger.log(
                    `[candles_source] symbol=${normalizedSymbol} tf=${interval} source=live_snapshot count=${liveCandles.length}`,
                );
            }
        }

        if (merged.length < minRequired) {
            this.logger.log(
                `[candles_source] symbol=${normalizedSymbol} tf=${interval} source=insufficient count=${merged.length} minRequired=${minRequired}`,
            );
        }

        return merged;
    }

    private daysToMs(days: number): number {
        const normalizedDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 1;
        return normalizedDays * 24 * 60 * 60 * 1000;
    }

    private resolveFallbackLastN(interval: TimeFrame, days: number): number {
        if (interval === TimeFrame.h1) {
            return Math.max(100, Math.min(5000, Math.floor(days * 24)));
        }
        if (interval === TimeFrame.h4) {
            return Math.max(100, Math.min(5000, Math.floor(days * 6)));
        }
        if (interval === TimeFrame.day) {
            return Math.max(100, Math.min(5000, Math.floor(days)));
        }
        return Math.max(100, Math.min(5000, Math.floor(days * 24)));
    }

    private computeContextFeatures(args: {
        symbol: string;
        connectorType: ConnectorType;
        marketType: MarketType;
        maturity: DataMaturity;
        windows: { candlesDays: number; flowMinutes: number; bookMinutes: number };
        candles: { cacheKey: string; h1: any[]; h4: any[]; d1: any[] };
        orderFlow: any;
        orderBook: any;
    }): ContextFeatures {
        const input: DetectorInput = {
            instrument: {
                symbol: args.symbol,
                connectorType: args.connectorType,
                marketType: args.marketType,
            },
            dataContext: {
                maturity: args.maturity,
                windows: args.windows,
            },
            candles: args.candles,
            orderFlow: args.orderFlow,
            orderBook: args.orderBook,
        };

        const detectors = [new ContextBiasDetector(), new HtfRangeZoneDetector()];
        const results = detectors.map(d => d.evaluate(input)).filter(r => r.fired);

        const levels: Record<string, number> = {};
        const zones: ContextFeatures['zones'] = [];
        const detectorsFired: string[] = [];

        for (const r of results) {
            detectorsFired.push(r.detector);
            if (r.levelsDetailed) {
                for (const [k, v] of Object.entries(r.levelsDetailed)) {
                    const n = Number(v);
                    if (Number.isFinite(n)) levels[k] = n;
                }
            }
            if (Array.isArray(r.zonesDetailed)) {
                for (const z of r.zonesDetailed) {
                    if (!z || !Array.isArray(z.range) || z.range.length !== 2) continue;
                    const a = Number(z.range[0]);
                    const b = Number(z.range[1]);
                    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
                    zones.push({
                        type: String(z.type ?? 'ZONE'),
                        range: [a, b],
                        timeframe: (z.timeframe as any) ?? undefined,
                        score: typeof z.score === 'number' ? z.score : undefined,
                    });
                }
            }
        }

        const contextLike = results.find(r => r.bias || r.regime);
        return {
            computedAt: Date.now(),
            detectorsFired,
            bias: contextLike?.bias as any,
            regime: contextLike?.regime,
            levels: Object.keys(levels).length ? levels : undefined,
            zones: zones?.length ? zones : undefined,
        };
    }
}

