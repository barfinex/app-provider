import { Injectable, Logger } from '@nestjs/common';
import { TimeFrame, Candle } from '@barfinex/types';

import { CandleQueryService } from '../candle-query.service';
import { CandleWriterService } from '../candle-writer.service';
import { isInvalidOhlc } from '../candle-validation';
import { HoleDetector } from './hole-detector';
import { normalize } from '../aggregation/aggregation.utils';

interface WarmupLogMeta {
  opId: string;
  ctx: {
    symbol: string;
    tf: TimeFrame;
    connectorType: string;
    marketType: string;
  };
}

@Injectable()
export class InstrumentHistoryService {
  private readonly logger = new Logger(InstrumentHistoryService.name);
  private readonly warmupVerbose = process.env.CANDLE_VERBOSE_LOGS === 'true';

  constructor(
    private readonly query: CandleQueryService,
    private readonly writer: CandleWriterService,
  ) {}

  private warmupPrefix(meta: WarmupLogMeta): string {
    const { opId, ctx } = meta;
    return `[warmup:${opId}] [ctx symbol=${ctx.symbol} tf=${String(
      ctx.tf,
    )} connectorType=${ctx.connectorType} marketType=${ctx.marketType}]`;
  }

  private createWarmupOpId(): string {
    return `${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`.toUpperCase();
  }

  private warmupLog(message: string): void {
    if (this.warmupVerbose) this.logger.log(message);
  }

  private warmupDebug(message: string): void {
    if (this.warmupVerbose) this.logger.debug(message);
  }

  async loadForSymbol(args: {
    connectorType: any;
    marketType: any;
    symbol: string;
    interval: TimeFrame;
    from: number;
    to: number;
    requestFn: Function;
    /** Исключить свечи с time <= value (защита от дублей при расширении от последней в БД). */
    minTimeExclusive?: number;
    logMeta?: WarmupLogMeta;
  }): Promise<Candle[]> {
    const {
      connectorType,
      marketType,
      symbol,
      interval,
      from,
      to,
      requestFn,
      minTimeExclusive,
      logMeta,
    } = args;
    const ctx =
      logMeta?.ctx ??
      ({
        symbol,
        tf: interval,
        connectorType: String(connectorType),
        marketType: String(marketType),
      } as const);
    const meta = logMeta ?? { opId: this.createWarmupOpId(), ctx };
    const logPrefix = this.warmupPrefix(meta);

    const local = await this.query.loadRange({
      symbol: ctx.symbol,
      connectorType: ctx.connectorType,
      marketType: ctx.marketType,
      interval: ctx.tf,
      from,
      to,
      logMeta: meta,
    });

    const holes = HoleDetector.find(local, from, to, ctx.tf);
    this.warmupLog(
      `${logPrefix} loadForSymbol local=${local.length} rows, holes=${holes.length}`,
    );
    if (!holes.length) return local;

    const filled: Candle[] = [...local];
    const existingTimes = new Set<number>(local.map((c) => c.time));

    for (const hole of holes) {
      this.warmupLog(
        `${logPrefix} fetching REST hole ${new Date(
          hole.from,
        ).toISOString()}..${new Date(hole.to).toISOString()}`,
      );

      const raw = await requestFn(hole.from, hole.to, ctx.symbol, ctx.tf);

      let toWrite = Array.isArray(raw) ? raw : [];
      toWrite = toWrite.filter(
        (c: Candle) =>
          c &&
          Number.isFinite(c.time) &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close) &&
          Number.isFinite(c.volume) &&
          !isInvalidOhlc(c),
      );
      const beforeExistingFilter = toWrite.length;
      toWrite = toWrite.filter((c: Candle) => !existingTimes.has(c.time));
      const skippedExisting = beforeExistingFilter - toWrite.length;
      if (skippedExisting > 0) {
        this.warmupDebug(
          `${logPrefix} CANDLE_DUPLICATE_SKIPPED existing=${skippedExisting}`,
        );
      }
      if (minTimeExclusive != null) {
        const before = toWrite.length;
        toWrite = toWrite.filter((c: Candle) => c.time > minTimeExclusive);
        if (toWrite.length < before) {
          this.warmupDebug(
            `${logPrefix} dedup dropped=${
              before - toWrite.length
            } candles with time <= ${minTimeExclusive}`,
          );
        }
      }
      const dropped = (Array.isArray(raw) ? raw.length : 0) - toWrite.length;
      if (dropped > 0) {
        this.warmupDebug(
          `${logPrefix} dropped ${dropped} candles with invalid OHLC/non-finite fields`,
        );
      }

      this.warmupLog(`${logPrefix} writing ${toWrite.length} candles to DB`);

      await this.writer.bulkInsertHistory(
        ctx.symbol,
        ctx.tf,
        ctx.connectorType,
        ctx.marketType,
        toWrite,
        meta,
      );

      filled.push(...toWrite);
      for (const candle of toWrite) {
        existingTimes.add(candle.time);
      }
    }

    return normalize(filled);
  }
}
