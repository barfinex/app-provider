import { Injectable, Logger } from '@nestjs/common';
import {
  TimeFrame,
  History,
  MarketType,
  ConnectorType,
  Symbol,
  Candle,
} from '@barfinex/types';

import { CandleWriterService } from './candle-writer.service';
import { HistoryLoaderService } from './history/history-loader.service';
import { DetectorHistoryService } from './detector/detector-history.service';
import { CandleQueryService } from './candle-query.service';
import { DerivedCandleService } from './derived/derived-candle.service';
import { floor, ms } from './time/time.utils';

@Injectable()
export class CandleService {
  private readonly logger = new Logger(CandleService.name);
  private static readonly REALTIME_CHAIN: TimeFrame[] = [
    TimeFrame.min1,
    TimeFrame.min5,
    TimeFrame.min15,
    TimeFrame.min30,
    TimeFrame.h1,
    TimeFrame.h2,
    TimeFrame.h4,
    TimeFrame.day,
  ];
  private readonly realtimeLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly history: HistoryLoaderService,
    private readonly detectorHistory: DetectorHistoryService,
    private readonly writer: CandleWriterService,
    private readonly query: CandleQueryService,
    private readonly derived: DerivedCandleService,
  ) {}

  private hasRealtimeRank(tf: TimeFrame): boolean {
    return CandleService.REALTIME_CHAIN.includes(tf);
  }

  private sortByRank(list: TimeFrame[]): TimeFrame[] {
    return [...list].sort((a, b) => {
      const ia = CandleService.REALTIME_CHAIN.indexOf(a);
      const ib = CandleService.REALTIME_CHAIN.indexOf(b);
      return ia - ib;
    });
  }

  private async withSeriesLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.realtimeLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prev.then(() => gate);
    this.realtimeLocks.set(key, chain);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.realtimeLocks.get(key) === chain) {
        this.realtimeLocks.delete(key);
      }
    }
  }

  // ================================================================
  // READ API
  // ================================================================
  async getHistory(options: History): Promise<Candle[]> {
    return this.history.getHistory(options);
  }

  async get(
    connectorType: ConnectorType,
    marketType: MarketType,
    symbol: Symbol,
    interval: TimeFrame,
    options?: { days?: number },
  ): Promise<Candle[]> {
    const rows = await this.history.getSingle({
      connectorType,
      marketType,
      symbol,
      interval,
      days: options?.days,
    });
    this.logger.debug(
      `[CANDLES] tf=${interval} rows=${rows.length} symbol=${symbol.name}`,
    );
    return rows;
  }

  async getByDetectorSysname(
    detectorSysname: string,
    symbol: string | Symbol,
    interval: TimeFrame,
  ): Promise<Candle[]> {
    return this.detectorHistory.getByDetectorSysname(
      detectorSysname,
      symbol,
      interval,
    );
  }

  // ================================================================
  // WRITE API
  // ================================================================
  async writeFinalCandle(params: {
    symbol: string;
    interval: TimeFrame;
    connectorType: ConnectorType;
    marketType: MarketType;
    candle: Candle;
  }) {
    const { symbol, interval, connectorType, marketType, candle } = params;
    const lockKey = `${String(connectorType)}:${String(marketType)}:${symbol}`;
    await this.withSeriesLock(lockKey, async () => {
      await this.writer.upsertFinalCandle(
        symbol,
        interval,
        candle,
        String(connectorType),
        String(marketType),
      );

      // If source interval isn't in the realtime chain, there is nothing to cascade.
      if (!this.hasRealtimeRank(interval)) return;

      const existingIntervals = new Set(
        await this.query.loadIntervalsWithHistory({
          symbol,
          connectorType: String(connectorType),
          marketType: String(marketType),
        }),
      );
      existingIntervals.add(interval);

      const sourceIdx = CandleService.REALTIME_CHAIN.indexOf(interval);
      const activeTargets = this.sortByRank(
        [...existingIntervals].filter((tf) => {
          if (!this.hasRealtimeRank(tf)) return false;
          const targetIdx = CandleService.REALTIME_CHAIN.indexOf(tf);
          return targetIdx > sourceIdx;
        }),
      );

      // Build only those higher intervals that already exist in DB history.
      for (const targetTf of activeTargets) {
        const targetIdx = CandleService.REALTIME_CHAIN.indexOf(targetTf);
        let sourceForTarget: TimeFrame | null = null;
        for (let i = targetIdx - 1; i >= 0; i -= 1) {
          const candidate = CandleService.REALTIME_CHAIN[i]!;
          if (candidate === interval || existingIntervals.has(candidate)) {
            sourceForTarget = candidate;
            break;
          }
        }
        if (!sourceForTarget) continue;

        const bucketStart = floor(candle.time, targetTf);
        const bucketEnd = bucketStart + ms(targetTf);
        const agg = await this.query.loadAggregatedFromSource({
          symbol,
          connectorType: String(connectorType),
          marketType: String(marketType),
          sourceInterval: sourceForTarget,
          fromMs: bucketStart,
          toExclusiveMs: bucketEnd,
        });
        if (!agg) continue;

        await this.writer.upsertFinalCandle(
          symbol,
          targetTf,
          {
            symbol: { name: symbol },
            interval: targetTf,
            time: bucketStart,
            open: agg.open,
            high: agg.high,
            low: agg.low,
            close: agg.close,
            volume: agg.volume,
          },
          String(connectorType),
          String(marketType),
        );
      }

      if (existingIntervals.has(TimeFrame.week) || existingIntervals.has(TimeFrame.month)) {
        const dayTsMs = floor(candle.time, TimeFrame.day);
        await this.derived.recomputeAffectedFromDailyClose({
          symbol,
          connectorType: String(connectorType),
          marketType: String(marketType),
          dayTsMs,
        });
      }
    });
  }

  /**
   * ВАЖНО:
   * История теперь НЕ обходит writer.
   * Всегда вызываем контролируемый chunk-режим.
   */
  async bulkInsertHistory(
    symbol: string,
    interval: TimeFrame,
    connectorType: ConnectorType,
    marketType: MarketType,
    list: Candle[],
  ) {
    await this.writer.bulkInsertHistory(
      symbol,
      interval,
      connectorType,
      marketType,
      list,
    );
  }

  async upsertFinalCandle(params: {
    connectorType: ConnectorType;
    marketType: MarketType;
    symbol: string;
    interval: TimeFrame;
    candle: Candle;
  }) {
    await this.writeFinalCandle(params);
  }
}
