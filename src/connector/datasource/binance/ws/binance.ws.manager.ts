import { Injectable, Logger } from '@nestjs/common';
import {
  MarketType,
  TradingSymbol,
  TimeFrame,
  SubscriptionType,
  SubscriptionValue,
  ConnectorType,
} from '@barfinex/types';
import { WebSocketService } from '../../websocket.service';
import { convertTimeFrame } from '../utils/timeframe.converter';
import { BinanceClientService } from '../core/binance.client';
import { ProviderMarketdataMetricsService } from '../../../../runtime/provider-marketdata-metrics.service';
import { ms as timeframeMs } from '../../../../candle/time/time.utils';
import { normalizeTradingSymbol } from '../../../../connector/utils/trading-symbol-sanitizer';

type UnsubscribeFn = () => void;
type StreamType = 'candles' | 'orderbook' | 'trades' | 'symbolPrices';

type StreamStatus = {
  connected: boolean;
  streamType: StreamType;
  marketType: MarketType;
  lastMessageAt: number;
  reconnectCount: number;
};

@Injectable()
export class BinanceWsManager {
  private readonly logger = new Logger(BinanceWsManager.name);
  private readonly wsDebugEnabled = process.env.BINANCE_WS_DEBUG === 'true';
  private readonly accountPayloadWarnSizeBytes = 100_000;
  private readonly accountPayloadLogThrottleMs = Math.max(
    1_000,
    Number(process.env.ACCOUNT_PAYLOAD_LOG_THROTTLE_MS || 5_000),
  );
  private readonly wsEventStatsLogIntervalMs = Math.max(
    1_000,
    Number(process.env.BINANCE_WS_EVENT_STATS_LOG_INTERVAL_MS || 5_000),
  );
  private readonly streamStallThresholdDefaultMs = Math.max(
    1000,
    Number(process.env.BINANCE_WS_STALL_THRESHOLD_MS || 5_000),
  );
  private readonly streamStallThresholdMsByType: Record<StreamType, number> = {
    candles: Math.max(
      1000,
      Number(
        process.env.BINANCE_WS_STALL_THRESHOLD_CANDLES_MS ||
          this.streamStallThresholdDefaultMs,
      ),
    ),
    orderbook: Math.max(
      1000,
      Number(
        process.env.BINANCE_WS_STALL_THRESHOLD_ORDERBOOK_MS ||
          this.streamStallThresholdDefaultMs,
      ),
    ),
    trades: Math.max(
      1000,
      Number(
        process.env.BINANCE_WS_STALL_THRESHOLD_TRADES_MS ||
          this.streamStallThresholdDefaultMs,
      ),
    ),
    symbolPrices: Math.max(
      1000,
      Number(
        process.env.BINANCE_WS_STALL_THRESHOLD_SYMBOLPRICES_MS ||
          this.streamStallThresholdDefaultMs,
      ),
    ),
  };
  private readonly streamStallCheckMs = Math.max(
    500,
    Number(process.env.BINANCE_WS_STALL_CHECK_INTERVAL_MS || 1_000),
  );
  private readonly streamStallCooldownMs = Math.max(
    1_000,
    Number(process.env.BINANCE_WS_STALL_COOLDOWN_MS || 10_000),
  );
  private readonly reconnectBaseDelayMs = Math.max(
    200,
    Number(
      process.env.BINANCE_WS_RECONNECT_BASE_DELAY_MS ||
        process.env.BINANCE_WS_WATCHDOG_RECONNECT_BASE_DELAY_MS ||
        1_000,
    ),
  );
  private readonly reconnectMaxDelayMs = Math.max(
    this.reconnectBaseDelayMs,
    Number(process.env.BINANCE_WS_RECONNECT_MAX_DELAY_MS || 30_000),
  );
  private readonly reconnectJitterMs = Math.max(
    0,
    Number(
      process.env.BINANCE_WS_RECONNECT_JITTER_MS ||
        process.env.BINANCE_WS_WATCHDOG_RECONNECT_JITTER_MS ||
        1_500,
    ),
  );
  private readonly stallWarnThrottleMs = Math.max(
    1_000,
    Number(process.env.BINANCE_WS_STALL_WARN_THROTTLE_MS || 10_000),
  );
  private streamSeq = 0;
  private readonly streamStatus = new Map<string, StreamStatus>();
  private readonly lastAccountPayloadLogAtByMarket = new Map<
    MarketType,
    number
  >();
  private wsEventWindowStartedAt = Date.now();
  private wsEventsByStream: Record<StreamType, number> = {
    candles: 0,
    orderbook: 0,
    trades: 0,
    symbolPrices: 0,
  };
  // ======================================================
  // 🔹 READY BARRIER
  // ======================================================
  private ready = false;
  private initializing = false;

  private readyPromise: Promise<void>;
  private resolveReady!: () => void;

