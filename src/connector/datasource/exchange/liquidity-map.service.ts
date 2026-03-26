import { Injectable } from '@nestjs/common';
import {
  ConnectorType,
  HorizontalVolumeProfileSummary,
  LiquidityCluster,
  LiquidityDynamicsSummary,
  LiquidityGap,
  LiquidityMapScope,
  LiquidityMapSnapshot,
  LiquidityMapSummary,
  LiquidityMapSummaryByScope,
  MarketType,
  OrderBook,
  Trade,
} from '@barfinex/types';

interface TradeBucket {
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  tradeCount: number;
}

interface ScopeEvent {
  ts: number;
  bucket: number;
  buyVolume: number;
  sellVolume: number;
}

interface DynamicsEvent {
  ts: number;
  added: number;
  pulled: number;
  consumed: number;
  restack: number;
}

interface ScopeState {
  scope: LiquidityMapScope;
  mode: 'rolling' | 'candle';
  windowMs: number;
  windowStart: number;
  buckets: Map<number, TradeBucket>;
  events: ScopeEvent[];
  dynamics: DynamicsEvent[];
}

type LiquidityPeriodKey = '30m' | '4h' | '24h';

interface PeriodState {
  rolling: ScopeState;
  candle: ScopeState;
  prevCandleSummary: LiquidityMapSummary | null;
}

interface SymbolState {
  symbol: string;
  connectorType: ConnectorType;
  marketType: MarketType;
  priceScale: number;
  bucketTicks: number;
  bucketSize: number;
  periods: Record<LiquidityPeriodKey, PeriodState>;
  lastOrderBookBuckets: {
    bid: Map<number, number>;
    ask: Map<number, number>;
  };
  lastOrderBookTs: number;
  lastOrderBook: import('@barfinex/types').OrderBook | null;
  lastSummaries: LiquidityMapSummaryByScope;
  lastSnapshots: Partial<Record<LiquidityMapScope, LiquidityMapSnapshot>>;
}

@Injectable()
export class LiquidityMapService {
  private readonly enabled =
    String(process.env.PROVIDER_LIQUIDITY_MAP_ENABLED ?? 'true') !== 'false';
  private readonly persistIntervalMs = this.readPositiveInt(
    process.env.PROVIDER_LIQUIDITY_MAP_PERSIST_MS,
    5_000,
  );
  private readonly maxBucketsPerScope = this.readPositiveInt(
    process.env.PROVIDER_LIQUIDITY_MAP_MAX_BUCKETS,
    2_500,
  );
  private readonly bookLevels = this.readPositiveInt(
    process.env.PROVIDER_LIQUIDITY_MAP_BOOK_LEVELS,
    80,
  );
  private readonly clusterThresholdQ = this.readClamp(
    process.env.PROVIDER_LIQUIDITY_MAP_CLUSTER_Q,
    0.75,
    0.5,
    0.95,
  );
  private readonly thinThresholdQ = this.readClamp(
    process.env.PROVIDER_LIQUIDITY_MAP_THIN_Q,
    0.25,
    0.05,
    0.5,
  );
  private readonly bucketBps = this.readPositiveFloat(
    process.env.PROVIDER_LIQUIDITY_MAP_BUCKET_BPS,
    4,
  );
  private readonly bucketTicks = this.readPositiveInt(
    process.env.PROVIDER_LIQUIDITY_MAP_BUCKET_TICKS,
    2,
  );
  private readonly localRadiusBuckets = this.readPositiveInt(
    process.env.PROVIDER_LIQUIDITY_MAP_LOCAL_RADIUS_BUCKETS,
    6,
  );
  private readonly states = new Map<string, SymbolState>();
  private readonly persistDue = new Map<string, number>();
  private readonly periodWindowsMs: Record<LiquidityPeriodKey, number> = {
    '30m': 30 * 60_000,
    '4h': 4 * 60 * 60_000,
    '24h': 24 * 60 * 60_000,
  };

  onTrade(params: {
    symbol: string;
    connectorType: ConnectorType;
    marketType: MarketType;
    trade: Trade;
    referencePrice?: number;
    profileSummary?: HorizontalVolumeProfileSummary | null;
  }): LiquidityMapSummaryByScope {
    if (!this.enabled) return {};
    const symbol = String(params.symbol || '')
      .trim()
      .toUpperCase();
    if (!symbol) return {};
    const tradePrice = this.toPositiveNumber(params.trade.price);
    const tradeVolume = this.toPositiveNumber(params.trade.volume);
    if (!(tradePrice > 0) || !(tradeVolume > 0))
      return this.getLastSummaries(
        symbol,
        params.connectorType,
        params.marketType,
      );
    const now = this.resolveTimestamp(params.trade.time);
    const state = this.getOrCreateState({
      symbol,
      connectorType: params.connectorType,
      marketType: params.marketType,
      referencePrice: tradePrice,
    });
    const isBuy = String(params.trade.side ?? '').toUpperCase() === 'LONG';
    const bucket = this.priceToBucket(
      tradePrice,
      state.priceScale,
      state.bucketSize,
    );
    const referencePrice =
      this.toPositiveNumber(params.referencePrice) || tradePrice;
    for (const periodKey of this.periodList()) {
      const period = state.periods[periodKey];
      this.rollScope(period.rolling, now);
      this.rotateCandleScopeIfNeeded(
        state,
        period,
        periodKey,
        now,
        referencePrice,
        params.profileSummary ?? null,
      );
      this.applyTradeEvent(period.rolling, now, bucket, tradeVolume, isBuy);
      this.applyTradeEvent(period.candle, now, bucket, tradeVolume, isBuy);
      this.pruneBuckets(period.rolling, bucket);
      this.pruneBuckets(period.candle, bucket);

      const rollingSnapshot = this.buildSnapshot({
        state,
        scope: period.rolling.scope,
        scopeState: period.rolling,
        now,
        referencePrice,
        profileSummary: params.profileSummary ?? null,
        orderbook: state.lastOrderBook,
      });
      const candleSnapshot = this.buildSnapshot({
        state,
        scope: period.candle.scope,
        scopeState: period.candle,
        now,
        referencePrice,
        profileSummary: params.profileSummary ?? null,
        orderbook: state.lastOrderBook,
      });
      state.lastSummaries[period.rolling.scope] = rollingSnapshot.summary;
      state.lastSnapshots[period.rolling.scope] = rollingSnapshot;
      state.lastSummaries[period.candle.scope] = candleSnapshot.summary;
      state.lastSnapshots[period.candle.scope] = candleSnapshot;

      if (period.prevCandleSummary) {
        const prevScope = this.prevScopeForPeriod(periodKey);
        const prevSummary = this.compactCloneSummary(
          period.prevCandleSummary,
          prevScope,
        );
        state.lastSummaries[prevScope] = prevSummary;
        state.lastSnapshots[prevScope] = this.buildCompactSnapshot(
          state.symbol,
          prevSummary,
        );
      }
    }
    return state.lastSummaries;
  }

