import { Injectable, Logger } from '@nestjs/common';
import { History, TimeFrame, Candle, TradingSymbol } from '@barfinex/types';
import { AppError, ErrorEnvironment } from '../../error';

import { RequestFactoryService } from '../providers/request-factory.service';
import { SymbolHistoryService } from './symbol-history.service';
import { roundDay, DAY } from '../time/time.utils';

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
export class HistoryLoaderService {
  private readonly logger = new Logger(HistoryLoaderService.name);
  private readonly warmupVerbose = process.env.CANDLE_VERBOSE_LOGS === 'true';

  constructor(
    private readonly requestFactory: RequestFactoryService,
    private readonly symbolHistory: SymbolHistoryService,
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

  async getHistory(
    options: History & { logMeta?: WarmupLogMeta },
  ): Promise<Candle[]> {
    const {
      connectorType,
      marketType,
      symbols,
      interval,
      days,
      gapDays,
      logMeta,
    } = options;

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
      this.warmupLog(
        `${logPrefix} getHistory from=${new Date(
          from,
        ).toISOString()} to=${new Date(end).toISOString()}`,
      );

      const list = await this.symbolHistory.loadForSymbol({
        connectorType: ctx.connectorType,
        marketType: ctx.marketType,
        symbol: ctx.symbol,
        interval: ctx.tf,
        from,
        to: end,
        requestFn,
        logMeta: meta,
      });

      result.push(...list);
    }

    return result.sort((a, b) => a.time - b.time);
  }

  async getSingle(args: {
    connectorType: any;
    marketType: any;
    symbol: TradingSymbol;
    interval: TimeFrame;
    days?: number;
  }) {
    const days =
      typeof args.days === 'number' &&
      Number.isFinite(args.days) &&
      args.days > 0
        ? Math.floor(args.days)
        : args.interval === TimeFrame.day
        ? 100
        : 7;

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
