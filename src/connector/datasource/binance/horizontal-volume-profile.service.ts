import { Injectable } from '@nestjs/common';
import {
  ConnectorType,
  HorizontalVolumeProfileLevel,
  HorizontalVolumeProfileSummary,
  MarketType,
  Trade,
} from '@barfinex/types';

interface MutableVolumeBucket {
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  tradeCount: number;
}

interface VolumeProfileState {
  symbol: string;
  connectorType: ConnectorType;
  marketType: MarketType;
  priceScale: number;
  bucketSize: number;
  buckets: Map<number, MutableVolumeBucket>;
  startedAt: number;
  updatedAt: number;
  lastTradePrice: number;
  tradeCount: number;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  deltaVolume: number;
  dirtyTrades: number;
  lastRecomputedAt: number;
  lastPersistedAt: number;
  lastSummary: HorizontalVolumeProfileSummary | null;
  lastLevels: HorizontalVolumeProfileLevel[];
}

export interface HorizontalVolumeProfileTickResult {
  summary: HorizontalVolumeProfileSummary | null;
  levels: HorizontalVolumeProfileLevel[];
  shouldPersist: boolean;
}

export interface HorizontalVolumeProfilePersistRow {
  symbol: string;
  connectorType: ConnectorType;
  marketType: MarketType;
  summary: HorizontalVolumeProfileSummary;
  levels: HorizontalVolumeProfileLevel[];
}

@Injectable()
export class HorizontalVolumeProfileService {
  private readonly maxBucketsPerSymbol = this.readPositiveInt(
    process.env.PROVIDER_HORIZONTAL_VOLUME_MAX_BUCKETS,
    2000,
  );
  private readonly keepPriceRadiusBuckets = this.readPositiveInt(
    process.env.PROVIDER_HORIZONTAL_VOLUME_KEEP_RADIUS_BUCKETS,
    120,
  );
  private readonly recomputeEveryTrades = this.readPositiveInt(
    process.env.PROVIDER_HORIZONTAL_VOLUME_RECOMPUTE_EVERY_TRADES,
    32,
  );
  private readonly recomputeMaxLatencyMs = this.readPositiveInt(
    process.env.PROVIDER_HORIZONTAL_VOLUME_RECOMPUTE_MAX_LATENCY_MS,
    1000,
  );
  private readonly persistMinIntervalMs = this.readPositiveInt(
    process.env.PROVIDER_HORIZONTAL_VOLUME_PERSIST_MS,
    5000,
  );
  private readonly maxExportLevels = this.readPositiveInt(
    process.env.PROVIDER_HORIZONTAL_VOLUME_EXPORT_LEVELS,
    80,
  );
  private readonly valueAreaFraction = this.readClamp01(
    process.env.PROVIDER_HORIZONTAL_VOLUME_VALUE_AREA_FRACTION,
    0.7,
  );
  private readonly defaultBucketBps = this.readPositiveFloat(
    process.env.PROVIDER_HORIZONTAL_VOLUME_BUCKET_BPS,
    5,
  );
  private readonly states = new Map<string, VolumeProfileState>();

  onTrade(params: {
    symbol: string;
    connectorType: ConnectorType;
    marketType: MarketType;
    trade: Trade;
    referencePrice?: number;
  }): HorizontalVolumeProfileTickResult {
    const symbol = String(params.symbol || '')
      .trim()
      .toUpperCase();
    if (!symbol) return { summary: null, levels: [], shouldPersist: false };
    const price = this.toPositiveNumber(params.trade.price);
    const volume = this.toNonNegativeNumber(params.trade.volume);
    if (!(price > 0) || !(volume > 0)) {
      const existing = this.states.get(
        this.buildStateKey(symbol, params.connectorType, params.marketType),
      );
      return {
        summary: existing?.lastSummary ?? null,
        levels: existing?.lastLevels ?? [],
        shouldPersist: false,
      };
    }

    const now = this.resolveTimestamp(params.trade.time);
    const state = this.getOrCreateState({
      symbol,
      connectorType: params.connectorType,
      marketType: params.marketType,
      price,
    });
    state.lastTradePrice = price;
    state.updatedAt = now;
    state.tradeCount += 1;
    state.totalVolume += volume;
    const isBuy = String(params.trade.side ?? '').toUpperCase() === 'LONG';
    if (isBuy) state.buyVolume += volume;
    else state.sellVolume += volume;
    state.deltaVolume = state.buyVolume - state.sellVolume;

    const bucketIndex = this.priceToBucketIndex(
      price,
      state.priceScale,
      state.bucketSize,
    );
    const bucket = state.buckets.get(bucketIndex) ?? {
      buyVolume: 0,
      sellVolume: 0,
      totalVolume: 0,
      tradeCount: 0,
    };
    if (isBuy) bucket.buyVolume += volume;
    else bucket.sellVolume += volume;
    bucket.totalVolume += volume;
    bucket.tradeCount += 1;
    state.buckets.set(bucketIndex, bucket);
    state.dirtyTrades += 1;

    if (state.buckets.size > this.maxBucketsPerSymbol) {
      this.pruneBuckets(state, bucketIndex);
    }

    const shouldRecompute =
      state.lastSummary == null ||
      state.dirtyTrades >= this.recomputeEveryTrades ||
      now - state.lastRecomputedAt >= this.recomputeMaxLatencyMs;
    if (!shouldRecompute) {
      return {
        summary: state.lastSummary,
        levels: state.lastLevels,
        shouldPersist: false,
      };
    }

    const next = this.recompute(state, params.referencePrice);
    state.lastSummary = next.summary;
    state.lastLevels = next.levels;
    state.lastRecomputedAt = now;
    state.dirtyTrades = 0;
    const shouldPersist =
      now - state.lastPersistedAt >= this.persistMinIntervalMs;
    if (shouldPersist) {
      state.lastPersistedAt = now;
    }
    return {
      summary: next.summary,
      levels: next.levels,
      shouldPersist,
    };
  }