  constructor(
    private readonly clientService: BinanceClientService,
    private readonly webSocketService: WebSocketService,
    private readonly marketdataMetrics: ProviderMarketdataMetricsService,
  ) {
    this.readyPromise = new Promise<void>((res) => {
      this.resolveReady = res;
    });
  }

  // ======================================================
  // 🔹 INIT / READY
  // ======================================================
  private async init(): Promise<void> {
    if (this.ready) return;
    if (this.initializing) return this.readyPromise;

    this.initializing = true;

    // 🔥 ГАРАНТИРУЕМ: REST готов
    await this.clientService.ensureReady();

    if (!this.clientService.api) {
      this.initializing = false;
      throw new Error(
        '[BinanceWsManager] Binance REST api is not available after ensureReady',
      );
    }

    this.ready = true;
    this.resolveReady();
    this.initializing = false;
  }

  async ensureReady(): Promise<void> {
    if (!this.ready) {
      await this.init();
    }

    await this.readyPromise;
  }

  // ======================================================
  // 🔹 INTERNAL
  // ======================================================
  private get api(): any {
    if (!this.clientService.api) {
      throw new Error('[BinanceWsManager] Binance api is not initialized');
    }
    return this.clientService.api;
  }

  getStreamHealth() {
    const streams = Array.from(this.streamStatus.entries()).map(
      ([streamId, state]) => ({
        streamId,
        ...state,
        stallThresholdMs: this.getStallThresholdMs(state.streamType),
        lastMessageAgeMs: Math.max(0, Date.now() - state.lastMessageAt),
      }),
    );
    return {
      connected: streams.filter((s) => s.connected).length,
      total: streams.length,
      stallThresholdMs: this.streamStallThresholdDefaultMs,
      stallThresholdByStreamMs: this.streamStallThresholdMsByType,
      streams,
    };
  }

  private getStallThresholdMs(streamType: StreamType): number {
    return (
      this.streamStallThresholdMsByType[streamType] ||
      this.streamStallThresholdDefaultMs
    );
  }

  private getReconnectDelayWithBackoffMs(attempt: number): number {
    const boundedAttempt = Math.max(1, attempt);
    const baseDelayMs = Math.min(
      this.reconnectBaseDelayMs * Math.pow(2, Math.min(boundedAttempt - 1, 8)),
      this.reconnectMaxDelayMs,
    );
    if (this.reconnectJitterMs <= 0) return baseDelayMs;
    const jitterMs = Math.floor(Math.random() * (this.reconnectJitterMs + 1));
    return Math.min(this.reconnectMaxDelayMs, baseDelayMs + jitterMs);
  }

  private getCandleStallThresholdMs(
    interval: TimeFrame,
    configuredThresholdMs: number,
  ): number {
    const naturalCadenceMs = timeframeMs(interval);
    const lowFrequencySafeThresholdMs = Math.ceil(naturalCadenceMs * 1.2);
    return Math.max(configuredThresholdMs, lowFrequencySafeThresholdMs);
  }

  private nextStreamId(streamType: StreamType, marketType: MarketType): string {
    this.streamSeq += 1;
    return `${streamType}:${marketType}:${this.streamSeq}`;
  }

  private registerStream(
    streamId: string,
    streamType: StreamType,
    marketType: MarketType,
  ): void {
    this.streamStatus.set(streamId, {
      connected: false,
      streamType,
      marketType,
      lastMessageAt: Date.now(),
      reconnectCount: 0,
    });
  }

  private touchStream(
    streamId: string,
    streamType: StreamType,
    marketType: MarketType,
  ): void {
    const current = this.streamStatus.get(streamId);
    this.streamStatus.set(streamId, {
      connected: true,
      streamType,
      marketType,
      lastMessageAt: Date.now(),
      reconnectCount: current?.reconnectCount ?? 0,
    });
  }

  private markStreamReconnecting(streamId: string): void {
    const state = this.streamStatus.get(streamId);
    if (!state) return;
    this.streamStatus.set(streamId, {
      ...state,
      connected: false,
      reconnectCount: state.reconnectCount + 1,
    });
  }

  private clearStream(streamId: string): void {
    this.streamStatus.delete(streamId);
  }

  private recordWsEvent(streamType: StreamType): void {
    this.wsEventsByStream[streamType] += 1;
    this.logWsEventSummaryIfDue();
  }