  onOrderBook(params: {
    symbol: string;
    connectorType: ConnectorType;
    marketType: MarketType;
    orderbook: OrderBook;
    profileSummary?: HorizontalVolumeProfileSummary | null;
    referencePrice?: number;
  }): LiquidityMapSummaryByScope {
    if (!this.enabled) return {};
    const symbol = String(params.symbol || '')
      .trim()
      .toUpperCase();
    if (!symbol) return {};
    const state = this.getOrCreateState({
      symbol,
      connectorType: params.connectorType,
      marketType: params.marketType,
      referencePrice: this.toPositiveNumber(params.referencePrice) || 1,
    });
    const now = this.resolveTimestamp(params.orderbook.time);
    const nextBuckets = this.orderbookToBuckets(state, params.orderbook);
    const dynamicsEvent = this.computeDynamics(
      state.lastOrderBookBuckets.bid,
      state.lastOrderBookBuckets.ask,
      nextBuckets.bid,
      nextBuckets.ask,
    );
    state.lastOrderBookBuckets = nextBuckets;
    state.lastOrderBookTs = now;
    state.lastOrderBook = params.orderbook;
    const referencePrice =
      this.resolveMid(params.orderbook) ||
      this.toPositiveNumber(params.referencePrice);
    for (const periodKey of this.periodList()) {
      const period = state.periods[periodKey];
      this.rollScope(period.rolling, now);
      this.rotateCandleScopeIfNeeded(
        state,
        period,
        periodKey,
        now,
        referencePrice,
        params.profileSummary ?? null,
      );
      period.rolling.dynamics.push({
        ts: now,
        ...dynamicsEvent,
      });
      period.candle.dynamics.push({
        ts: now,
        ...dynamicsEvent,
      });
      const rollingSnapshot = this.buildSnapshot({
        state,
        scope: period.rolling.scope,
        scopeState: period.rolling,
        now,
        referencePrice,
        profileSummary: params.profileSummary ?? null,
        orderbook: params.orderbook,
      });
      const candleSnapshot = this.buildSnapshot({
        state,
        scope: period.candle.scope,
        scopeState: period.candle,
        now,
        referencePrice,
        profileSummary: params.profileSummary ?? null,
        orderbook: params.orderbook,
      });
      state.lastSummaries[period.rolling.scope] = rollingSnapshot.summary;
      state.lastSnapshots[period.rolling.scope] = rollingSnapshot;
      state.lastSummaries[period.candle.scope] = candleSnapshot.summary;
      state.lastSnapshots[period.candle.scope] = candleSnapshot;
      if (period.prevCandleSummary) {
        const prevScope = this.prevScopeForPeriod(periodKey);
        const prevSummary = this.compactCloneSummary(
          period.prevCandleSummary,
          prevScope,
        );
        state.lastSummaries[prevScope] = prevSummary;
        state.lastSnapshots[prevScope] = this.buildCompactSnapshot(
          state.symbol,
          prevSummary,
        );
      }
    }
    return state.lastSummaries;
  }

  getSummaries(params: {
    symbol: string;
    connectorType: ConnectorType;
    marketType: MarketType;
  }): LiquidityMapSummaryByScope {
    const key = this.buildStateKey(
      params.symbol,
      params.connectorType,
      params.marketType,
    );
    return this.states.get(key)?.lastSummaries ?? {};
  }

  getSnapshot(params: {
    symbol: string;
    connectorType: ConnectorType;
    marketType: MarketType;
    scope: LiquidityMapScope;
  }): LiquidityMapSnapshot | null {
    const key = this.buildStateKey(
      params.symbol,
      params.connectorType,
      params.marketType,
    );
    return this.states.get(key)?.lastSnapshots?.[params.scope] ?? null;
  }

  consumePersistRows(now = Date.now()): Array<{
    symbol: string;
    connectorType: ConnectorType;
    marketType: MarketType;
    snapshot: LiquidityMapSnapshot;
  }> {
    const rows: Array<{
      symbol: string;
      connectorType: ConnectorType;
      marketType: MarketType;
      snapshot: LiquidityMapSnapshot;
    }> = [];
    for (const [key, dueAt] of this.persistDue.entries()) {
      if (dueAt > now) continue;
      const state = this.states.get(key);
      if (!state) continue;
      for (const scope of this.persistScopeList()) {
        const snapshot = state.lastSnapshots[scope];
        if (!snapshot) continue;
        rows.push({
          symbol: state.symbol,
          connectorType: state.connectorType,
          marketType: state.marketType,
          snapshot,
        });
      }
      this.persistDue.set(key, now + this.persistIntervalMs);
    }
    return rows;
  }

