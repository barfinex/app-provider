import { Injectable } from '@nestjs/common';
import { CandleEntity } from './candle.entity';
import { CandleMetadataEntity } from './candleMetadata.entity';
import {
    CandleRaw,
    TimeFrame,
    History,
    MarketType,
    ConnectorType,
    Symbol,
    Candle,
} from '@barfinex/types';
import { RequestMarketData } from './candle.interfaces';
import { createRequestBinance } from '@barfinex/connectors';
import { requestAlpaca } from '@barfinex/connectors';
import { AppError, ErrorEnvironment } from '../error';
import { promise } from '@barfinex/utils';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DetectorService } from '../detector/detector.service';
import { candleMapper } from '@barfinex/utils';

type CachePolicy = {
    skipCurrentFrame: boolean;     // не читаем/не сохраняем текущий бакет
    replaceDayOnSave: boolean;     // upsert дня: перед сохранением удаляем старый чанк дня
};

@Injectable()
export class CandleService {
    private readonly DAY = 86_400_000;

    constructor(
        @InjectRepository(CandleEntity) private readonly candleRepository: Repository<CandleEntity>,
        @InjectRepository(CandleMetadataEntity) private readonly candleMetadataRepository: Repository<CandleMetadataEntity>,
        private readonly detectorService: DetectorService,
    ) { }

    async getHistory(options: History): Promise<CandleEntity[]> {
        console.log('CandleService->getHistory options:', options);

        let requestMarketData: RequestMarketData;
        switch (options.connectorType) {
            case 'binance':
                requestMarketData = async (...args) => {
                    const raws = await createRequestBinance(options.marketType)(...args);
                    return raws.map(candleMapper.toDomainCandle);
                };
                break;

            case 'alpaca':
                requestMarketData = async (...args) => {
                    const raws = await requestAlpaca(...args);
                    return raws.map(candleMapper.toDomainCandle);
                };
                break;
            default:
                throw new AppError(
                    ErrorEnvironment.History,
                    `Unsupported connectorType: ${options.connectorType}`,
                );
        }

        return this.createHistory(options, requestMarketData);
    }

    async createHistory(options: History, requestFn: RequestMarketData) {
        const { symbols, days, interval, gapDays, connectorType, marketType } = options;
        const now = new Date();
        const stamp = gapDays ? this.roundDay(now.getTime()) : now.getTime();

        if (!days) {
            throw new AppError(
                ErrorEnvironment.History,
                'History start date does not passed use `--days N`',
            );
        }

        const end = stamp - this.DAY * (gapDays ?? 0);
        let from = this.roundDay(end - this.DAY * days);

        const symbolsNames = symbols.map((s) =>
            typeof (s as any) === 'string' ? (s as any) : (s as any)?.name,
        );
        console.log(
            `[HISTORY->REQ] ${connectorType}/${marketType} tf=${interval} symbols=`,
            symbolsNames,
        );

        // === FAST-PATH: для всех, кроме week/month — один запрос на весь диапазон ===
        if (interval !== TimeFrame.week && interval !== TimeFrame.month) {
            const SOFT_BAR_CAP = 500;
            const frame = this.frameMs(interval);
            const endSafe = Math.min(
                end,
                this.currentFrameStartUTC(Date.now(), interval) - 1, // конец последней закрытой свечи
            );
            const clippedFrom = Math.max(from, end - SOFT_BAR_CAP * frame + 1);

            const data = await this.createRequest(
                connectorType,
                symbolsNames,
                interval,
                clippedFrom,
                endSafe,
                marketType,
                requestFn,
            );

            // контракт метода исторически Promise<CandleEntity[]>
            // возвращаем как есть (как и в вашем исходнике), чтобы не ломать внешний код
            return data as unknown as CandleEntity[];
        }

        // ------ «медленный» путь по дням — нужен для week/month ------
        const reqs: Array<Promise<CandleRaw[]>> = [];
        let to = from;
        let chunkStart: number | undefined;
        let tries = 0;
        let result: CandleRaw[] = [];
        let progressValue = 0;

        console.log(
            `History loading from [${connectorType}] ${new Date(from).toLocaleDateString()}:\n`,
        );
        const progress = null as any;
        progress?.start(days, 0);

        while (to < end) {
            try {
                to = Math.min(from + this.DAY, end);
                if (!chunkStart) chunkStart = from;

                reqs.push(
                    this.createRequest(
                        connectorType,
                        symbolsNames,
                        interval,
                        from,
                        to,
                        marketType,
                        requestFn,
                    ),
                );

                if (reqs.length === 50 || to >= end) {
                    const data = await this.collectCandles(reqs);
                    result = result.concat(data);

                    reqs.length = 0;
                    tries = 0;
                    chunkStart = to;
                }

                progressValue++;
                progress?.update(progressValue);
                from = to;
            } catch (e) {
                console.log('Error:', e);
                if (progress) {
                    progress.stop();
                    throw e;
                }
                tries++;
                progressValue = Math.max(progressValue - reqs.length, 0);
                progress?.update(progressValue);
                reqs.length = 0;
                from = chunkStart!;
                await promise.sleep(Math.pow(2, tries) * 10_000);
            }
        }

        progress?.update(days);
        progress?.stop();

        return result as unknown as CandleEntity[];
    }