  private logWsEventSummaryIfDue(force = false): void {
    const now = Date.now();
    const elapsedMs = now - this.wsEventWindowStartedAt;
    if (!force && elapsedMs < this.wsEventStatsLogIntervalMs) return;
    const elapsedSec = Math.max(1, elapsedMs / 1000);
    const candles = this.wsEventsByStream.candles;
    const trades = this.wsEventsByStream.trades;
    const orderbook = this.wsEventsByStream.orderbook;
    const symbolPrices = this.wsEventsByStream.symbolPrices;
    this.wsEventWindowStartedAt = now;
    this.wsEventsByStream = {
      candles: 0,
      trades: 0,
      orderbook: 0,
      symbolPrices: 0,
    };
    if (candles + trades + orderbook + symbolPrices === 0) return;
    this.logger.log(
      `[BINANCE WS] aggregate candles_events_per_sec=${(
        candles / elapsedSec
      ).toFixed(1)} ` +
        `trades_events_per_sec=${(trades / elapsedSec).toFixed(1)} ` +
        `orderbook_events_per_sec=${(orderbook / elapsedSec).toFixed(1)} ` +
        `symbol_prices_events_per_sec=${(symbolPrices / elapsedSec).toFixed(
          1,
        )} ` +
        `window_ms=${elapsedMs}`,
    );
  }

  private safeUnsubscribe(unsubscribe?: any): void {
    if (typeof unsubscribe !== 'function') return;
    try {
      unsubscribe({
        delay: 0,
        fastClose: true,
        keepClosed: true,
      });
    } catch {
      // Best-effort unsubscribe during reconnect/shutdown.
    }
  }