  private getOrCreateState(params: {
    symbol: string;
    connectorType: ConnectorType;
    marketType: MarketType;
    referencePrice: number;
  }): SymbolState {
    const key = this.buildStateKey(
      params.symbol,
      params.connectorType,
      params.marketType,
    );
    const existing = this.states.get(key);
    if (existing) return existing;
    const priceScale = this.resolvePriceScale(params.referencePrice);
    const rawTick = this.resolvePriceTick(params.referencePrice, priceScale);
    const bucketTicks = Math.max(1, this.bucketTicks);
    const bucketSize = rawTick * bucketTicks;
    const state: SymbolState = {
      symbol: params.symbol,
      connectorType: params.connectorType,
      marketType: params.marketType,
      priceScale,
      bucketTicks,
      bucketSize,
      periods: {
        '30m': this.createPeriod('30m'),
        '4h': this.createPeriod('4h'),
        '24h': this.createPeriod('24h'),
      },
      lastOrderBookBuckets: { bid: new Map(), ask: new Map() },
      lastOrderBookTs: 0,
      lastOrderBook: null,
      lastSummaries: {},
      lastSnapshots: {},
    };
    this.states.set(key, state);
    this.persistDue.set(key, Date.now() + this.persistIntervalMs);
    return state;
  }

  private createPeriod(period: LiquidityPeriodKey): PeriodState {
    const windowMs = this.periodWindowsMs[period];
    const now = Date.now();
    return {
      rolling: this.createScope(
        this.rollingScopeForPeriod(period),
        'rolling',
        windowMs,
        now,
      ),
      candle: this.createScope(
        this.candleScopeForPeriod(period),
        'candle',
        windowMs,
        now,
      ),
      prevCandleSummary: null,
    };
  }

  private createScope(
    scope: LiquidityMapScope,
    mode: 'rolling' | 'candle',
    windowMs: number,
    now: number,
  ): ScopeState {
    return {
      scope,
      mode,
      windowMs,
      windowStart: this.windowStart(now, windowMs),
      buckets: new Map<number, TradeBucket>(),
      events: [],
      dynamics: [],
    };
  }

  private buildSnapshot(params: {
    state: SymbolState;
    scope: LiquidityMapScope;
    scopeState: ScopeState;
    now: number;
    referencePrice: number;
    profileSummary: HorizontalVolumeProfileSummary | null;
    orderbook: OrderBook | null;
  }): LiquidityMapSnapshot {
    const scopeState = params.scopeState;
    // Derive best available reference price: prefer orderbook mid, then passed ref
    const orderbookMid = params.orderbook
      ? this.resolveMid(params.orderbook)
      : 0;
    const referencePrice =
      orderbookMid > 0
        ? orderbookMid
        : params.referencePrice > 0
        ? params.referencePrice
        : 0;
    const profile = this.buildProfileFromBuckets(
      scopeState.buckets,
      params.state.priceScale,
      referencePrice || params.referencePrice,
    );
    const profileFallback = params.profileSummary ?? null;
    const pocPrice = profile.pocPrice ?? profileFallback?.pocPrice ?? null;
    const valueAreaLow =
      profile.valueAreaLow ?? profileFallback?.valueAreaLow ?? null;
    const valueAreaHigh =
      profile.valueAreaHigh ?? profileFallback?.valueAreaHigh ?? null;
    const effectiveRef =
      referencePrice > 0 ? referencePrice : params.referencePrice;
    const nearestHvnAboveDistanceBps = this.distanceBps(
      effectiveRef,
      profile.nearestHvnAbove ??
        profileFallback?.nearestHighVolumeNodeAbove ??
        null,
    );
    const nearestHvnBelowDistanceBps = this.distanceBps(
      effectiveRef,
      profile.nearestHvnBelow ??
        profileFallback?.nearestHighVolumeNodeBelow ??
        null,
    );
    const nearestLvnAboveDistanceBps = this.distanceBps(
      effectiveRef,
      profile.nearestLvnAbove ??
        profileFallback?.nearestLowVolumeNodeAbove ??
        null,
    );
    const nearestLvnBelowDistanceBps = this.distanceBps(
      effectiveRef,
      profile.nearestLvnBelow ??
        profileFallback?.nearestLowVolumeNodeBelow ??
        null,
    );
    const orderbookView = this.analyzeOrderbook(
      params.state,
      params.orderbook,
      effectiveRef,
    );
    const dynamics = this.summarizeDynamics(scopeState, params.now);
    const profileOrderbookAlignmentScore = this.resolveAlignmentScore(
      effectiveRef,
      pocPrice,
      orderbookView.nearestWalls.above?.price ?? null,
      orderbookView.nearestWalls.below?.price ?? null,
    );
    const summary: LiquidityMapSummary = {
      scope: params.scope,
      updatedAt: params.now,
      bucketSize: params.state.bucketSize / params.state.priceScale,
      pocPrice,
      valueAreaLow,
      valueAreaHigh,
      distanceToPocBps: this.distanceBps(effectiveRef, pocPrice),
      distanceToValueAreaLowBps: this.distanceBps(effectiveRef, valueAreaLow),
      distanceToValueAreaHighBps: this.distanceBps(effectiveRef, valueAreaHigh),
      nearestHvnAboveDistanceBps,
      nearestHvnBelowDistanceBps,
      nearestLvnAboveDistanceBps,
      nearestLvnBelowDistanceBps,
      nearestLiquidityWallAboveDistanceBps:
        orderbookView.nearestWalls.above?.distanceBps ?? null,
      nearestLiquidityWallBelowDistanceBps:
        orderbookView.nearestWalls.below?.distanceBps ?? null,
      strongestClusterAboveDistanceBps:
        orderbookView.strongestClusterAboveDistanceBps,
      strongestClusterBelowDistanceBps:
        orderbookView.strongestClusterBelowDistanceBps,
      localOrderbookImbalance: orderbookView.localOrderbookImbalance,
      localBidLiquidityDensity: orderbookView.localBidLiquidityDensity,
      localAskLiquidityDensity: orderbookView.localAskLiquidityDensity,
      thinZoneAboveDistanceBps: orderbookView.thinZoneAboveDistanceBps,
      thinZoneBelowDistanceBps: orderbookView.thinZoneBelowDistanceBps,
      liquidityPullVelocity: dynamics.liquidityPullVelocity,
      liquidityAddVelocity: dynamics.liquidityAddVelocity,
      liquidityConsumeVelocity: dynamics.liquidityConsumeVelocity,
      liquidityInstabilityScore: dynamics.liquidityInstabilityScore,
      localAbsorptionScore: dynamics.localAbsorptionScore,
      localAggressionImbalance: dynamics.localAggressionImbalance,
      liquidityClusterConfluenceScore: this.clamp01(
        this.average([
          this.inverseDistanceScore(
            orderbookView.strongestClusterAboveDistanceBps,
          ),
          this.inverseDistanceScore(
            orderbookView.strongestClusterBelowDistanceBps,
          ),
        ]),
      ),
      liquidityGapPressure: this.clampSigned(
        this.diffOrZero(
          orderbookView.thinZoneAboveDistanceBps,
          orderbookView.thinZoneBelowDistanceBps,
        ),
      ),
      profileOrderbookAlignmentScore,
      currentPriceInValueArea:
        Number.isFinite(valueAreaLow) && Number.isFinite(valueAreaHigh)
          ? effectiveRef >= Number(valueAreaLow) &&
            effectiveRef <= Number(valueAreaHigh)
            ? 1
            : 0
          : 0,
    };
    return {
      symbol: params.state.symbol,
      scope: params.scope,
      updatedAt: params.now,
      summary,
      topClusters: orderbookView.topClusters,
      topGaps: orderbookView.topGaps,
      nearestWalls: orderbookView.nearestWalls,
      dynamics,
    };
  }