    private asRaw(c: Candle | CandleRaw): CandleRaw {
        if ('o' in c) return c as CandleRaw; // уже CandleRaw
        const d = c as Candle;               // domain Candle
        return {
            o: d.open,
            c: d.close,
            h: d.high,
            l: d.low,
            v: d.volume,
            time: d.time,
            symbol: d.symbol as any,
        };
    }

    /** Нормализует массив свечей к CandleRaw[] */
    private asRawArray(list: Array<Candle | CandleRaw>): CandleRaw[] {
        return (list ?? []).map((x) => this.asRaw(x));
    }

    async collectCandles(reqs: Array<Promise<CandleRaw[]>>): Promise<CandleRaw[]> {
        const res: Array<CandleRaw[]> = await Promise.all(reqs);
        let result: CandleRaw[] = [];

        res.forEach((candles) => {
            if (!candles) {
                console.log('missed data');
                return;
            }
            result = result.concat(candles.filter(Boolean));
        });

        return result;
    }

    public async upsertFinalCandle(args: {
        connectorType: ConnectorType;
        marketType: MarketType;
        symbol: string;
        interval: TimeFrame;
        candle: CandleRaw;
    }): Promise<void> {
        const { connectorType, marketType, symbol, interval, candle } = args;

        if (this.cachePolicy.skipCurrentFrame && this.isCurrentOpenFrame(Date.now(), interval)) {
            return;
        }

        await this.saveByDays({
            connectorType,
            marketType,
            symbol,
            interval,
            candles: [candle],
        });
    }

    private frameMs(tf: TimeFrame): number {
        switch (tf) {
            case TimeFrame.min1:
                return 60_000;
            case TimeFrame.min3:
                return 3 * 60_000;
            case TimeFrame.min5:
                return 5 * 60_000;
            case TimeFrame.min15:
                return 15 * 60_000;
            case TimeFrame.min30:
                return 30 * 60_000;
            case TimeFrame.h1:
                return 60 * 60_000;
            case TimeFrame.h2:
                return 2 * 60 * 60_000;
            case TimeFrame.h4:
                return 4 * 60 * 60_000;
            case TimeFrame.day:
                return 24 * 60 * 60_000;
            case TimeFrame.week:
                return 7 * 24 * 60 * 60_000;
            case TimeFrame.month:
                return 30 * 24 * 60_000 * 60; // условно
        }
    }

    private startOfISOWeekUTC(t: number): number {
        const d = new Date(t);
        const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
        const day = new Date(utc).getUTCDay(); // 0..6, вс=0
        const iso = day === 0 ? 7 : day; // 1..7, пн=1
        return utc - (iso - 1) * 24 * 60 * 60_000;
    }
    private startOfMonthUTC(t: number): number {
        const d = new Date(t);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
    }
    private floorToFrameStartUTC(t: number, tf: TimeFrame): number {
        switch (tf) {
            case TimeFrame.week:
                return this.startOfISOWeekUTC(t);
            case TimeFrame.month:
                return this.startOfMonthUTC(t);
            default:
                return Math.floor(t / this.frameMs(tf)) * this.frameMs(tf);
        }
    }

