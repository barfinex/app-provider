import {
  Candle,
  ConnectorType,
  MarketType,
  SubscriptionType,
  SubscriptionValue,
} from '@barfinex/types';
import { EventBusService } from '@barfinex/event-bus';
import { Logger } from '@nestjs/common';
import { BacktestStatus } from './backtest.types';

export class BacktestSession {
  private cursor = 0;
  private playing = false;
  private timer: NodeJS.Timeout | null = null;
  private startedAt: number | null = null;
  private completedAt: number | null = null;
  private readonly logger = new Logger('BacktestSession');

  constructor(
    private readonly candles: Candle[],
    private readonly connectorType: ConnectorType,
    private readonly marketType: MarketType,
    private readonly speed: number,
    private readonly mode: 'historical' | 'synthetic',
    private readonly eventBus: EventBusService,
  ) {}

  start(): void {
    if (this.playing) return;
    this.playing = true;
    this.startedAt = Date.now();
    this.logger.log(
      `[Backtest] starting mode=${this.mode} candles=${this.candles.length} speed=${this.speed}x`,
    );
    this.tick();
  }

  stop(): void {
    this.playing = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.log(
      `[Backtest] stopped at cursor=${this.cursor}/${this.candles.length}`,
    );
  }

  getStatus(): BacktestStatus {
    const total = this.candles.length;
    return {
      running: this.playing,
      mode: this.mode,
      cursor: this.cursor,
      total,
      progressPct: total > 0 ? Math.round((this.cursor / total) * 100) : 0,
      speed: this.speed,
      startedAt: this.startedAt ?? undefined,
      completedAt: this.completedAt ?? undefined,
    };
  }

  private tick(): void {
    if (!this.playing) return;

    if (this.cursor >= this.candles.length) {
      this.playing = false;
      this.completedAt = Date.now();
      this.logger.log(
        `[Backtest] completed mode=${this.mode} total=${
          this.candles.length
        } durationMs=${
          this.completedAt - (this.startedAt ?? this.completedAt)
        }`,
      );
      return;
    }

    const candle = this.candles[this.cursor];
    const nextCandle = this.candles[this.cursor + 1];

    this.emitCandle(candle);
    this.cursor++;

    if (!nextCandle) {
      this.playing = false;
      this.completedAt = Date.now();
      this.logger.log(
        `[Backtest] completed mode=${this.mode} total=${this.candles.length}`,
      );
      return;
    }

    // speed=0 → instant (1ms delay to avoid stack overflow), otherwise scale delta
    let delay: number;
    if (this.speed <= 0) {
      delay = 1;
    } else {
      const delta = nextCandle.time - candle.time;
      delay = Math.max(1, delta / this.speed);
    }

    this.timer = setTimeout(() => this.tick(), delay);
  }

  private emitCandle(candle: Candle): void {
    const payload: SubscriptionValue = {
      value: candle,
      options: {
        connectorType: this.connectorType,
        marketType: this.marketType,
        updateMoment: candle.time,
      },
    };

    void this.eventBus
      .publish({
        channel: SubscriptionType.PROVIDER_MARKETDATA_CANDLE,
        payload,
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `[Backtest] candle publish failed symbol=${
            candle.instrument?.symbol
          } interval=${candle.interval}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }
}