  private analyzeOrderbook(
    state: SymbolState,
    orderbook: OrderBook | null,
    referencePrice: number,
  ): {
    localOrderbookImbalance: number;
    localBidLiquidityDensity: number;
    localAskLiquidityDensity: number;
    nearestWalls: {
      above: { price: number; volume: number; distanceBps: number } | null;
      below: { price: number; volume: number; distanceBps: number } | null;
    };
    thinZoneAboveDistanceBps: number | null;
    thinZoneBelowDistanceBps: number | null;
    topClusters: LiquidityCluster[];
    topGaps: LiquidityGap[];
    strongestClusterAboveDistanceBps: number | null;
    strongestClusterBelowDistanceBps: number | null;
  } {
    const bidLevelsRaw =
      orderbook?.bids?.slice(0, this.bookLevels).map((row) => ({
        price: this.toPositiveNumber(row.price),
        volume: this.toPositiveNumber(row.volume),
      })) ?? [];
    const askLevelsRaw =
      orderbook?.asks?.slice(0, this.bookLevels).map((row) => ({
        price: this.toPositiveNumber(row.price),
        volume: this.toPositiveNumber(row.volume),
      })) ?? [];
    // Sort: bids descending (best/highest first), asks ascending (best/lowest first)
    // Exchange depth updates may arrive unsorted — must sort for correct local/wall analysis
    const bidLevels = bidLevelsRaw
      .filter((row) => row.price > 0 && row.volume > 0)
      .sort((a, b) => b.price - a.price);
    const askLevels = askLevelsRaw
      .filter((row) => row.price > 0 && row.volume > 0)
      .sort((a, b) => a.price - b.price);
    const localBid = bidLevels.slice(0, this.localRadiusBuckets);
    const localAsk = askLevels.slice(0, this.localRadiusBuckets);
    const localBidVolume = localBid.reduce(
      (acc, level) => acc + level.volume,
      0,
    );
    const localAskVolume = localAsk.reduce(
      (acc, level) => acc + level.volume,
      0,
    );
    const localDen = localBidVolume + localAskVolume;
    const localOrderbookImbalance =
      localDen > 0 ? (localBidVolume - localAskVolume) / localDen : 0;
    const localBidLiquidityDensity =
      localBid.length > 0 ? localBidVolume / localBid.length : 0;
    const localAskLiquidityDensity =
      localAsk.length > 0 ? localAskVolume / localAsk.length : 0;

    const bidVolumes = bidLevels.map((level) => level.volume);
    const askVolumes = askLevels.map((level) => level.volume);
    const bidWallThreshold = this.quantile(bidVolumes, this.clusterThresholdQ);
    const askWallThreshold = this.quantile(askVolumes, this.clusterThresholdQ);
    const thinBidThreshold = this.quantile(bidVolumes, this.thinThresholdQ);
    const thinAskThreshold = this.quantile(askVolumes, this.thinThresholdQ);

    const nearestBidWall =
      bidLevels.find((level) => level.volume >= bidWallThreshold) ?? null;
    const nearestAskWall =
      askLevels.find((level) => level.volume >= askWallThreshold) ?? null;
    const nearestWalls = {
      above: nearestAskWall
        ? {
            price: nearestAskWall.price,
            volume: nearestAskWall.volume,
            distanceBps:
              this.distanceBps(referencePrice, nearestAskWall.price) ?? 0,
          }
        : null,
      below: nearestBidWall
        ? {
            price: nearestBidWall.price,
            volume: nearestBidWall.volume,
            distanceBps:
              this.distanceBps(referencePrice, nearestBidWall.price) ?? 0,
          }
        : null,
    };
    const thinAbove =
      askLevels.find((level) => level.volume <= thinAskThreshold) ?? null;
    const thinBelow =
      bidLevels.find((level) => level.volume <= thinBidThreshold) ?? null;
    const thinZoneAboveDistanceBps = thinAbove
      ? this.distanceBps(referencePrice, thinAbove.price)
      : null;
    const thinZoneBelowDistanceBps = thinBelow
      ? this.distanceBps(referencePrice, thinBelow.price)
      : null;

    const clusters = [
      ...this.detectClusters(state, askLevels, 'ask', referencePrice),
      ...this.detectClusters(state, bidLevels, 'bid', referencePrice),
    ]
      .sort((a, b) => b.totalVolume - a.totalVolume)
      .slice(0, 6);
    const topGaps = [
      ...this.detectGaps(askLevels, 'above', referencePrice),
      ...this.detectGaps(bidLevels, 'below', referencePrice),
    ]
      .sort((a, b) => a.distanceBps - b.distanceBps)
      .slice(0, 6);
    const strongestClusterAbove = clusters
      .filter((cluster) => cluster.side === 'ask')
      .sort((a, b) => b.totalVolume - a.totalVolume)[0];
    const strongestClusterBelow = clusters
      .filter((cluster) => cluster.side === 'bid')
      .sort((a, b) => b.totalVolume - a.totalVolume)[0];
    return {
      localOrderbookImbalance,
      localBidLiquidityDensity,
      localAskLiquidityDensity,
      nearestWalls,
      thinZoneAboveDistanceBps,
      thinZoneBelowDistanceBps,
      topClusters: clusters,
      topGaps,
      strongestClusterAboveDistanceBps:
        strongestClusterAbove?.distanceBps ?? null,
      strongestClusterBelowDistanceBps:
        strongestClusterBelow?.distanceBps ?? null,
    };
  }