  private createSerializedHandler(
    streamId: string,
    streamType: StreamType,
    marketType: MarketType,
    handler: (data: any) => Promise<void> | void,
  ): (data: any) => void {
    let chain = Promise.resolve();
    return (data: any) => {
      // Measure lag immediately at WS arrival time, not at processing time
      this.marketdataMetrics.observeMarketDataLag(
        streamType,
        marketType,
        this.extractEventTimestampMs(data),
      );
      chain = chain
        .then(async () => {
          this.recordWsEvent(streamType);
          this.touchStream(streamId, streamType, marketType);
          await handler(data);
        })
        .catch((error) => {
          this.logger.warn(
            `[BINANCE WS] handler_error stream=${streamId} type=${streamType}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    };
  }

  /**
   * Periodic-drain handler for high-throughput streams (trades, orderbook).
   * Keeps only the latest message per symbol. A setInterval drains
   * accumulated messages every DRAIN_INTERVAL_MS. No promise chain,
   * no concurrent flood — just one sequential drain per tick.
   * Lag is measured at WS arrival time so the metric is always accurate.
   */
  private static readonly DRAIN_INTERVAL_MS = 200;

  private createPeriodicDrainHandler(
    streamId: string,
    streamType: StreamType,
    marketType: MarketType,
    handler: (data: any) => Promise<void> | void,
  ): { callback: (data: any) => void; dispose: () => void } {
    const pending = new Map<string, any>();
    let draining = false;

    const resolveSymbolKey = (data: any): string => {
      const s = data?.symbol ?? data?.s ?? '';
      return typeof s === 'object' ? String(s?.name ?? '') : String(s);
    };

    const drain = async () => {
      if (draining || pending.size === 0) return;
      draining = true;
      try {
        const batch = new Map(pending);
        pending.clear();
        for (const [, data] of batch) {
          this.recordWsEvent(streamType);
          this.touchStream(streamId, streamType, marketType);
          try {
            await handler(data);
          } catch (error) {
            this.logger.warn(
              `[BINANCE WS] handler_error stream=${streamId} type=${streamType}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      } finally {
        draining = false;
      }
    };

    const timer = setInterval(() => {
      void drain();
    }, BinanceWsManager.DRAIN_INTERVAL_MS);

    const callback = (data: any) => {
      this.marketdataMetrics.observeMarketDataLag(
        streamType,
        marketType,
        this.extractEventTimestampMs(data),
      );
      const key = resolveSymbolKey(data) || '__default__';
      pending.set(key, data);
    };

    const dispose = () => {
      clearInterval(timer);
    };

    return { callback, dispose };
  }

  private extractEventTimestampMs(data: any): number | undefined {
    const candidates = [
      data?.eventTime,
      data?.E,
      data?.T,
      data?.k?.t,
      data?.k?.T,
      data?.timestamp,
      data?.ts,
      data?.time,
    ];
    for (const candidate of candidates) {
      const ts = Number(candidate);
      if (Number.isFinite(ts) && ts > 0) {
        return ts;
      }
    }
    return undefined;
  }

  private logTopicDiagnostics(
    marketType: MarketType,
    symbols: Array<{ name?: string } | string>,
    topics: string[],
  ): void {
    const symbolSourceList = symbols
      .map((s) => (typeof s === 'string' ? s : String(s?.name ?? '')))
      .filter((s) => s.length > 0);
    if (this.wsDebugEnabled) {
      this.logger.debug(
        `[BINANCE WS] market=${marketType} symbols=${symbolSourceList.join(
          ',',
        )} topics=${topics.join(',')}`,
      );
    }
    const invalidTopics = topics.filter((topic) => !this.isValidWsTopic(topic));
    for (const invalidTopic of invalidTopics) {
      this.logger.warn(`[BinanceWsWarning] invalid_topic=${invalidTopic}`);
    }
  }

  private isValidWsTopic(topic: string): boolean {
    const [symbolPart, channelPart] = topic.split('@');
    if (!symbolPart || !channelPart) return false;
    if (!/^[a-z0-9]+$/i.test(symbolPart)) return false;
    if (!/^[a-z]+[a-z0-9_]*$/i.test(channelPart)) return false;
    // Typical Binance symbols are pairs, this helps detect malformed topics like "usdt@aggTrade".
    return symbolPart.length >= 5;
  }

  private logRemovedInvalidSymbols(
    rawSymbols: string[],
    validSymbols: string[],
  ): void {
    const validSet = new Set(validSymbols);
    const removed = Array.from(
      new Set(
        rawSymbols
          .map((s) => normalizeTradingSymbol(s))
          .filter((s) => s.length > 0 && !validSet.has(s)),
      ),
    );
    if (removed.length > 0) {
      this.logger.warn(
        `[BinanceSymbolFilter] removed_invalid_symbols=${removed.join(',')}`,
      );
    }
  }

  private toFiniteNumber(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  private filterActiveFuturesPositions(positions: any[]): any[] {
    return positions.filter((position) => {
      const positionAmt = this.toFiniteNumber(
        position?.positionAmt ?? position?.positionAmount ?? position?.quantity,
      );
      return Math.abs(positionAmt) > 0;
    });
  }

  private filterActiveFuturesAssets(assets: any[]): any[] {
    return assets.filter((asset) => {
      const walletBalance = this.toFiniteNumber(
        asset?.walletBalance ?? asset?.balance,
      );
      const availableBalance = this.toFiniteNumber(asset?.availableBalance);
      const crossWalletBalance = this.toFiniteNumber(asset?.crossWalletBalance);
      return (
        Math.abs(walletBalance) > 0 ||
        Math.abs(availableBalance) > 0 ||
        Math.abs(crossWalletBalance) > 0
      );
    });
  }

  private logFuturesAccountPayloadStats(
    marketType: MarketType,
    rawPositions: number,
    activePositions: number,
    rawAssets: number,
    activeAssets: number,
  ): void {
    const now = Date.now();
    const lastAt = this.lastAccountPayloadLogAtByMarket.get(marketType) ?? 0;
    if (now - lastAt < this.accountPayloadLogThrottleMs) return;
    this.lastAccountPayloadLogAtByMarket.set(marketType, now);
    this.logger.log(
      `[AccountPayload] market=${marketType} raw_positions=${rawPositions} active_positions=${activePositions} raw_assets=${rawAssets} active_assets=${activeAssets}`,
    );
  }

  private warnAccountPayloadSize(
    channel: SubscriptionType,
    payload: unknown,
    positionsCount: number,
    assetsCount: number,
  ): void {
    let sizeBytes = 0;
    try {
      sizeBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    } catch {
      return;
    }
    if (sizeBytes <= this.accountPayloadWarnSizeBytes) return;
    this.logger.warn(
      `[PayloadSizeWarning] channel=${String(
        channel,
      )} size_bytes=${sizeBytes} positions=${positionsCount} assets=${assetsCount}`,
    );
  }

  private compactFuturesAccountEventPayload(data: any): {
    payload: any;
    rawPositions: number;
    activePositions: number;
    rawAssets: number;
    activeAssets: number;
  } {
    const topLevelPositions = Array.isArray(data?.positions)
      ? data.positions
      : [];
    const topLevelAssets = Array.isArray(data?.balances) ? data.balances : [];
    const nestedPositions = Array.isArray(data?.a?.P) ? data.a.P : [];
    const nestedAssets = Array.isArray(data?.a?.B) ? data.a.B : [];
    const rawPositions = Math.max(
      topLevelPositions.length,
      nestedPositions.length,
    );
    const rawAssets = Math.max(topLevelAssets.length, nestedAssets.length);

    const activeTopLevelPositions =
      this.filterActiveFuturesPositions(topLevelPositions);
    const activeNestedPositions =
      this.filterActiveFuturesPositions(nestedPositions);
    const activeTopLevelAssets = this.filterActiveFuturesAssets(topLevelAssets);
    const activeNestedAssets = this.filterActiveFuturesAssets(nestedAssets);
    const activePositions = Math.max(
      activeTopLevelPositions.length,
      activeNestedPositions.length,
    );
    const activeAssets = Math.max(
      activeTopLevelAssets.length,
      activeNestedAssets.length,
    );

    const payload = {
      ...data,
      positions: Array.isArray(data?.positions)
        ? activeTopLevelPositions
        : data?.positions,
      balances: Array.isArray(data?.balances)
        ? activeTopLevelAssets
        : data?.balances,
      a: data?.a
        ? {
            ...data.a,
            P: Array.isArray(data?.a?.P) ? activeNestedPositions : data.a.P,
            B: Array.isArray(data?.a?.B) ? activeNestedAssets : data.a.B,
          }
        : data?.a,
    };

    return {
      payload,
      rawPositions,
      activePositions,
      rawAssets,
      activeAssets,
    };
  }

  private sanitizeSymbolObjects(
    marketType: MarketType,
    symbols: TradingSymbol[],
  ): TradingSymbol[] {
    const rawNames = symbols.map((s) => s?.name ?? '');
    const { validSymbols, removedSymbols } =
      this.clientService.validateBinanceSymbols(marketType, rawNames);
    if (removedSymbols.length > 0) {
      this.logger.warn(
        `[BinanceSymbolFilter] removed_invalid_symbols=${removedSymbols.join(
          ',',
        )}`,
      );
    }
    this.logRemovedInvalidSymbols(rawNames, validSymbols);

    const validSet = new Set(validSymbols);
    const dedup = new Set<string>();
    return symbols.filter((s) => {
      const normalized = normalizeTradingSymbol(s?.name);
      if (!normalized || !validSet.has(normalized) || dedup.has(normalized))
        return false;
      dedup.add(normalized);
      return true;
    });
  }

  private sanitizeSymbolNames(
    marketType: MarketType,
    symbols: string[],
  ): string[] {
    const { validSymbols, removedSymbols } =
      this.clientService.validateBinanceSymbols(marketType, symbols);
    if (removedSymbols.length > 0) {
      this.logger.warn(
        `[BinanceSymbolFilter] removed_invalid_symbols=${removedSymbols.join(
          ',',
        )}`,
      );
    }
    this.logRemovedInvalidSymbols(symbols, validSymbols);
    return validSymbols;
  }

  // ======================================================
  // 🔹 Candles
  // ======================================================
  async subscribeToCandles(
    options: {
      marketType: MarketType;
      symbols: TradingSymbol[];
      interval: TimeFrame;
    },
    handler: any,
  ): Promise<UnsubscribeFn> {
    await this.ensureReady();

    const { marketType, symbols, interval } = options;
    const sanitizedSymbols = this.sanitizeSymbolObjects(marketType, symbols);
    if (sanitizedSymbols.length === 0) {
      this.logger.warn(
        `[BinanceSymbolFilter] no_valid_symbols_for_ws stream=candles market=${marketType}`,
      );
      return () => {};
    }
    const streamId = this.nextStreamId('candles', marketType);
    this.registerStream(streamId, 'candles', marketType);

    let binanceInterval: ReturnType<typeof convertTimeFrame>;
    try {
      binanceInterval = convertTimeFrame(interval);
    } catch (err) {
      this.clearStream(streamId);
      throw err;
    }

    const stallThresholdMs = this.getCandleStallThresholdMs(
      interval,
      this.getStallThresholdMs('candles'),
    );

    const method =
      marketType === MarketType.futures ? 'futuresCandles' : 'candles';
    const topics = sanitizedSymbols.map(
      (s) => `${s.name.toLowerCase()}@kline_${binanceInterval}`,
    );
    this.logTopicDiagnostics(marketType, sanitizedSymbols, topics);

    let unsubscribe: any;
    let reconnecting = false;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let reconnectAttempt = 0;
    let stallCooldownUntil = 0;
    let lastStallWarnAt = 0;

    const wrappedHandler = this.createSerializedHandler(
      streamId,
      'candles',
      marketType,
      async (data: any) => {
        reconnectAttempt = 0;
        stallCooldownUntil = 0;
        await handler(data);
      },
    );

    const start = async () => {
      unsubscribe = await Promise.resolve(
        this.api.ws[method](
          sanitizedSymbols.map((s) => s.name),
          binanceInterval,
          wrappedHandler,
        ),
      );
      this.logger.log(
        `REALTIME_STREAM_CONNECTED stream=${streamId} type=candles market=${marketType} symbols=${sanitizedSymbols.length} interval=${interval}`,
      );
    };
    await start();

    let lastMessageAt = Date.now();
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (reconnecting || reconnectTimer) return;
      if (now < stallCooldownUntil) return;
      const state = this.streamStatus.get(streamId);
      lastMessageAt = state?.lastMessageAt ?? lastMessageAt;
      if (now - lastMessageAt <= stallThresholdMs) return;
      reconnecting = true;
      this.markStreamReconnecting(streamId);
      reconnectAttempt += 1;
      const reconnectDelayMs =
        this.getReconnectDelayWithBackoffMs(reconnectAttempt);
      if (now - lastStallWarnAt >= this.stallWarnThrottleMs) {
        this.logger.warn(
          `[BINANCE WS] stall detected stream=${streamId} thresholdMs=${stallThresholdMs} ageMs=${
            now - lastMessageAt
          }; reconnecting attempt=${reconnectAttempt} delayMs=${reconnectDelayMs}`,
        );
        lastStallWarnAt = now;
      }
      this.safeUnsubscribe(unsubscribe);
      stallCooldownUntil = now + this.streamStallCooldownMs;
      reconnectTimer = setTimeout(() => {
        void start()
          .catch((error) => {
            this.logger.warn(
              `[BINANCE WS] reconnect failed stream=${streamId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          })
          .finally(() => {
            reconnecting = false;
            reconnectTimer = null;
          });
      }, reconnectDelayMs);
    }, this.streamStallCheckMs);

    return () => {
      clearInterval(watchdog);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      this.clearStream(streamId);
      this.safeUnsubscribe(unsubscribe);
    };
  }

  // ======================================================
  // 🔹 Symbols (REST polling)
  // ======================================================
  async subscribeToSymbols(
    options: { marketType: MarketType },
    handler: (symbols: any[]) => Promise<void>,
  ): Promise<() => void> {
    await this.ensureReady();

    const { marketType } = options;
    let stopped = false;

    const fetchAndHandle = async () => {
      if (stopped) return;

      try {
        const symbols =
          marketType === MarketType.spot
            ? await this.api.exchangeInfo()
            : await this.api.futuresExchangeInfo();

        await handler(symbols.symbols ?? symbols);
      } catch {
        // периодический fetch — без throw
      }
    };

    await fetchAndHandle();
    const intervalId = setInterval(fetchAndHandle, 60 * 60 * 1000);

    return () => {
      stopped = true;
      clearInterval(intervalId);
    };
  }

  // ======================================================
  // 🔹 OrderBook
  // ======================================================
  async subscribeToOrderBook(
    options: {
      marketType: MarketType;
      symbols: TradingSymbol[];
    },
    handler: any,
  ): Promise<UnsubscribeFn> {
    await this.ensureReady();

    const { marketType, symbols } = options;
    const sanitizedSymbols = this.sanitizeSymbolObjects(marketType, symbols);
    if (sanitizedSymbols.length === 0) {
      this.logger.warn(
        `[BinanceSymbolFilter] no_valid_symbols_for_ws stream=orderbook market=${marketType}`,
      );
      return () => {};
    }
    const streamId = this.nextStreamId('orderbook', marketType);
    this.registerStream(streamId, 'orderbook', marketType);
    const stallThresholdMs = this.getStallThresholdMs('orderbook');
    let unsubscribe: any;
    let reconnecting = false;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let reconnectAttempt = 0;
    let stallCooldownUntil = 0;
    let lastStallWarnAt = 0;

    const method = marketType === MarketType.futures ? 'futuresDepth' : 'depth';

    const topics = sanitizedSymbols.map((s) => `${s.name.toLowerCase()}@depth`);
    this.logTopicDiagnostics(marketType, sanitizedSymbols, topics);
    if (this.wsDebugEnabled) {
      this.logger.debug(
        `[BINANCE WS] subscribe orderbook method=${method} market=${marketType} topics=${topics.join(
          ',',
        )}`,
      );
    }

    const wrappedHandler = this.createSerializedHandler(
      streamId,
      'orderbook',
      marketType,
      async (data: any) => {
        reconnectAttempt = 0;
        stallCooldownUntil = 0;
        await handler(data);
      },
    );

    const start = async () => {
      unsubscribe = await Promise.resolve(
        this.api.ws[method](
          sanitizedSymbols.map((s) => s.name),
          wrappedHandler,
        ),
      );
      this.logger.log(
        `REALTIME_STREAM_CONNECTED stream=${streamId} type=orderbook market=${marketType} symbols=${sanitizedSymbols.length}`,
      );
    };
    await start();

    let lastMessageAt = Date.now();
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (reconnecting || reconnectTimer) return;
      if (now < stallCooldownUntil) return;
      const state = this.streamStatus.get(streamId);
      lastMessageAt = state?.lastMessageAt ?? lastMessageAt;
      if (now - lastMessageAt <= stallThresholdMs) return;
      reconnecting = true;
      this.markStreamReconnecting(streamId);
      reconnectAttempt += 1;
      const reconnectDelayMs =
        this.getReconnectDelayWithBackoffMs(reconnectAttempt);
      if (now - lastStallWarnAt >= this.stallWarnThrottleMs) {
        this.logger.warn(
          `[BINANCE WS] stall detected stream=${streamId} thresholdMs=${stallThresholdMs} ageMs=${
            now - lastMessageAt
          }; reconnecting attempt=${reconnectAttempt} delayMs=${reconnectDelayMs}`,
        );
        lastStallWarnAt = now;
      }
      this.safeUnsubscribe(unsubscribe);
      stallCooldownUntil = now + this.streamStallCooldownMs;
      reconnectTimer = setTimeout(() => {
        void start()
          .catch((error) => {
            this.logger.warn(
              `[BINANCE WS] reconnect failed stream=${streamId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          })
          .finally(() => {
            reconnecting = false;
            reconnectTimer = null;
          });
      }, reconnectDelayMs);
    }, this.streamStallCheckMs);

    return () => {
      clearInterval(watchdog);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      this.clearStream(streamId);
      this.safeUnsubscribe(unsubscribe);
    };
  }

  // ======================================================
  // 🔹 Trades
  // ======================================================
  async subscribeToTrade(
    options: {
      marketType: MarketType;
      symbols: TradingSymbol[];
    },
    handler: any,
  ): Promise<UnsubscribeFn> {
    await this.ensureReady();

    const { marketType, symbols } = options;
    const sanitizedSymbols = this.sanitizeSymbolObjects(marketType, symbols);
    if (sanitizedSymbols.length === 0) {
      this.logger.warn(
        `[BinanceSymbolFilter] no_valid_symbols_for_ws stream=trades market=${marketType}`,
      );
      return () => {};
    }
    const streamId = this.nextStreamId('trades', marketType);
    this.registerStream(streamId, 'trades', marketType);
    const stallThresholdMs = this.getStallThresholdMs('trades');
    let unsubscribe: any;
    let reconnecting = false;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let reconnectAttempt = 0;
    let stallCooldownUntil = 0;
    let lastStallWarnAt = 0;

    const method =
      marketType === MarketType.futures ? 'futuresAggTrades' : 'aggTrades';

    const topics = sanitizedSymbols.map(
      (s) => `${s.name.toLowerCase()}@aggTrade`,
    );
    this.logTopicDiagnostics(marketType, sanitizedSymbols, topics);
    if (this.wsDebugEnabled) {
      this.logger.debug(
        `[BINANCE WS] subscribe trades method=${method} market=${marketType} topics=${topics.join(
          ',',
        )}`,
      );
    }

    const periodicHandler = this.createPeriodicDrainHandler(
      streamId,
      'trades',
      marketType,
      async (data: any) => {
        reconnectAttempt = 0;
        stallCooldownUntil = 0;
        await handler(data);
      },
    );
    const wrappedHandler = periodicHandler.callback;

    const start = async () => {
      unsubscribe = await Promise.resolve(
        this.api.ws[method](
          sanitizedSymbols.map((s) => s.name),
          wrappedHandler,
        ),
      );
      this.logger.log(
        `REALTIME_STREAM_CONNECTED stream=${streamId} type=trades market=${marketType} symbols=${sanitizedSymbols.length}`,
      );
    };
    await start();

    let lastMessageAt = Date.now();
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (reconnecting || reconnectTimer) return;
      if (now < stallCooldownUntil) return;
      const state = this.streamStatus.get(streamId);
      lastMessageAt = state?.lastMessageAt ?? lastMessageAt;
      if (now - lastMessageAt <= stallThresholdMs) return;
      reconnecting = true;
      this.markStreamReconnecting(streamId);
      reconnectAttempt += 1;
      const reconnectDelayMs =
        this.getReconnectDelayWithBackoffMs(reconnectAttempt);
      if (now - lastStallWarnAt >= this.stallWarnThrottleMs) {
        this.logger.warn(
          `[BINANCE WS] stall detected stream=${streamId} thresholdMs=${stallThresholdMs} ageMs=${
            now - lastMessageAt
          }; reconnecting attempt=${reconnectAttempt} delayMs=${reconnectDelayMs}`,
        );
        lastStallWarnAt = now;
      }
      this.safeUnsubscribe(unsubscribe);
      stallCooldownUntil = now + this.streamStallCooldownMs;
      reconnectTimer = setTimeout(() => {
        void start()
          .catch((error) => {
            this.logger.warn(
              `[BINANCE WS] reconnect failed stream=${streamId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          })
          .finally(() => {
            reconnecting = false;
            reconnectTimer = null;
          });
      }, reconnectDelayMs);
    }, this.streamStallCheckMs);

    return () => {
      clearInterval(watchdog);
      periodicHandler.dispose();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      this.clearStream(streamId);
      this.safeUnsubscribe(unsubscribe);
    };
  }

  // ======================================================
  // 🔹 Account
  // ======================================================
  async subscribeToAccount(
    options: { marketType: MarketType },
    handler: any,
  ): Promise<UnsubscribeFn> {
    await this.ensureReady();

    const { marketType } = options;

    const method = marketType === MarketType.futures ? 'futuresUser' : 'user';

    const wrappedHandler = (data: any) => {
      handler(data);

      let accountPayload = data;
      let positionsCount = Array.isArray(data?.positions)
        ? data.positions.length
        : 0;
      let assetsCount = Array.isArray(data?.balances)
        ? data.balances.length
        : 0;

      if (marketType === MarketType.futures) {
        const compact = this.compactFuturesAccountEventPayload(data);
        accountPayload = compact.payload;
        positionsCount = compact.activePositions;
        assetsCount = compact.activeAssets;
        this.logFuturesAccountPayloadStats(
          marketType,
          compact.rawPositions,
          compact.activePositions,
          compact.rawAssets,
          compact.activeAssets,
        );
      }

      const redisPayload = {
        value: accountPayload,
        options: {
          connectorType: ConnectorType.binance,
          marketType,
          updateMoment: Date.now(),
        },
      };
      this.warnAccountPayloadSize(
        SubscriptionType.PROVIDER_ACCOUNT_EVENT,
        redisPayload,
        positionsCount,
        assetsCount,
      );
    };

    const unsubscribe = await Promise.resolve(
      this.api.ws[method](wrappedHandler),
    );

    return () => {
      this.safeUnsubscribe(unsubscribe);
    };
  }

  // ======================================================
  // 🔹 Symbol Prices (через WebSocketService)
  // ======================================================
  async subscribeToSymbolPrices(
    options: {
      marketType: MarketType;
      symbols: string[];
    },
    handler: any,
  ): Promise<UnsubscribeFn> {
    await this.ensureReady();

    const { marketType, symbols } = options;
    const sanitizedSymbols = this.sanitizeSymbolNames(marketType, symbols);
    if (sanitizedSymbols.length === 0) {
      this.logger.warn(
        `[BinanceSymbolFilter] no_valid_symbols_for_ws stream=symbolPrices market=${marketType}`,
      );
      return () => {};
    }
    const streamId = this.nextStreamId('symbolPrices', marketType);
    this.registerStream(streamId, 'symbolPrices', marketType);
    const stallThresholdMs = this.getStallThresholdMs('symbolPrices');
    let wsUrl: string;

    if (marketType === MarketType.spot) {
      const stream = sanitizedSymbols
        .map((s) => `${s.toLowerCase()}@ticker`)
        .join('/');
      this.logTopicDiagnostics(
        marketType,
        sanitizedSymbols,
        sanitizedSymbols.map((s) => `${s.toLowerCase()}@ticker`),
      );

      wsUrl = `wss://stream.binance.com:9443/stream?streams=${stream}`;
    } else {
      this.logTopicDiagnostics(
        marketType,
        sanitizedSymbols,
        sanitizedSymbols.map((s) => `${s.toLowerCase()}@ticker`),
      );
      wsUrl = 'wss://fstream.binance.com/ws';
    }

    const unsubscribeStream = await this.webSocketService.subscribeToStream(
      wsUrl,
      {
        stallThresholdMs,
      },
    );

    const messageCallback = (data: any) => {
      this.recordWsEvent('symbolPrices');
      this.touchStream(streamId, 'symbolPrices', marketType);
      this.marketdataMetrics.observeMarketDataLag(
        'symbolPrices',
        marketType,
        this.extractEventTimestampMs(data),
      );
      handler(data);
    };
    this.webSocketService.onMessage(wsUrl, messageCallback);

    let openCallback: ((ws: any) => void) | null = null;
    if (marketType === MarketType.futures) {
      openCallback = (ws: any) => {
        const params = sanitizedSymbols.map((s) => `${s.toLowerCase()}@ticker`);

        ws.send(
          JSON.stringify({
            method: 'SUBSCRIBE',
            params,
            id: Date.now(),
          }),
        );

        this.webSocketService.withSocket(wsUrl, (si) => {
          si.activeSubs = params;
        });
      };
      this.webSocketService.onOpen(wsUrl, openCallback);
    }

    return () => {
      this.webSocketService.offMessage(wsUrl, messageCallback);
      if (openCallback) {
        this.webSocketService.offOpen(wsUrl, openCallback);
      }

      if (marketType === MarketType.futures) {
        this.webSocketService.withSocket(wsUrl, (si) => {
          si.ws.send(
            JSON.stringify({
              method: 'UNSUBSCRIBE',
              params: sanitizedSymbols.map((s) => `${s.toLowerCase()}@ticker`),
              id: Date.now(),
            }),
          );
        });
      }

      unsubscribeStream();
      this.clearStream(streamId);
    };
  }

  // ======================================================
  // 🔹 Utils
  // ======================================================
  chunkSymbols(
    symbols: string[],
    maxPerWs = 50,
    maxUrlLength = 1900,
  ): string[][] {
    const result: string[][] = [];
    let batch: string[] = [];
    let length = 0;

    for (const sym of symbols) {
      const stream = `${sym.toLowerCase()}@ticker`;
      const extraLength = (batch.length > 0 ? 1 : 0) + stream.length;

      if (batch.length >= maxPerWs || length + extraLength > maxUrlLength) {
        result.push(batch);
        batch = [];
        length = 0;
      }

      batch.push(stream);
      length += extraLength;
    }

    if (batch.length) {
      result.push(batch);
    }

    return result;
  }
}
