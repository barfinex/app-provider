import { ConnectorType, MarketType, TradeSide } from '@barfinex/types';
import { LiquidityMapService } from './liquidity-map.service';

describe('LiquidityMapService', () => {
  const pushTrade = (
    service: LiquidityMapService,
    symbol: string,
    ts: number,
    price: number,
    side = TradeSide.LONG,
  ) =>
    service.onTrade({
      symbol,
      connectorType: ConnectorType.binance,
      marketType: MarketType.futures,
      trade: {
        symbol: { symbol: symbol },
        price,
        volume: 1,
        side,
        time: ts,
      } as any,
      referencePrice: price,
    }) as any;

  const sumBuckets = (
    buckets: Map<
      number,
      { buyVolume: number; sellVolume: number; totalVolume: number }
    >,
  ) => {
    let buy = 0;
    let sell = 0;
    let total = 0;
    for (const bucket of buckets.values()) {
      buy += Number(bucket.buyVolume ?? 0);
      sell += Number(bucket.sellVolume ?? 0);
      total += Number(bucket.totalVolume ?? 0);
    }
    return { buy, sell, total, delta: buy - sell };
  };

  const sumEvents = (
    events: Array<{ buyVolume: number; sellVolume: number }>,
  ) => {
    const buy = events.reduce(
      (acc, row) => acc + Number(row.buyVolume ?? 0),
      0,
    );
    const sell = events.reduce(
      (acc, row) => acc + Number(row.sellVolume ?? 0),
      0,
    );
    const total = buy + sell;
    return { buy, sell, total, delta: buy - sell };
  };

  const resolveState = (service: LiquidityMapService, symbol: string) => {
    const key = `${ConnectorType.binance}:${
      MarketType.futures
    }:${symbol.toUpperCase()}`;
    return ((service as any).states.get(key) ?? null) as any;
  };

  it('correctly evicts rolling window events', () => {
    const service = new LiquidityMapService();
    const baseTs = Date.UTC(2026, 2, 10, 12, 0, 0);
    pushTrade(service, 'BTCUSDT', baseTs, 100);
    const afterEviction = pushTrade(
      service,
      'BTCUSDT',
      baseTs + 31 * 60_000,
      110,
    );
    expect(afterEviction.rolling_30m?.pocPrice).toBeCloseTo(110, 6);
    expect(afterEviction.rolling_30m?.valueAreaLow).toBeCloseTo(110, 6);
    expect(afterEviction.rolling_30m?.valueAreaHigh).toBeCloseTo(110, 6);
  });

  it('correctly resets candle scope on new candle', () => {
    const service = new LiquidityMapService();
    const baseTs = Date.UTC(2026, 2, 10, 12, 5, 0);
    pushTrade(service, 'BTCUSDT', baseTs, 100);
    pushTrade(service, 'BTCUSDT', baseTs + 60_000, 100.2);
    const nextCandle = pushTrade(
      service,
      'BTCUSDT',
      baseTs + 31 * 60_000,
      101.5,
    );
    expect(nextCandle.candle_30m?.pocPrice).toBeGreaterThan(101.3);
    expect(nextCandle.candle_30m?.pocPrice).toBeLessThan(101.7);
    expect(nextCandle.prev_candle_30m?.pocPrice).toBeGreaterThan(99);
    expect(nextCandle.prev_candle_30m?.pocPrice).toBeLessThan(101);
  });

  it('creates prev_candle snapshot from compact summary only', () => {
    const service = new LiquidityMapService();
    const baseTs = Date.UTC(2026, 2, 10, 8, 0, 0);
    pushTrade(service, 'ETHUSDT', baseTs, 2000);
    const next = pushTrade(service, 'ETHUSDT', baseTs + 31 * 60_000, 2010);
    const prevSnapshot = service.getSnapshot({
      symbol: 'ETHUSDT',
      connectorType: ConnectorType.binance,
      marketType: MarketType.futures,
      scope: 'prev_candle_30m',
    });
    expect(next.prev_candle_30m?.pocPrice).toBeCloseTo(2000, 6);
    expect(prevSnapshot?.topClusters).toEqual([]);
    expect(prevSnapshot?.topGaps).toEqual([]);
  });

  it('keeps rolling and candle scopes divergent across boundaries', () => {
    const service = new LiquidityMapService();
    const t0 = Date.UTC(2026, 2, 10, 11, 59, 0);
    pushTrade(service, 'SOLUSDT', t0, 90);
    const t1 = t0 + 2 * 60_000;
    const out = pushTrade(service, 'SOLUSDT', t1, 95);
    expect(out.candle_30m?.pocPrice).toBeGreaterThan(94.8);
    expect(out.candle_30m?.pocPrice).toBeLessThan(95.2);
    expect(
      Math.abs(
        (out.rolling_30m?.pocPrice ?? 0) - (out.candle_30m?.pocPrice ?? 0),
      ),
    ).toBeGreaterThan(1);
  });

  it('supports 30m/4h/24h rolling, candle and prev_candle scopes consistently', () => {
    const service = new LiquidityMapService();
    const symbol = 'BNBUSDT';
    const t0 = Date.UTC(2026, 2, 10, 0, 0, 0);
    pushTrade(service, symbol, t0, 300, TradeSide.LONG);
    const out = pushTrade(
      service,
      symbol,
      t0 + 24 * 60 * 60_000 + 60_000,
      310,
      TradeSide.SHORT,
    );
    expect(out.rolling_30m).toBeDefined();
    expect(out.candle_30m).toBeDefined();
    expect(out.prev_candle_30m).toBeDefined();
    expect(out.rolling_4h).toBeDefined();
    expect(out.candle_4h).toBeDefined();
    expect(out.prev_candle_4h).toBeDefined();
    expect(out.rolling_24h).toBeDefined();
    expect(out.candle_24h).toBeDefined();
    expect(out.prev_candle_24h).toBeDefined();
  });

  it('preserves volume conservation across rolling eviction and candle reset', () => {
    const service = new LiquidityMapService();
    const symbol = 'ADAUSDT';
    const t0 = Date.UTC(2026, 2, 10, 12, 0, 0);
    pushTrade(service, symbol, t0, 1.0, TradeSide.LONG);
    pushTrade(service, symbol, t0 + 5 * 60_000, 1.02, TradeSide.SHORT);
    pushTrade(service, symbol, t0 + 31 * 60_000, 1.03, TradeSide.LONG);

    const state = resolveState(service, symbol);
    expect(state).toBeTruthy();
    const rolling30 = state.periods['30m'].rolling;
    const candle30 = state.periods['30m'].candle;

    const rollingBuckets = sumBuckets(rolling30.buckets);
    const rollingEvents = sumEvents(rolling30.events);
    expect(rollingBuckets.total).toBeCloseTo(rollingEvents.total, 8);
    expect(rollingBuckets.buy).toBeCloseTo(rollingEvents.buy, 8);
    expect(rollingBuckets.sell).toBeCloseTo(rollingEvents.sell, 8);
    expect(rollingBuckets.delta).toBeCloseTo(rollingEvents.delta, 8);

    const candleBuckets = sumBuckets(candle30.buckets);
    const candleEvents = sumEvents(candle30.events);
    expect(candleBuckets.total).toBeCloseTo(candleEvents.total, 8);
    expect(candleBuckets.buy).toBeCloseTo(candleEvents.buy, 8);
    expect(candleBuckets.sell).toBeCloseTo(candleEvents.sell, 8);
    expect(candleBuckets.delta).toBeCloseTo(candleEvents.delta, 8);
  });

  it('captures prev_candle summary before reset and keeps persistence scopes aligned', () => {
    const service = new LiquidityMapService();
    const symbol = 'XRPUSDT';
    const t0 = Date.UTC(2026, 2, 10, 8, 0, 0);
    pushTrade(service, symbol, t0, 0.55, TradeSide.LONG);
    pushTrade(service, symbol, t0 + 31 * 60_000, 0.57, TradeSide.SHORT);
    pushTrade(
      service,
      symbol,
      t0 + 4 * 60 * 60_000 + 60_000,
      0.56,
      TradeSide.LONG,
    );
    pushTrade(
      service,
      symbol,
      t0 + 24 * 60 * 60_000 + 60_000,
      0.54,
      TradeSide.SHORT,
    );

    const state = resolveState(service, symbol);
    expect(state.periods['30m'].prevCandleSummary).toBeTruthy();
    expect(state.periods['4h'].prevCandleSummary).toBeTruthy();
    expect(state.periods['24h'].prevCandleSummary).toBeTruthy();

    const rows = service.consumePersistRows(Date.now() + 60_000);
    const scopes = rows.map((row) => row.snapshot.scope).sort();
    expect(scopes).toEqual([
      'candle_24h',
      'candle_30m',
      'candle_4h',
      'rolling_24h',
      'rolling_30m',
      'rolling_4h',
    ]);
    expect(scopes.some((scope) => scope.startsWith('prev_candle_'))).toBe(
      false,
    );
  });
});
