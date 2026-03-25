import { ConnectorType, MarketType, TradeSide } from '@barfinex/types';
import { HorizontalVolumeProfileService } from './horizontal-volume-profile.service';

describe('HorizontalVolumeProfileService', () => {
  it('aggregates trades into deterministic buckets and derives key levels', () => {
    const prev = process.env.PROVIDER_HORIZONTAL_VOLUME_RECOMPUTE_EVERY_TRADES;
    process.env.PROVIDER_HORIZONTAL_VOLUME_RECOMPUTE_EVERY_TRADES = '1';
    const service = new HorizontalVolumeProfileService();
    const baseTime = Date.now();
    const trades = [
      { price: 100.0, volume: 2, side: TradeSide.LONG, time: baseTime },
      { price: 100.1, volume: 1, side: TradeSide.LONG, time: baseTime + 1 },
      { price: 100.0, volume: 3, side: TradeSide.SHORT, time: baseTime + 2 },
      { price: 100.2, volume: 4, side: TradeSide.LONG, time: baseTime + 3 },
      { price: 100.3, volume: 1, side: TradeSide.SHORT, time: baseTime + 4 },
    ];
    let latest = null as ReturnType<
      HorizontalVolumeProfileService['onTrade']
    > | null;
    for (const trade of trades) {
      latest = service.onTrade({
        symbol: 'BTCUSDT',
        connectorType: ConnectorType.binance,
        marketType: MarketType.futures,
        trade: {
          symbol: { name: 'BTCUSDT' },
          price: trade.price,
          volume: trade.volume,
          side: trade.side,
          time: trade.time,
        } as any,
      });
    }

    expect(latest).toBeTruthy();
    expect(latest?.summary?.tradeCount).toBe(5);
    expect(latest?.summary?.totalVolume).toBeCloseTo(11, 8);
    expect(latest?.summary?.deltaVolume).toBeCloseTo(3, 8);
    expect(latest?.summary?.pocPrice).not.toBeNull();
    expect(latest?.summary?.valueAreaLow).not.toBeNull();
    expect(latest?.summary?.valueAreaHigh).not.toBeNull();
    expect(Array.isArray(latest?.levels)).toBe(true);
    expect((latest?.levels?.length ?? 0) > 0).toBe(true);
    process.env.PROVIDER_HORIZONTAL_VOLUME_RECOMPUTE_EVERY_TRADES = prev;
  });

  it('keeps bounded memory for extreme bucket cardinality', () => {
    const prev = process.env.PROVIDER_HORIZONTAL_VOLUME_MAX_BUCKETS;
    process.env.PROVIDER_HORIZONTAL_VOLUME_MAX_BUCKETS = '30';
    const service = new HorizontalVolumeProfileService();
    const baseTime = Date.now();
    for (let i = 0; i < 200; i += 1) {
      service.onTrade({
        symbol: 'ETHUSDT',
        connectorType: ConnectorType.binance,
        marketType: MarketType.futures,
        trade: {
          symbol: { name: 'ETHUSDT' },
          price: 100 + i,
          volume: 1,
          side: i % 2 ? TradeSide.LONG : TradeSide.SHORT,
          time: baseTime + i,
        } as any,
      });
    }
    const row = service.buildPersistRow({
      symbol: 'ETHUSDT',
      connectorType: ConnectorType.binance,
      marketType: MarketType.futures,
    });
    expect(row).toBeTruthy();
    expect((row?.levels.length ?? 0) <= 80).toBe(true);
    process.env.PROVIDER_HORIZONTAL_VOLUME_MAX_BUCKETS = prev;
  });

  it('keeps buy/sell/delta conservation against exported levels', () => {
    const prevRecompute =
      process.env.PROVIDER_HORIZONTAL_VOLUME_RECOMPUTE_EVERY_TRADES;
    process.env.PROVIDER_HORIZONTAL_VOLUME_RECOMPUTE_EVERY_TRADES = '1';
    const service = new HorizontalVolumeProfileService();
    const baseTime = Date.now();
    const trades = [
      { price: 200.0, volume: 3, side: TradeSide.LONG },
      { price: 200.0, volume: 2, side: TradeSide.SHORT },
      { price: 200.1, volume: 1.5, side: TradeSide.LONG },
      { price: 199.9, volume: 0.8, side: TradeSide.SHORT },
      { price: 200.1, volume: 2.2, side: TradeSide.LONG },
    ];
    let latest: ReturnType<HorizontalVolumeProfileService['onTrade']> | null =
      null;
    for (let i = 0; i < trades.length; i += 1) {
      const trade = trades[i]!;
      latest = service.onTrade({
        symbol: 'SOLUSDT',
        connectorType: ConnectorType.binance,
        marketType: MarketType.futures,
        trade: {
          symbol: { name: 'SOLUSDT' },
          price: trade.price,
          volume: trade.volume,
          side: trade.side,
          time: baseTime + i,
        } as any,
      });
    }
    expect(latest?.summary).toBeTruthy();
    const bucketBuy = (latest?.levels ?? []).reduce(
      (acc, level) => acc + level.buyVolume,
      0,
    );
    const bucketSell = (latest?.levels ?? []).reduce(
      (acc, level) => acc + level.sellVolume,
      0,
    );
    const bucketTotal = (latest?.levels ?? []).reduce(
      (acc, level) => acc + level.totalVolume,
      0,
    );
    const bucketDelta = bucketBuy - bucketSell;
    expect(bucketBuy).toBeCloseTo(Number(latest?.summary?.buyVolume ?? 0), 8);
    expect(bucketSell).toBeCloseTo(Number(latest?.summary?.sellVolume ?? 0), 8);
    expect(bucketTotal).toBeCloseTo(
      Number(latest?.summary?.totalVolume ?? 0),
      8,
    );
    expect(bucketDelta).toBeCloseTo(
      Number(latest?.summary?.deltaVolume ?? 0),
      8,
    );
    process.env.PROVIDER_HORIZONTAL_VOLUME_RECOMPUTE_EVERY_TRADES =
      prevRecompute;
  });
});
