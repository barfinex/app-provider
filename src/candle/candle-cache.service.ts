import { Injectable } from '@nestjs/common';
import { Candle, TimeFrame, Symbol as TSymbol } from '@barfinex/types';
import { ms } from './time/time.utils';

export interface LiveCandle extends Candle {
  start: number; // ms
  end: number; // ms
  ts: number; // ms (bucket start)
}

@Injectable()
export class CandleCacheService {
  private cache = new Map<string, LiveCandle>();

  private key(symbol: string, tf: TimeFrame): string {
    return `${symbol}.${tf}`;
  }

  getOrCreate(
    symbol: string,
    tf: TimeFrame,
    bucketStart: number, // ms
  ): LiveCandle {
    const k = this.key(symbol, tf);
    let c = this.cache.get(k);

    if (!c) {
      const duration = ms(tf);

      c = {
        // --- Candle fields ---
        open: 0,
        close: 0,
        high: Number.NEGATIVE_INFINITY,
        low: Number.POSITIVE_INFINITY,
        volume: 0,

        /**
         * Candle contract:
         * time + symbol обязательны
         */
        time: bucketStart,
        symbol: symbol as unknown as TSymbol,
        interval: tf,

        // --- LiveCandle fields ---
        start: bucketStart,
        end: bucketStart + duration,
        ts: bucketStart,
      };

      this.cache.set(k, c);
    }

    return c;
  }

  update(
    symbol: string,
    tf: TimeFrame,
    price: number,
    volume: number,
    ts: number, // ms
  ) {
    const bucket = this.bucketStart(ts, tf);
    const key = this.key(symbol, tf);

    const c = this.getOrCreate(symbol, tf, bucket);

    // 🪣 rollover
    if (c.start !== bucket) {
      const closed = { ...c };
      this.cache.delete(key);

      const nc = this.getOrCreate(symbol, tf, bucket);
      nc.open = price;
      nc.close = price;
      nc.high = price;
      nc.low = price;
      nc.volume = volume;

      return { closed, newCandle: nc };
    }

    // 🔄 update
    if (c.volume === 0) {
      c.open = price;
    }

    c.close = price;
    c.high = Math.max(c.high, price);
    c.low = Math.min(c.low, price);
    c.volume += volume;

    return { closed: null, newCandle: c };
  }

  bucketStart(ts: number, tf: TimeFrame): number {
    const size = ms(tf);
    return Math.floor(ts / size) * size;
  }
}
