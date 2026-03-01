/**
 * Валидация OHLC: нули и нечисловые значения не должны попадать в БД.
 * Volume может быть 0, для open/high/low/close — требуем конечное число > 0.
 */
export function isInvalidOhlc(candle: {
    open: number;
    high: number;
    low: number;
    close: number;
}): boolean {
    const { open, high, low, close } = candle;
    return (
        !Number.isFinite(open) ||
        !Number.isFinite(high) ||
        !Number.isFinite(low) ||
        !Number.isFinite(close) ||
        open <= 0 ||
        high <= 0 ||
        low <= 0 ||
        close <= 0
    );
}

/** Проверка, что свечу можно записывать (OHLC валидны). */
export function isValidCandle(candle: {
    open: number;
    high: number;
    low: number;
    close: number;
}): boolean {
    return !isInvalidOhlc(candle);
}

/** Результат проверки одной свечи для истории (bulk). */
export type HistoryCandleValidation =
    | { ok: true }
    | { ok: false; reason: string };

/**
 * Строгая валидация свечи перед записью в историю: OHLC-консистентность,
 * объём, время. Отсекает «косые» данные, которые могут вызвать suspend в QuestDB.
 */
export function validateHistoryCandle(candle: {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}): HistoryCandleValidation {
    const { time, open, high, low, close, volume } = candle;
    if (!Number.isFinite(time) || time <= 0) {
        return { ok: false, reason: 'time invalid or <= 0' };
    }
    if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
        return { ok: false, reason: 'OHLC not finite' };
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
        return { ok: false, reason: 'OHLC <= 0' };
    }
    if (!Number.isFinite(volume) || volume < 0) {
        return { ok: false, reason: 'volume not finite or < 0' };
    }
    const minPrice = Math.min(open, close);
    const maxPrice = Math.max(open, close);
    if (low > minPrice) {
        return { ok: false, reason: `low(${low}) > min(open,close)=${minPrice}` };
    }
    if (high < maxPrice) {
        return { ok: false, reason: `high(${high}) < max(open,close)=${maxPrice}` };
    }
    if (high < low) {
        return { ok: false, reason: `high(${high}) < low(${low})` };
    }
    return { ok: true };
}

/** Сериализация одной свечи для лога (при suspend). */
export function candleToLogRow(c: { time: number; open: number; high: number; low: number; close: number; volume: number }): Record<string, number | string> {
    return {
        time: c.time,
        ts: new Date(c.time).toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
    };
}