    private readonly cachePolicy: CachePolicy = {
        skipCurrentFrame: true,
        replaceDayOnSave: true,
    };
    private currentFrameStartUTC(now: number, tf: TimeFrame): number {
        return this.floorToFrameStartUTC(now, tf);
    }
    private isCurrentOpenFrame(now: number, tf: TimeFrame): boolean {
        const start = this.currentFrameStartUTC(now, tf);
        const end = start + this.frameMs(tf);
        return now >= start && now < end;
    }

    // <<< Важно >>>: тянем готовые бары для всех под-дневных интервалов
    private baseIntervalFor(tf: TimeFrame): TimeFrame {
        switch (tf) {
            case TimeFrame.week:
            case TimeFrame.month:
                return TimeFrame.day; // агрегаты из дневок
            default:
                return tf; // 1m/5m/15m/30m/1h/4h — готовые бары
        }
    }

    private mergeRanges(ranges: Array<{ from: number; to: number }>) {
        if (!ranges.length) return ranges;
        const sorted = [...ranges].sort((a, b) => a.from - b.from);
        const out: Array<{ from: number; to: number }> = [];
        let cur = { ...sorted[0] };
        for (let i = 1; i < sorted.length; i++) {
            const r = sorted[i];
            if (r.from <= cur.to) cur.to = Math.max(cur.to, r.to);
            else {
                out.push(cur);
                cur = { ...r };
            }
        }
        out.push(cur);
        return out;
    }

    async createRequest(
        connectorType: ConnectorType,
        symbols: string[],
        interval: TimeFrame,
        from: number,
        to: number,
        marketType: MarketType,
        requestFn: RequestMarketData,
    ): Promise<CandleRaw[]> {
        // Проверка на «начало дня» нужна только для дневных агрегатов
        if (interval === TimeFrame.week || interval === TimeFrame.month) {
            const validFrom = from / 100000;
            if (validFrom !== ~~validFrom) {
                throw new AppError(
                    ErrorEnvironment.History,
                    `Incorrect day request interval, 'from' should be start of day, from: ${from}`,
                );
            }
        }

        const out: CandleRaw[] = [];
        for (const symbol of symbols) {
            const part = await this.ensureRange({
                connectorType,
                marketType,
                symbol: symbol,
                interval,
                from,
                to,
                requestFn,
                persistAggregated: true,
            });
            out.push(...part);
        }

        if (connectorType === ConnectorType.binance) {
            this.strictSequenceAssert(interval, JSON.parse(JSON.stringify(out)) as any);
        }
        return out;
    }