  buildPersistRow(params: {
    symbol: string;
    connectorType: ConnectorType;
    marketType: MarketType;
  }): HorizontalVolumeProfilePersistRow | null {
    const key = this.buildStateKey(
      params.symbol,
      params.connectorType,
      params.marketType,
    );
    const state = this.states.get(key);
    if (!state || !state.lastSummary) return null;
    return {
      symbol: state.symbol,
      connectorType: state.connectorType,
      marketType: state.marketType,
      summary: state.lastSummary,
      levels: state.lastLevels,
    };
  }

  ensureSymbol(params: {
    symbol: string;
    connectorType: ConnectorType;
    marketType: MarketType;
    initialPrice?: number;
  }): void {
    const symbol = String(params.symbol || '')
      .trim()
      .toUpperCase();
    if (!symbol) return;
    const key = this.buildStateKey(
      symbol,
      params.connectorType,
      params.marketType,
    );
    if (this.states.has(key)) return;
    this.getOrCreateState({
      symbol,
      connectorType: params.connectorType,
      marketType: params.marketType,
      price: this.toPositiveNumber(params.initialPrice) || 1,
    });
  }

  private recompute(
    state: VolumeProfileState,
    referencePrice?: number,
  ): {
    summary: HorizontalVolumeProfileSummary;
    levels: HorizontalVolumeProfileLevel[];
  } {
    const levels = this.buildLevels(state);
    const currentPrice =
      this.toPositiveNumber(referencePrice) || state.lastTradePrice;
    const totalVolume = state.totalVolume;
    const poc = this.resolvePoc(levels);
    const valueArea = this.resolveValueArea(
      levels,
      poc?.price ?? null,
      totalVolume,
      this.valueAreaFraction,
    );
    const highLowThresholds = this.resolveQuantiles(
      levels.map((level) => level.totalVolume),
    );
    const nearestHighAbove = this.findNearestByPredicate(
      levels,
      currentPrice,
      'above',
      (level) => level.totalVolume >= highLowThresholds.high,
    );
    const nearestHighBelow = this.findNearestByPredicate(
      levels,
      currentPrice,
      'below',
      (level) => level.totalVolume >= highLowThresholds.high,
    );
    const nearestLowAbove = this.findNearestByPredicate(
      levels,
      currentPrice,
      'above',
      (level) => level.totalVolume <= highLowThresholds.low,
    );
    const nearestLowBelow = this.findNearestByPredicate(
      levels,
      currentPrice,
      'below',
      (level) => level.totalVolume <= highLowThresholds.low,
    );
    const aroundCurrent = this.collectAroundCurrent(levels, currentPrice, 3);
    const localTotal = aroundCurrent.reduce(
      (acc, level) => acc + level.totalVolume,
      0,
    );
    const localDelta = aroundCurrent.reduce(
      (acc, level) => acc + (level.buyVolume - level.sellVolume),
      0,
    );
    const localImbalance = localTotal > 0 ? localDelta / localTotal : 0;
    const volumeAbove = levels
      .filter((level) => level.price > currentPrice)
      .reduce((acc, level) => acc + level.totalVolume, 0);
    const volumeBelow = levels
      .filter((level) => level.price < currentPrice)
      .reduce((acc, level) => acc + level.totalVolume, 0);
    const profileSkew =
      totalVolume > 0 ? (volumeAbove - volumeBelow) / totalVolume : 0;
    const concentrationScore =
      totalVolume > 0 && poc ? poc.totalVolume / totalVolume : 0;
    const distanceToPocBps =
      poc && currentPrice > 0
        ? ((currentPrice - poc.price) / currentPrice) * 10_000
        : null;
    const summary: HorizontalVolumeProfileSummary = {
      scope: 'provider_runtime',
      bucketSize: state.bucketSize / state.priceScale,
      bucketPrecision: state.priceScale,
      windowStart: state.startedAt,
      windowEnd: state.updatedAt,
      updatedAt: state.updatedAt,
      tradeCount: state.tradeCount,
      buyVolume: state.buyVolume,
      sellVolume: state.sellVolume,
      totalVolume: state.totalVolume,
      deltaVolume: state.deltaVolume,
      pocPrice: poc?.price ?? null,
      valueAreaLow: valueArea.low,
      valueAreaHigh: valueArea.high,
      nearestHighVolumeNodeAbove: nearestHighAbove,
      nearestHighVolumeNodeBelow: nearestHighBelow,
      nearestLowVolumeNodeAbove: nearestLowAbove,
      nearestLowVolumeNodeBelow: nearestLowBelow,
      profileSkew,
      concentrationScore,
      localImbalance,
      buySellDeltaAtCurrentRegion: localDelta,
      distanceToPocBps,
    };
    return { summary, levels };
  }