  private detectClusters(
    state: SymbolState,
    levels: Array<{ price: number; volume: number }>,
    side: 'bid' | 'ask',
    referencePrice: number,
  ): LiquidityCluster[] {
    if (levels.length === 0) return [];
    const threshold = this.quantile(
      levels.map((level) => level.volume),
      this.clusterThresholdQ,
    );
    const clusters: LiquidityCluster[] = [];
    let current: Array<{ price: number; volume: number }> = [];
    const flush = () => {
      if (current.length === 0) return;
      const totalVolume = current.reduce((acc, row) => acc + row.volume, 0);
      const center =
        current[Math.floor(current.length / 2)]?.price ?? current[0]!.price;
      clusters.push({
        priceStart: current[0]!.price,
        priceEnd: current[current.length - 1]!.price,
        totalVolume,
        side,
        distanceBps: this.distanceBps(referencePrice, center),
      });
      current = [];
    };
    for (let i = 0; i < levels.length; i += 1) {
      const row = levels[i]!;
      const prev = i > 0 ? levels[i - 1]! : null;
      const bucket = this.priceToBucket(
        row.price,
        state.priceScale,
        state.bucketSize,
      );
      const prevBucket = prev
        ? this.priceToBucket(prev.price, state.priceScale, state.bucketSize)
        : null;
      const contiguous =
        prevBucket !== null &&
        Math.abs(bucket - prevBucket) <= state.bucketSize;
      if (row.volume >= threshold) {
        if (!contiguous) flush();
        current.push(row);
      } else {
        flush();
      }
    }
    flush();
    return clusters;
  }

  private detectGaps(
    levels: Array<{ price: number; volume: number }>,
    side: 'above' | 'below',
    referencePrice: number,
  ): LiquidityGap[] {
    if (levels.length < 2) return [];
    const volumes = levels.map((level) => level.volume);
    const thinThreshold = this.quantile(volumes, this.thinThresholdQ);
    const gaps: LiquidityGap[] = [];
    for (let i = 1; i < levels.length; i += 1) {
      const prev = levels[i - 1]!;
      const curr = levels[i]!;
      if (prev.volume > thinThreshold && curr.volume > thinThreshold) continue;
      const low = Math.min(prev.price, curr.price);
      const high = Math.max(prev.price, curr.price);
      gaps.push({
        priceStart: low,
        priceEnd: high,
        side,
        distanceBps:
          this.distanceBps(referencePrice, side === 'above' ? low : high) ??
          Number.POSITIVE_INFINITY,
      });
    }
    return gaps;
  }

  private summarizeDynamics(
    scope: ScopeState,
    now: number,
  ): LiquidityDynamicsSummary {
    const minTs =
      scope.mode === 'rolling' ? now - scope.windowMs : scope.windowStart;
    const rows = scope.dynamics.filter((event) => event.ts >= minTs);
    const secondsDenominator =
      scope.mode === 'rolling'
        ? Math.max(1, scope.windowMs / 1000)
        : Math.max(1, (now - scope.windowStart) / 1000);
    const secs = secondsDenominator;
    const added = rows.reduce((acc, row) => acc + row.added, 0) / secs;
    const pulled = rows.reduce((acc, row) => acc + row.pulled, 0) / secs;
    const consumed = rows.reduce((acc, row) => acc + row.consumed, 0) / secs;
    const restack = rows.reduce((acc, row) => acc + row.restack, 0) / secs;
    const instabilityDen = added + pulled + consumed + 1e-6;
    // restack is in price units (absolute center shift) — exclude from volume-based instability
    const instability = this.clamp01((pulled + consumed) / instabilityDen);
    const absorption = this.clamp01(consumed / (added + 1e-6));
    const aggression = this.clampSigned(
      (consumed - added) / (consumed + added + 1e-6),
    );
    return {
      liquidityAddVelocity: added,
      liquidityPullVelocity: pulled,
      liquidityConsumeVelocity: consumed,
      liquidityInstabilityScore: instability,
      localAbsorptionScore: absorption,
      localAggressionImbalance: aggression,
    };
  }

