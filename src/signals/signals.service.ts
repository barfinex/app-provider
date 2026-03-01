import { Injectable } from '@nestjs/common';
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
    private readonly candlesCache = new Map<CandlesCacheKey, CachedCandles>();

    constructor(
        private readonly candleService: CandleService,
        private readonly orderBookRepository: OrderBookRepository,
        private readonly tradeRepository: TradeRepository,
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

        const [orderBookRows, trades] = await Promise.all([
            this.orderBookRepository.getLatest(symbol),
            this.tradeRepository.getTrades(symbol, 400),
        ]);

        const orderBook = this.buildOrderBookSnapshot(symbol, orderBookRows ?? []);
        const orderFlow = this.buildOrderFlowSnapshot(symbol, trades ?? []);
        const maturity = this.resolveMaturity(candles.d1?.length ?? 0);
        const latestD1Time = Number(candles.d1?.[candles.d1.length - 1]?.time ?? 0);
        const latestH4Time = Number(candles.h4?.[candles.h4.length - 1]?.time ?? 0);
        const latestH1Time = Number(candles.h1?.[candles.h1.length - 1]?.time ?? 0);
        const candlesCacheKey = `${candlesKey}:${latestD1Time}:${latestH4Time}:${latestH1Time}`;

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
                h1: candles.h1 ?? [],
                h4: candles.h4 ?? [],
                d1: candles.d1 ?? [],
            };

        const contextFeatures = this.computeContextFeatures({
            symbol,
            connectorType,
            marketType,
            maturity,
            windows: { candlesDays: Math.max(1, candles.d1?.length ?? 0), flowMinutes: 3, bookMinutes: 1 },
            candles: { cacheKey: candlesCacheKey, h1: candles.h1 ?? [], h4: candles.h4 ?? [], d1: candles.d1 ?? [] },
            orderFlow,
            orderBook,
        });

        return {
            connectorType,
            marketType,
            dataContext: {
                maturity,
                windows: {
                    candlesDays: Math.max(1, candles.d1?.length ?? 0),
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

        const needH1 = !cached || now - cached.updatedAtMs.h1 > ttl.h1;
        const needH4 = !cached || now - cached.updatedAtMs.h4 > ttl.h4;
        const needD1 = !cached || now - cached.updatedAtMs.d1 > ttl.d1;

        if (!needH1 && !needH4 && !needD1) {
            return { h1: cached.h1, h4: cached.h4, d1: cached.d1 };
        }

        const [h1, h4, d1] = await Promise.all([
            needH1
                ? this.candleService.get(connectorType, marketType, { name: symbol }, TimeFrame.h1, { days: days.h1 })
                : Promise.resolve(cached?.h1 ?? []),
            needH4
                ? this.candleService.get(connectorType, marketType, { name: symbol }, TimeFrame.h4, { days: days.h4 })
                : Promise.resolve(cached?.h4 ?? []),
            needD1
                ? this.candleService.get(connectorType, marketType, { name: symbol }, TimeFrame.day, { days: days.d1 })
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