  private buildLevels(
    state: VolumeProfileState,
  ): HorizontalVolumeProfileLevel[] {
    const levels: HorizontalVolumeProfileLevel[] = [];
    for (const [bucketIndex, bucket] of state.buckets.entries()) {
      levels.push({
        price: bucketIndex / state.priceScale,
        buyVolume: bucket.buyVolume,
        sellVolume: bucket.sellVolume,
        totalVolume: bucket.totalVolume,
        tradeCount: bucket.tradeCount,
      });
    }
    levels.sort((a, b) => a.price - b.price);
    if (levels.length <= this.maxExportLevels) return levels;
    const middle = this.priceToBucketIndex(
      state.lastTradePrice,
      state.priceScale,
      state.bucketSize,
    );
    const sorted = levels
      .slice()
      .sort((a, b) => {
        const da = Math.abs(
          this.priceToBucketIndex(a.price, state.priceScale, state.bucketSize) -
            middle,
        );
        const db = Math.abs(
          this.priceToBucketIndex(b.price, state.priceScale, state.bucketSize) -
            middle,
        );
        if (da !== db) return da - db;
        return b.totalVolume - a.totalVolume;
      })
      .slice(0, this.maxExportLevels)
      .sort((a, b) => a.price - b.price);
    return sorted;
  }

  private resolvePoc(
    levels: HorizontalVolumeProfileLevel[],
  ): HorizontalVolumeProfileLevel | null {
    let poc: HorizontalVolumeProfileLevel | null = null;
    for (const level of levels) {
      if (!poc || level.totalVolume > poc.totalVolume) {
        poc = level;
      }
    }
    return poc;
  }

  private resolveValueArea(
    levels: HorizontalVolumeProfileLevel[],
    pocPrice: number | null,
    totalVolume: number,
    fraction: number,
  ): { low: number | null; high: number | null } {
    if (!levels.length || !Number.isFinite(pocPrice) || !(totalVolume > 0)) {
      return { low: null, high: null };
    }
    const target = totalVolume * fraction;
    let pocIndex = levels.findIndex((level) => level.price === pocPrice);
    if (pocIndex < 0) {
      pocIndex = 0;
    }
    let left = pocIndex;
    let right = pocIndex;
    let covered = levels[pocIndex]?.totalVolume ?? 0;
    while (covered < target && (left > 0 || right < levels.length - 1)) {
      const nextLeft = left > 0 ? levels[left - 1] : null;
      const nextRight = right < levels.length - 1 ? levels[right + 1] : null;
      const leftVol = nextLeft?.totalVolume ?? -1;
      const rightVol = nextRight?.totalVolume ?? -1;
      if (rightVol > leftVol) {
        right += 1;
        covered += Math.max(0, levels[right]?.totalVolume ?? 0);
      } else if (nextLeft) {
        left -= 1;
        covered += Math.max(0, levels[left]?.totalVolume ?? 0);
      } else if (nextRight) {
        right += 1;
        covered += Math.max(0, levels[right]?.totalVolume ?? 0);
      } else {
        break;
      }
    }
    return {
      low: levels[left]?.price ?? null,
      high: levels[right]?.price ?? null,
    };
  }

  private resolveQuantiles(values: number[]): { low: number; high: number } {
    if (!values.length) return { low: 0, high: 0 };
    const sorted = values.slice().sort((a, b) => a - b);
    const lowIdx = Math.floor((sorted.length - 1) * 0.25);
    const highIdx = Math.floor((sorted.length - 1) * 0.75);
    return {
      low: sorted[lowIdx] ?? 0,
      high: sorted[highIdx] ?? 0,
    };
  }

