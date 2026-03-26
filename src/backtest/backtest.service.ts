import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { Candle, ConnectorType, MarketType, TimeFrame } from '@barfinex/types';
import { EventBusService } from '@barfinex/event-bus';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import { BacktestOptions, BacktestStatus } from './backtest.types';
import { BacktestSession } from './backtest.session';
import { generateSyntheticCandles } from './backtest-candle-generator';

@Injectable()
export class BacktestService {
  private session: BacktestSession | null = null;
  private readonly logger = new Logger('BacktestService');

  constructor(
    private readonly reader: QuestDBQueryService,
    private readonly eventBus: EventBusService,
  ) {}

  async startBacktest(options: BacktestOptions): Promise<{
    status: string;
    mode: string;
    count: number;
    speed: number;
  }> {
    if (this.session?.getStatus().running) {
      this.session.stop();
    }

    let candles: Candle[];
    let connectorType: ConnectorType;
    let marketType: MarketType;

    if (options.mode === 'synthetic') {
      if (!options.synthetic) {
        throw new BadRequestException(
          'synthetic options are required when mode=synthetic',
        );
      }
      const syn = options.synthetic;
      connectorType = syn.connectorType ?? ConnectorType.binance;
      marketType = syn.marketType ?? MarketType.futures;

      candles = generateSyntheticCandles({
        symbol: syn.symbol,
        interval: syn.interval,
        numCandles: Math.min(50_000, Math.max(1, syn.numCandles ?? 500)),
        startPrice: syn.startPrice ?? 50_000,
        volatility: Math.max(0.001, Math.min(0.5, syn.volatility ?? 0.015)),
        trend: Math.max(-0.1, Math.min(0.1, syn.trend ?? 0)),
        connectorType,
        marketType,
      });

      this.logger.log(
        `[Backtest] synthetic candles generated symbol=${syn.symbol} interval=${syn.interval} count=${candles.length}`,
      );
    } else {
      // historical mode
      if (options.from === undefined || options.to === undefined) {
        throw new BadRequestException(
          'from and to are required for historical mode',
        );
      }
      if (options.from > options.to) {
        throw new BadRequestException('from must be <= to');
      }

      connectorType =
        (options.connectorType as ConnectorType) ?? ConnectorType.binance;
      marketType = (options.marketType as MarketType) ?? MarketType.futures;

      candles = await this.loadHistoricalCandles(options);

      if (candles.length === 0) {
        throw new BadRequestException(
          `No candles found for the specified range/filters. Check from/to (Unix ms), symbol, interval, connectorType, marketType.`,
        );
      }

      this.logger.log(
        `[Backtest] historical candles loaded count=${candles.length} from=${options.from} to=${options.to}`,
      );
    }

    const speed = options.speed ?? 1;

    this.session = new BacktestSession(
      candles,
      connectorType,
      marketType,
      speed,
      options.mode,
      this.eventBus,
    );

    this.session.start();

    return {
      status: 'started',
      mode: options.mode,
      count: candles.length,
      speed,
    };
  }

  stopBacktest(): BacktestStatus {
    if (this.session) {
      this.session.stop();
    }
    return this.getStatus();
  }

  getStatus(): BacktestStatus {
    if (!this.session) {
      return {
        running: false,
        cursor: 0,
        total: 0,
        progressPct: 0,
        speed: 1,
      };
    }
    return this.session.getStatus();
  }

  private async loadHistoricalCandles(
    options: BacktestOptions,
  ): Promise<Candle[]> {
    const fromMs = options.from!;
    const toMs = options.to!;

    // Build WHERE clauses
    const conditions: string[] = [
      `ts BETWEEN ${fromMs} * 1000 AND ${toMs} * 1000`,
    ];

    if (options.connectorType) {
      conditions.push(
        `connectorType = '${this.escapeSql(options.connectorType)}'`,
      );
    }
    if (options.marketType) {
      conditions.push(`marketType = '${this.escapeSql(options.marketType)}'`);
    }
    if (options.symbol) {
      conditions.push(`symbol = '${this.escapeSql(options.symbol)}'`);
    }
    if (options.interval) {
      conditions.push(`interval = '${this.escapeSql(options.interval)}'`);
    }

    const whereClause = conditions.join(' AND ');

    const sql = `
            SELECT
                symbol,
                interval,
                connectorType,
                marketType,
                open,
                high,
                low,
                close,
                volume,
                ts
            FROM candles
            WHERE ${whereClause}
            ORDER BY ts ASC
        `;

    const rows = await this.reader.queryAsObjects(sql);

    return rows.map((row: Record<string, unknown>) => ({
      open: Number(row['open']),
      high: Number(row['high']),
      low: Number(row['low']),
      close: Number(row['close']),
      volume: Number(row['volume']),
      // QuestDB returns ts in microseconds (ns in wire), divide by 1_000_000 for ms
      time: Math.round(Number(row['ts']) / 1_000_000),
      interval: String(row['interval']) as TimeFrame,
      instrument: { symbol: String(row['symbol']) },
    }));
  }

  private escapeSql(value: string): string {
    return String(value).replace(/'/g, "''");
  }
}