    private async ensureRange(args: {
        connectorType: ConnectorType;
        marketType: MarketType;
        symbol: string;
        interval: TimeFrame;
        from: number;
        to: number;
        requestFn: RequestMarketData;
        persistAggregated?: boolean;
    }): Promise<CandleRaw[]> {
        const {
            connectorType,
            marketType,
            symbol,
            interval,
            from,
            to,
            requestFn,
            persistAggregated = true,
        } = args;

        const now = Date.now();
        const skipPersist =
            this.cachePolicy.skipCurrentFrame && this.isCurrentOpenFrame(now, interval);

        // 1) читаем локально по дням
        const dayChunks = this.splitByDays(from, to);
        const collected: CandleRaw[] = [];
        const missing: Array<{ from: number; to: number }> = [];

        for (const chunk of dayChunks) {
            const local = await this.loadLocalChunk({
                connectorType,
                marketType,
                symbol,
                interval,
                from: chunk.from,
                to: chunk.to,
            });
            if (local?.length) collected.push(...local);
            else missing.push({ from: chunk.from, to: chunk.to });
        }

        // 2) добираем «дыры»
        if (missing.length) {
            const holes = this.mergeRanges(missing);

            if (interval === TimeFrame.week || interval === TimeFrame.month) {
                // агрегаты из day (fallback из 1m при необходимости)
                const d1: CandleRaw[] = [];
                for (const hole of holes) {
                    const localD1 = await this.loadLocalChunk({
                        connectorType,
                        marketType,
                        symbol,
                        interval: TimeFrame.day,
                        from: hole.from,
                        to: hole.to,
                    });
                    if (localD1?.length) {
                        d1.push(...localD1);
                        continue;
                    }

                    const fetchedDay = await requestFn(hole.from, hole.to, symbol, TimeFrame.day);
                    const fetchedDayRaw = this.asRawArray(fetchedDay as Array<Candle | CandleRaw>);
                    if (fetchedDayRaw.length) {
                        if (!skipPersist)
                            await this.saveByDays({
                                connectorType,
                                marketType,
                                symbol,
                                interval: TimeFrame.day,
                                candles: fetchedDayRaw, // ✅ нормализовано
                            });
                        d1.push(...fetchedDayRaw);          // ✅
                    } else {
                        const fetched1m = await requestFn(hole.from, hole.to, symbol, TimeFrame.min1);
                        const fetched1mRaw = this.asRawArray(fetched1m as Array<Candle | CandleRaw>);
                        if (!skipPersist)
                            await this.saveByDays({
                                connectorType,
                                marketType,
                                symbol,
                                interval: TimeFrame.min1,
                                candles: fetched1mRaw,          // ✅
                            });
                        const dayFromM1 = this.aggregateFromBase(fetched1mRaw, TimeFrame.day); // ✅
                        if (!skipPersist)
                            await this.saveByDays({
                                connectorType,
                                marketType,
                                symbol,
                                interval: TimeFrame.day,
                                candles: dayFromM1,
                            });
                        d1.push(...dayFromM1);
                    }
                }
                const aggregated = this.aggregateFromBase(d1, interval);
                if (persistAggregated && !skipPersist) {
                    await this.saveByDays({
                        connectorType,
                        marketType,
                        symbol,
                        interval,
                        candles: aggregated,
                    });
                }
                collected.push(...aggregated);
            } else if (interval === TimeFrame.min1) {
                // 1m — тянем как есть
                const m1: CandleRaw[] = [];
                for (const hole of holes) {
                    const localM1 = await this.loadLocalChunk({
                        connectorType,
                        marketType,
                        symbol,
                        interval: TimeFrame.min1,
                        from: hole.from,
                        to: hole.to,
                    });
                    if (localM1?.length) {
                        m1.push(...localM1);
                        continue;
                    }

                    const fetched = await requestFn(hole.from, hole.to, symbol, TimeFrame.min1);
                    const fetchedRaw = this.asRawArray(fetched as Array<Candle | CandleRaw>);
                    if (!skipPersist)
                        await this.saveByDays({
                            connectorType,
                            marketType,
                            symbol,
                            interval: TimeFrame.min1,
                            candles: fetchedRaw,              // ✅
                        });
                    m1.push(...fetchedRaw);               // ✅
                }
                collected.push(...m1);
            } else {
                // 5m/15m/30m/1h/4h — тянем ГОТОВЫЕ бары у провайдера, но нормализуем в CandleRaw
                const tfCandles: CandleRaw[] = [];
                for (const hole of holes) {
                    const fetched = await requestFn(hole.from, hole.to, symbol, interval);
                    const fetchedRaw = this.asRawArray(fetched as Array<Candle | CandleRaw>);

                    if (!skipPersist) {
                        await this.saveByDays({
                            connectorType,
                            marketType,
                            symbol,
                            interval,
                            candles: fetchedRaw, // ✅ нормализованные сырые свечи
                        });
                    }

                    tfCandles.push(...fetchedRaw);
                }
                collected.push(...tfCandles);

            }
        }

        // 3) нормализация + возможная «пересборка хвоста»
        const normalized = this.normalizeAndDedup(collected);

        const base = this.baseIntervalFor(interval);
        if (
            normalized.length &&
            this.cachePolicy.skipCurrentFrame &&
            base !== interval &&
            this.isCurrentOpenFrame(now, interval)
        ) {
            const tailStart = this.floorToFrameStartUTC(
                normalized[normalized.length - 1].time,
                interval,
            );
            const baseCandles = await this.ensureRange({
                connectorType,
                marketType,
                symbol,
                interval: base,
                from: tailStart,
                to: now,
                requestFn,
                persistAggregated: true,
            });
            const rebuilt = this.aggregateFromBase(baseCandles, interval);
            const head = normalized.filter((c) => c.time < tailStart);
            return this.normalizeAndDedup([...head, ...rebuilt]);
        }

        return normalized;
    }