  private findNearestByPredicate(
    levels: HorizontalVolumeProfileLevel[],
    price: number,
    direction: 'above' | 'below',
    predicate: (level: HorizontalVolumeProfileLevel) => boolean,
  ): number | null {
    const sorted = direction === 'above' ? levels : levels.slice().reverse();
    for (const level of sorted) {
      if (direction === 'above' && level.price <= price) continue;
      if (direction === 'below' && level.price >= price) continue;
      if (predicate(level)) return level.price;
    }
    return null;
  }

  private collectAroundCurrent(
    levels: HorizontalVolumeProfileLevel[],
    currentPrice: number,
    radius: number,
  ): HorizontalVolumeProfileLevel[] {
    if (!levels.length) return [];
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < levels.length; i += 1) {
      const distance = Math.abs(levels[i]!.price - currentPrice);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = i;
      }
    }
    const from = Math.max(0, closestIndex - radius);
    const to = Math.min(levels.length, closestIndex + radius + 1);
    return levels.slice(from, to);
  }

  private pruneBuckets(state: VolumeProfileState, currentBucket: number): void {
    if (state.buckets.size <= this.maxBucketsPerSymbol) return;
    const candidates = Array.from(state.buckets.entries())
      .map(([bucket, value]) => ({
        bucket,
        distance: Math.abs(bucket - currentBucket),
        totalVolume: value.totalVolume,
      }))
      .filter((candidate) => candidate.distance > this.keepPriceRadiusBuckets)
      .sort((a, b) => {
        if (a.totalVolume !== b.totalVolume)
          return a.totalVolume - b.totalVolume;
        return b.distance - a.distance;
      });
    while (
      state.buckets.size > this.maxBucketsPerSymbol &&
      candidates.length > 0
    ) {
      const candidate = candidates.shift();
      if (!candidate) break;
      state.buckets.delete(candidate.bucket);
    }
  }

  private getOrCreateState(params: {
    symbol: string;
    connectorType: ConnectorType;
    marketType: MarketType;
    price: number;
  }): VolumeProfileState {
    const key = this.buildStateKey(
      params.symbol,
      params.connectorType,
      params.marketType,
    );
    const existing = this.states.get(key);
    if (existing) return existing;
    const priceScale = this.resolvePriceScale(params.price);
    const bucketSize = this.resolveBucketSize(priceScale, params.price);
    const now = Date.now();
    const state: VolumeProfileState = {
      symbol: params.symbol,
      connectorType: params.connectorType,
      marketType: params.marketType,
      priceScale,
      bucketSize,
      buckets: new Map<number, MutableVolumeBucket>(),
      startedAt: now,
      updatedAt: now,
      lastTradePrice: params.price,
      tradeCount: 0,
      buyVolume: 0,
      sellVolume: 0,
      totalVolume: 0,
      deltaVolume: 0,
      dirtyTrades: 0,
      lastRecomputedAt: 0,
      lastPersistedAt: 0,
      lastSummary: null,
      lastLevels: [],
    };
    this.states.set(key, state);
    return state;
  }

  private buildStateKey(
    symbol: string,
    connectorType: ConnectorType,
    marketType: MarketType,
  ): string {
    return `${String(connectorType)}:${String(marketType)}:${String(
      symbol || '',
    )
      .trim()
      .toUpperCase()}`;
  }

  private priceToBucketIndex(
    price: number,
    scale: number,
    bucketSize: number,
  ): number {
    const scaled = Math.round(price * scale);
    return Math.round(scaled / bucketSize) * bucketSize;
  }

  private resolveBucketSize(scale: number, referencePrice: number): number {
    const bpsStep = this.defaultBucketBps / 10_000;
    const priceStep = Math.max(1 / scale, referencePrice * bpsStep);
    const scaled = Math.max(1, Math.round(priceStep * scale));
    return scaled;
  }

  private resolvePriceScale(price: number): number {
    if (price >= 10_000) return 1;
    if (price >= 1_000) return 10;
    if (price >= 100) return 100;
    if (price >= 1) return 1000;
    return 10_000;
  }

  private toPositiveNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private toNonNegativeNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  private resolveTimestamp(value: unknown): number {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
    return Date.now();
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.max(1, Math.trunc(parsed));
  }

  private readPositiveFloat(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
  }

  private readClamp01(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0.1, Math.min(0.95, parsed));
  }

  clearSymbolState(
    symbol: string,
    connectorType: ConnectorType,
    marketType: MarketType,
  ): void {
    const key = this.buildStateKey(symbol, connectorType, marketType);
    this.states.delete(key);
  }

  clearAllStates(): void {
    this.states.clear();
  }
}