  private computeDynamics(
    prevBid: Map<number, number>,
    prevAsk: Map<number, number>,
    nextBid: Map<number, number>,
    nextAsk: Map<number, number>,
  ): { added: number; pulled: number; consumed: number; restack: number } {
    let added = 0;
    let pulled = 0;
    let consumed = 0;
    let restack = 0;
    const allBidKeys = new Set<number>([...prevBid.keys(), ...nextBid.keys()]);
    for (const key of allBidKeys) {
      const before = prevBid.get(key) ?? 0;
      const after = nextBid.get(key) ?? 0;
      const diff = after - before;
      if (diff > 0) added += diff;
      if (diff < 0) pulled += Math.abs(diff);
      if (before > 0 && after === 0) consumed += before;
    }
    const allAskKeys = new Set<number>([...prevAsk.keys(), ...nextAsk.keys()]);
    for (const key of allAskKeys) {
      const before = prevAsk.get(key) ?? 0;
      const after = nextAsk.get(key) ?? 0;
      const diff = after - before;
      if (diff > 0) added += diff;
      if (diff < 0) pulled += Math.abs(diff);
      if (before > 0 && after === 0) consumed += before;
    }
    const prevCenter = this.weightedCenter(prevBid, prevAsk);
    const nextCenter = this.weightedCenter(nextBid, nextAsk);
    if (
      Number.isFinite(prevCenter) &&
      Number.isFinite(nextCenter) &&
      prevCenter > 0
    ) {
      // Normalize to relative shift (fraction of center price) so restack is dimensionless
      restack = Math.abs(nextCenter - prevCenter) / prevCenter;
    }
    return { added, pulled, consumed, restack };
  }

  private weightedCenter(
    bid: Map<number, number>,
    ask: Map<number, number>,
  ): number {
    let num = 0;
    let den = 0;
    for (const [price, volume] of bid.entries()) {
      num += price * volume;
      den += volume;
    }
    for (const [price, volume] of ask.entries()) {
      num += price * volume;
      den += volume;
    }
    return den > 0 ? num / den : 0;
  }

  private orderbookToBuckets(
    state: SymbolState,
    orderbook: OrderBook,
  ): { bid: Map<number, number>; ask: Map<number, number> } {
    const bid = new Map<number, number>();
    const ask = new Map<number, number>();
    for (const row of (orderbook.bids ?? []).slice(0, this.bookLevels)) {
      const price = this.toPositiveNumber(row.price);
      const volume = this.toPositiveNumber(row.volume);
      if (!(price > 0) || !(volume > 0)) continue;
      const key = this.priceToBucket(price, state.priceScale, state.bucketSize);
      bid.set(key, (bid.get(key) ?? 0) + volume);
    }
    for (const row of (orderbook.asks ?? []).slice(0, this.bookLevels)) {
      const price = this.toPositiveNumber(row.price);
      const volume = this.toPositiveNumber(row.volume);
      if (!(price > 0) || !(volume > 0)) continue;
      const key = this.priceToBucket(price, state.priceScale, state.bucketSize);
      ask.set(key, (ask.get(key) ?? 0) + volume);
    }
    return { bid, ask };
  }

  private buildProfileFromBuckets(
    buckets: Map<number, TradeBucket>,
    scale: number,
    referencePrice: number,
  ): {
    pocPrice: number | null;
    valueAreaLow: number | null;
    valueAreaHigh: number | null;
    nearestHvnAbove: number | null;
    nearestHvnBelow: number | null;
    nearestLvnAbove: number | null;
    nearestLvnBelow: number | null;
  } {
    const rows = Array.from(buckets.entries())
      .map(([bucket, value]) => ({
        price: bucket / scale,
        totalVolume: value.totalVolume,
      }))
      .sort((a, b) => a.price - b.price);
    if (rows.length === 0) {
      return {
        pocPrice: null,
        valueAreaLow: null,
        valueAreaHigh: null,
        nearestHvnAbove: null,
        nearestHvnBelow: null,
        nearestLvnAbove: null,
        nearestLvnBelow: null,
      };
    }
    const total = rows.reduce((acc, row) => acc + row.totalVolume, 0);
    const poc = rows.slice().sort((a, b) => b.totalVolume - a.totalVolume)[0]!;
    const pocIndex = rows.findIndex((row) => row.price === poc.price);
    let left = pocIndex;
    let right = pocIndex;
    let covered = rows[pocIndex]!.totalVolume;
    const target = total * 0.7;
    while (covered < target && (left > 0 || right < rows.length - 1)) {
      const leftNext = left > 0 ? rows[left - 1] : null;
      const rightNext = right < rows.length - 1 ? rows[right + 1] : null;
      const leftVolume = leftNext?.totalVolume ?? -1;
      const rightVolume = rightNext?.totalVolume ?? -1;
      if (rightVolume > leftVolume) {
        right += 1;
        covered += rows[right]!.totalVolume;
      } else if (leftNext) {
        left -= 1;
        covered += rows[left]!.totalVolume;
      } else if (rightNext) {
        right += 1;
        covered += rows[right]!.totalVolume;
      } else {
        break;
      }
    }
    const high = this.quantile(
      rows.map((row) => row.totalVolume),
      0.75,
    );
    const low = this.quantile(
      rows.map((row) => row.totalVolume),
      0.25,
    );
    const nearestHvnAbove =
      rows.find((row) => row.price > referencePrice && row.totalVolume >= high)
        ?.price ?? null;
    const nearestHvnBelow =
      rows
        .slice()
        .reverse()
        .find((row) => row.price < referencePrice && row.totalVolume >= high)
        ?.price ?? null;
    const nearestLvnAbove =
      rows.find((row) => row.price > referencePrice && row.totalVolume <= low)
        ?.price ?? null;
    const nearestLvnBelow =
      rows
        .slice()
        .reverse()
        .find((row) => row.price < referencePrice && row.totalVolume <= low)
        ?.price ?? null;
    return {
      pocPrice: poc.price,
      valueAreaLow: rows[left]?.price ?? null,
      valueAreaHigh: rows[right]?.price ?? null,
      nearestHvnAbove,
      nearestHvnBelow,
      nearestLvnAbove,
      nearestLvnBelow,
    };
  }