    private async loadLocalChunk(args: {
        connectorType: ConnectorType;
        marketType: MarketType;
        symbol: string; // приходит строка
        interval: TimeFrame;
        from: number;
        to: number;
    }): Promise<CandleRaw[] | null> {
        const { connectorType, marketType, symbol, interval, from, to } = args;

        if (this.cachePolicy.skipCurrentFrame && this.isCurrentOpenFrame(Date.now(), interval)) {
            return null;
        }

        const validFrom = (from / 100000).toString();
        const validTo = (to / 100000).toString();

        const meta = await this.candleMetadataRepository.findOne({
            where: { connectorType, marketType, symbol, interval, validFrom, validTo },
            relations: { candles: true },
        });
        if (!meta) return null;

        // преобразуем к CandleRaw
        const raw: CandleRaw[] = meta.candles
            .map((c) => ({
                o: c.o,
                c: c.c,
                h: c.h,
                l: c.l,
                v: c.v,
                time: c.time,
                symbol: { name: symbol } as any,
            }))
            .sort((a, b) => a.time - b.time);

        const now = Date.now();
        if (raw.length && this.isCurrentOpenFrame(now, interval)) {
            const lastStart = this.floorToFrameStartUTC(raw[raw.length - 1].time, interval);
            const curStart = this.currentFrameStartUTC(now, interval);
            if (lastStart === curStart) raw.pop();
        }

        return raw.filter((c) => c.time >= from && c.time < to);
    }

    private aggregateFromBase(source: CandleRaw[], target: TimeFrame): CandleRaw[] {
        if (!source.length) return [];
        source.sort((a, b) => a.time - b.time);

        const map = new Map<number, CandleRaw>();
        for (const c of source) {
            const bucketStart = this.floorToFrameStartUTC(c.time, target);
            const prev = map.get(bucketStart);
            if (!prev) {
                map.set(bucketStart, {
                    symbol: c.symbol,
                    time: bucketStart,
                    o: c.o,
                    h: c.h,
                    l: c.l,
                    c: c.c,
                    v: c.v,
                });
            } else {
                prev.h = Math.max(prev.h, c.h);
                prev.l = Math.min(prev.l, c.l);
                prev.c = c.c;
                prev.v += c.v;
            }
        }

        const out = Array.from(map.values()).sort((a, b) => a.time - b.time);

        const now = Date.now();
        if (out.length && this.isCurrentOpenFrame(now, target)) {
            const lastStart = this.floorToFrameStartUTC(out[out.length - 1].time, target);
            const curStart = this.currentFrameStartUTC(now, target);
            if (lastStart === curStart) out.pop();
        }
        return out;
    }

    private async saveByDays(args: {
        connectorType: ConnectorType;
        marketType: MarketType;
        symbol: string;
        interval: TimeFrame;
        candles: CandleRaw[];
    }) {
        const { connectorType, marketType, symbol, interval, candles } = args;
        if (!candles.length) return;

        const byDay = new Map<number, CandleRaw[]>();
        for (const c of candles) {
            const dayStart = this.roundDay(c.time);
            (byDay.get(dayStart) ?? byDay.set(dayStart, []).get(dayStart)!).push(c);
        }

        for (const [dayStart, list] of byDay.entries()) {
            const validFrom = (dayStart / 100000).toString();
            const validTo = ((dayStart + this.DAY) / 100000).toString();

            if (this.cachePolicy.replaceDayOnSave) {
                const exist = await this.candleMetadataRepository.find({
                    where: { connectorType, marketType, symbol, interval, validFrom, validTo },
                    relations: { candles: true },
                });
                for (const m of exist) {
                    if (m.candles?.length) await this.candleRepository.remove(m.candles);
                    await this.candleMetadataRepository.remove(m);
                }
            }

            const meta = new CandleMetadataEntity();
            meta.connectorType = connectorType;
            meta.marketType = marketType;
            meta.symbol = symbol;
            meta.interval = interval;
            meta.validFrom = validFrom;
            meta.validTo = validTo;
            const savedMeta = await this.candleMetadataRepository.save(meta);

            const entities: CandleEntity[] = list.map((c) => {
                const e = new CandleEntity();
                e.o = c.o;
                e.c = c.c;
                e.h = c.h;
                e.l = c.l;
                e.v = c.v;
                e.time = c.time;
                e.candleMetadata = savedMeta;
                return e;
            });
            await this.candleRepository.save(entities);
        }
    }

