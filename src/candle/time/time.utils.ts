import { TimeFrame } from '@barfinex/types';

/**
 * ============================================================================
 * Constants
 * ============================================================================
 */

export const DAY = 86_400_000;

/**
 * ============================================================================
 * Domain interval type (единый источник правды)
 * ============================================================================
 *
 * Используется как концепт:
 * UI / REST / Chart / DB → TimeFrame
 */
export type DomainInterval =
  | 'min1'
  | 'min5'
  | 'min15'
  | 'min30'
  | 'h1'
  | 'h2'
  | 'h4'
  | 'day';

/**
 * ============================================================================
 * Interval normalization (ANY → DomainInterval)
 * ============================================================================
 *
 * Любые входные значения (URL / UI / Toolbar / legacy)
 * → доменный формат
 */
const TF_TO_DOMAIN: Record<string, DomainInterval> = {
  // --- domain / db ---
  min1: 'min1',
  min5: 'min5',
  min15: 'min15',
  min30: 'min30',
  h1: 'h1',
  h2: 'h2',
  h4: 'h4',
  day: 'day',

  // --- chart / toolbar ---
  M1: 'min1',
  M5: 'min5',
  M15: 'min15',
  M30: 'min30',
  H1: 'h1',
  H2: 'h2',
  H4: 'h4',
  D1: 'day',

  // --- legacy / safety (API query: candleInterval=1m, 1d, etc.) ---
  '1m': 'min1',
  '5m': 'min5',
  '15m': 'min15',
  '30m': 'min30',
  '1h': 'h1',
  '2h': 'h2',
  '4h': 'h4',
  '1d': 'day',
};

/**
 * ============================================================================
 * DomainInterval → TimeFrame bridge (CRITICAL)
 * ============================================================================
 *
 * Явное соответствие строкового домена и enum TimeFrame.
 * Без этого TypeScript НЕ МОЖЕТ быть строгим.
 */
const DOMAIN_TO_TIMEFRAME: Record<DomainInterval, TimeFrame> = {
  min1: TimeFrame.min1,
  min5: TimeFrame.min5,
  min15: TimeFrame.min15,
  min30: TimeFrame.min30,
  h1: TimeFrame.h1,
  h2: TimeFrame.h2,
  h4: TimeFrame.h4,
  day: TimeFrame.day,
};

/**
 * 🔐 ЕДИНСТВЕННАЯ точка нормализации таймфрейма
 *
 * @example
 * toDomainInterval('M1')   → TimeFrame.min1
 * toDomainInterval('1m')   → TimeFrame.min1
 * toDomainInterval('day')  → TimeFrame.day
 */
export function toDomainInterval(tf: string): TimeFrame {
  const domain: DomainInterval =
    TF_TO_DOMAIN[tf] ??
    TF_TO_DOMAIN[tf.toUpperCase()] ??
    TF_TO_DOMAIN[tf.toLowerCase()] ??
    'min1';

  return DOMAIN_TO_TIMEFRAME[domain];
}

/**
 * ============================================================================
 * TimeFrame helpers
 * ============================================================================
 */

/**
 * Размер таймфрейма в миллисекундах
 */
export function ms(tf: TimeFrame): number {
  switch (tf) {
    case TimeFrame.min1:
      return 60_000;
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
      return DAY;
    default:
      throw new Error(
        `Unsupported TimeFrame: ${tf}. Supported: min1, min5, min15, min30, h1, h2, h4, day. ` +
          `Remove unsupported intervals (e.g. week) from connector/subscription config.`,
      );
  }
}

/**
 * Округление timestamp вниз до начала бара
 */
export function floor(t: number, tf: TimeFrame): number {
  return Math.floor(t / ms(tf)) * ms(tf);
}

/**
 * Округление до начала дня (UTC)
 */
export function roundDay(t: number): number {
  return Math.floor(t / DAY) * DAY;
}