  private rollScope(scope: ScopeState, now: number): void {
    if (scope.mode !== 'rolling') return;
    const minTs = now - scope.windowMs;
    while (scope.events.length > 0 && scope.events[0]!.ts < minTs) {
      const event = scope.events.shift()!;
      const bucket = scope.buckets.get(event.bucket);
      if (!bucket) continue;
      bucket.buyVolume = Math.max(0, bucket.buyVolume - event.buyVolume);
      bucket.sellVolume = Math.max(0, bucket.sellVolume - event.sellVolume);
      bucket.totalVolume = Math.max(
        0,
        bucket.totalVolume - event.buyVolume - event.sellVolume,
      );
      bucket.tradeCount = Math.max(0, bucket.tradeCount - 1);
      if (bucket.totalVolume <= 0 || bucket.tradeCount <= 0) {
        scope.buckets.delete(event.bucket);
      } else {
        scope.buckets.set(event.bucket, bucket);
      }
    }
    while (scope.dynamics.length > 0 && scope.dynamics[0]!.ts < minTs) {
      scope.dynamics.shift();
    }
  }

  private rotateCandleScopeIfNeeded(
    state: SymbolState,
    period: PeriodState,
    periodKey: LiquidityPeriodKey,
    now: number,
    referencePrice: number,
    profileSummary: HorizontalVolumeProfileSummary | null,
  ): void {
    const nextWindowStart = this.windowStart(now, period.candle.windowMs);
    if (period.candle.windowStart === nextWindowStart) return;
    const prevSummary = state.lastSummaries[period.candle.scope];
    if (prevSummary) {
      period.prevCandleSummary = this.compactCloneSummary(
        prevSummary,
        this.prevScopeForPeriod(periodKey),
      );
    } else if (
      period.candle.events.length > 0 ||
      period.candle.dynamics.length > 0
    ) {
      const snapshot = this.buildSnapshot({
        state,
        scope: period.candle.scope,
        scopeState: period.candle,
        now,
        referencePrice,
        profileSummary,
        orderbook: null,
      });
      period.prevCandleSummary = this.compactCloneSummary(
        snapshot.summary,
        this.prevScopeForPeriod(periodKey),
      );
    }
    this.resetScope(period.candle, nextWindowStart);
  }

  private resetScope(scope: ScopeState, nextWindowStart: number): void {
    scope.windowStart = nextWindowStart;
    scope.buckets.clear();
    scope.events = [];
    scope.dynamics = [];
  }

  private applyTradeEvent(
    scope: ScopeState,
    now: number,
    bucket: number,
    tradeVolume: number,
    isBuy: boolean,
  ): void {
    const current = scope.buckets.get(bucket) ?? {
      buyVolume: 0,
      sellVolume: 0,
      totalVolume: 0,
      tradeCount: 0,
    };
    if (isBuy) current.buyVolume += tradeVolume;
    else current.sellVolume += tradeVolume;
    current.totalVolume += tradeVolume;
    current.tradeCount += 1;
    scope.buckets.set(bucket, current);
    scope.events.push({
      ts: now,
      bucket,
      buyVolume: isBuy ? tradeVolume : 0,
      sellVolume: isBuy ? 0 : tradeVolume,
    });
  }

  private pruneBuckets(scope: ScopeState, current: number): void {
    if (scope.buckets.size <= this.maxBucketsPerScope) return;
    const removable = Array.from(scope.buckets.entries())
      .map(([bucket, value]) => ({
        bucket,
        volume: value.totalVolume,
        distance: Math.abs(bucket - current),
      }))
      .sort((a, b) => {
        if (a.volume !== b.volume) return a.volume - b.volume;
        return b.distance - a.distance;
      });
    while (
      scope.buckets.size > this.maxBucketsPerScope &&
      removable.length > 0
    ) {
      const next = removable.shift();
      if (!next) break;
      scope.buckets.delete(next.bucket);
    }
  }

  private getLastSummaries(
    symbol: string,
    connectorType: ConnectorType,
    marketType: MarketType,
  ): LiquidityMapSummaryByScope {
    const key = this.buildStateKey(symbol, connectorType, marketType);
    return this.states.get(key)?.lastSummaries ?? {};
  }

  private periodList(): LiquidityPeriodKey[] {
    return ['30m', '4h', '24h'];
  }

  private persistScopeList(): LiquidityMapScope[] {
    return [
      'rolling_30m',
      'candle_30m',
      'rolling_4h',
      'candle_4h',
      'rolling_24h',
      'candle_24h',
    ];
  }