    private splitByDays(from: number, to: number): Array<{ from: number; to: number }> {
        const chunks: Array<{ from: number; to: number }> = [];
        let cur = this.roundDay(from);
        const end = this.roundDay(to) + this.DAY;

        while (cur < end) {
            const next = cur + this.DAY;
            const f = Math.max(from, cur);
            const t = Math.min(to, next);
            if (f < t) {
                chunks.push({ from: f, to: t });
            }
            cur = next;
        }
        return chunks;
    }

    private normalizeAndDedup(candles: CandleRaw[]): CandleRaw[] {
        if (!candles.length) return [];
        candles.sort((a, b) => a.time - b.time);

        const res: CandleRaw[] = [];
        let lastTime = -1;

        for (const c of candles) {
            if (c.time !== lastTime) {
                res.push(c);
                lastTime = c.time;
            } else {
                res[res.length - 1] = c;
            }
        }
        return res;
    }

    async strictSequenceAssert(interval: TimeFrame, candles: CandleRaw[]) {
        if (!candles.length) return;

        if (interval === TimeFrame.week || interval === TimeFrame.month) {
            for (let i = 0; i < candles.length - 1; i++) {
                const cur = this.floorToFrameStartUTC(candles[i].time, interval);
                const nxt = this.floorToFrameStartUTC(candles[i + 1].time, interval);
                if (cur === nxt) {
                    console.warn('Duplicate bucket', new Date(cur).toISOString(), interval);
                }
            }
            return;
        }

        const step = this.frameMs(interval);
        for (let i = 0; i < candles.length - 1; i++) {
            if (candles[i + 1].time !== candles[i].time + step) {
                console.warn(
                    ErrorEnvironment.History,
                    `Sequence gap for ${interval}: ${new Date(
                        candles[i].time,
                    ).toISOString()} -> ${new Date(candles[i + 1].time).toISOString()}`,
                );
            }
        }
    }

    roundDay(stamp: number) {
        return ~~(stamp / this.DAY) * this.DAY;
    }

    async all(): Promise<CandleEntity[]> {
        return [];
    }

    async create(data: any): Promise<CandleEntity[]> {
        return [];
    }

    async getByDetectorSysname(
        detectorSysname: string,
        symbol: Symbol,
        interval: TimeFrame,
    ): Promise<CandleEntity[]> {
        let result: CandleEntity[] = [];
        const detector = await this.detectorService.getDetector({ sysname: detectorSysname });
        for (const provider of detector.providers) {
            if (!provider.connectors?.length) {
                throw new Error('Provider connectors not configured');
            }

            for (const connector of provider.connectors) {
                for (const market of connector.markets) {
                    const candles = await this.get(
                        connector.connectorType,
                        market.marketType,
                        symbol,
                        interval,
                    );
                    result.push(...candles);
                }
            }
        }
        return result;
    }

    async get(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbol: Symbol,
        interval: TimeFrame,
    ): Promise<CandleEntity[]> {
        let days: number = 7;
        if (interval === TimeFrame.day) days = 100;

        const candles = await this.getHistory({
            connectorType,
            marketType,
            symbols: [symbol],
            days,
            interval,
            gapDays: 0,
        });

        (candles as any).reverse();

        if (candles.length > 2 && candles[0].time === candles[1].time) {
            (candles as any).splice(1, 1);
        }

        return candles;
    }
}
