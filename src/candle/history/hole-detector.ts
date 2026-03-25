import { TimeFrame, Candle } from '@barfinex/types';
import { ms } from '../time/time.utils';

export class HoleDetector {
  static find(list: Candle[], from: number, to: number, tf: TimeFrame) {
    const frame = ms(tf);
    const holes: Array<{ from: number; to: number }> = [];

    if (!list.length) {
      holes.push({ from, to });
      return holes;
    }

    const sorted = [...list].sort((a, b) => a.time - b.time);

    if (sorted[0].time > from) {
      holes.push({ from, to: sorted[0].time });
    }

    for (let i = 0; i < sorted.length - 1; i++) {
      const expected = sorted[i].time + frame;
      if (sorted[i + 1].time > expected) {
        holes.push({ from: expected, to: sorted[i + 1].time });
      }
    }

    const lastExpected = sorted.at(-1)!.time + frame;
    if (lastExpected < to) {
      holes.push({ from: lastExpected, to });
    }

    return holes;
  }
}
