import { TimeFrame, Candle } from '@barfinex/types';
import { floor } from '../time/time.utils';

export function aggregate(source: Candle[], tf: TimeFrame): Candle[] {
  const bucket = new Map<number, Candle>();

  for (const c of source) {
    const start = floor(c.time, tf);
    const prev = bucket.get(start);

    if (!prev) {
      bucket.set(start, { ...c, time: start });
    } else {
      prev.high = Math.max(prev.high, c.high);
      prev.low = Math.min(prev.low, c.low);
      prev.close = c.close;
      prev.volume += c.volume;
    }
  }

  return [...bucket.values()].sort((a, b) => a.time - b.time);
}

export function normalize(list: Candle[]): Candle[] {
  const sorted = [...list].sort((a, b) => a.time - b.time);

  const out: Candle[] = [];
  let last = -1;

  for (const c of sorted) {
    if (c.time !== last) {
      out.push(c);
      last = c.time;
    } else {
      out[out.length - 1] = c;
    }
  }

  return out;
}