  private rollingScopeForPeriod(period: LiquidityPeriodKey): LiquidityMapScope {
    if (period === '30m') return 'rolling_30m';
    if (period === '4h') return 'rolling_4h';
    return 'rolling_24h';
  }

  private candleScopeForPeriod(period: LiquidityPeriodKey): LiquidityMapScope {
    if (period === '30m') return 'candle_30m';
    if (period === '4h') return 'candle_4h';
    return 'candle_24h';
  }

  private prevScopeForPeriod(period: LiquidityPeriodKey): LiquidityMapScope {
    if (period === '30m') return 'prev_candle_30m';
    if (period === '4h') return 'prev_candle_4h';
    return 'prev_candle_24h';
  }

  private compactCloneSummary(
    summary: LiquidityMapSummary,
    scope: LiquidityMapScope,
  ): LiquidityMapSummary {
    return {
      ...summary,
      scope,
    };
  }

  private buildCompactSnapshot(
    symbol: string,
    summary: LiquidityMapSummary,
  ): LiquidityMapSnapshot {
    return {
      symbol,
      scope: summary.scope,
      updatedAt: summary.updatedAt,
      summary,
      topClusters: [],
      topGaps: [],
      nearestWalls: {
        above: null,
        below: null,
      },
      dynamics: {
        liquidityAddVelocity: summary.liquidityAddVelocity,
        liquidityPullVelocity: summary.liquidityPullVelocity,
        liquidityConsumeVelocity: summary.liquidityConsumeVelocity,
        liquidityInstabilityScore: summary.liquidityInstabilityScore,
        localAbsorptionScore: summary.localAbsorptionScore,
        localAggressionImbalance: summary.localAggressionImbalance,
      },
    };
  }

  private windowStart(ts: number, windowMs: number): number {
    return Math.floor(ts / windowMs) * windowMs;
  }

  private buildStateKey(
    symbol: string,
    connectorType: ConnectorType,
    marketType: MarketType,
  ): string {
    return `${String(connectorType)}:${String(marketType)}:${String(
      symbol,
    ).toUpperCase()}`;
  }

  private priceToBucket(
    price: number,
    scale: number,
    bucketSize: number,
  ): number {
    const scaled = Math.round(price * scale);
    return Math.round(scaled / bucketSize) * bucketSize;
  }

  private resolvePriceTick(price: number, scale: number): number {
    const bpsStep = this.bucketBps / 10_000;
    const raw = Math.max(1 / scale, price * bpsStep);
    return Math.max(1, Math.round(raw * scale));
  }

  private resolvePriceScale(price: number): number {
    if (price >= 10_000) return 1;
    if (price >= 1_000) return 10;
    if (price >= 100) return 100;
    if (price >= 1) return 1000;
    return 10_000;
  }

  private resolveMid(orderbook: OrderBook): number {
    // Exchange depth updates are NOT sorted — find actual best bid (max) and ask (min)
    let bestBid = 0;
    let bestAsk = Infinity;
    for (const row of orderbook.bids ?? []) {
      const p = this.toPositiveNumber(row.price);
      if (p > bestBid) bestBid = p;
    }
    for (const row of orderbook.asks ?? []) {
      const p = this.toPositiveNumber(row.price);
      if (p > 0 && p < bestAsk) bestAsk = p;
    }
    if (bestBid > 0 && bestAsk < Infinity && bestAsk >= bestBid)
      return (bestBid + bestAsk) / 2;
    return 0;
  }

  private distanceBps(
    referencePrice: number,
    levelPrice: number | null,
  ): number | null {
    if (!(referencePrice > 0) || !Number.isFinite(levelPrice)) return null;
    return (
      (Math.abs(Number(levelPrice) - referencePrice) / referencePrice) * 10_000
    );
  }

  private resolveAlignmentScore(
    referencePrice: number,
    poc: number | null,
    wallAbove: number | null,
    wallBelow: number | null,
  ): number {
    const pocDist = this.distanceBps(referencePrice, poc);
    const aboveDist = this.distanceBps(referencePrice, wallAbove);
    const belowDist = this.distanceBps(referencePrice, wallBelow);
    return this.clamp01(
      this.average([
        this.inverseDistanceScore(pocDist),
        this.inverseDistanceScore(aboveDist),
        this.inverseDistanceScore(belowDist),
      ]),
    );
  }

  private inverseDistanceScore(distanceBps: number | null): number {
    if (!Number.isFinite(distanceBps)) return 0;
    return this.clamp01(1 - Number(distanceBps) / 150);
  }

  private average(values: Array<number | null>): number {
    const finite = values.filter((value): value is number =>
      Number.isFinite(value),
    );
    if (finite.length === 0) return 0;
    return finite.reduce((acc, value) => acc + value, 0) / finite.length;
  }

  private diffOrZero(a: number | null, b: number | null): number {
    const x = Number.isFinite(a) ? Number(a) : 0;
    const y = Number.isFinite(b) ? Number(b) : 0;
    if (x <= 0 && y <= 0) return 0;
    return (y - x) / Math.max(x + y, 1);
  }

  private quantile(values: number[], q: number): number {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = Math.max(
      0,
      Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)),
    );
    return sorted[idx] ?? 0;
  }

  private toPositiveNumber(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  private resolveTimestamp(value: unknown): number {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
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

  private readClamp(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }

  private clampSigned(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(-1, Math.min(1, value));
  }

  clearSymbolState(
    symbol: string,
    connectorType: ConnectorType,
    marketType: MarketType,
  ): void {
    const key = this.buildStateKey(symbol, connectorType, marketType);
    this.states.delete(key);
    this.persistDue.delete(key);
  }

  clearAllStates(): void {
    this.states.clear();
    this.persistDue.clear();
  }
}
