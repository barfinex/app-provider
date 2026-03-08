import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as net from 'net';
import { Counter, Histogram, register } from 'prom-client';

export interface ILPWriteOptions {
  table: string;
  keys?: Record<string, string | number>;
  fields: Record<string, string | number | boolean | bigint>;
  /** Nanoseconds since epoch. If omitted, generated with BigInt to avoid precision loss. */
  timestampNs?: bigint;
}

export type SocketChannel = 'main' | 'trades' | 'candles' | 'orderbook' | 'events';

export type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING';

type QueueItem = { channel: SocketChannel; line: string };

type DrainWaitState = {
  promise: Promise<void>;
  resolve: () => void;
  timeout: NodeJS.Timeout;
};

const SOCKET_CHANNELS: SocketChannel[] = ['main', 'trades', 'candles', 'orderbook', 'events'];

/** Single managed ILP connection: one TCP socket, one queue, batch flush, circuit breaker. */
@Injectable()
export class QuestDBWriteService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('QuestDBWrite');
  private readonly debugEnabled = process.env.QUESTDB_DEBUG === 'true';

  private readonly configuredHost = (
    process.env.QUESTDB_HOST || '127.0.0.1'
  ).trim().replace(/^localhost$/i, '127.0.0.1');
  private host = this.configuredHost;
  private readonly hasIpv4Fallback = false;
  private readonly port = Number(process.env.QUESTDB_ILP_PORT || 9009);
  private readonly httpPort = Number(process.env.QUESTDB_HTTP_PORT || 9000);

  // Provider-specific env (primary) with fallback to legacy QUESTDB_*
  private readonly WRITE_BATCH_SIZE = Math.max(
    1,
    Number(
      process.env.PROVIDER_QUESTDB_WRITE_BATCH_SIZE ||
        process.env.QUESTDB_BATCH_SIZE ||
        500,
    ),
  );
  private readonly FLUSH_INTERVAL_MS = Math.max(
    10,
    Number(
      process.env.PROVIDER_QUESTDB_WRITE_FLUSH_MS ||
        process.env.QUESTDB_FLUSH_INTERVAL ||
        50,
    ),
  );
  private readonly QUEUE_MAX_SIZE = Math.max(
    1000,
    Number(
      process.env.PROVIDER_QUESTDB_WRITE_QUEUE_SIZE ||
        process.env.QUESTDB_BUFFER_LIMIT_ROWS ||
        process.env.QUESTDB_BUFFER_MAX_ROWS ||
        10_000,
    ),
  );
  private readonly QUEUE_HARD_LIMIT = Math.max(
    this.QUEUE_MAX_SIZE,
    Number(process.env.QUESTDB_BUFFER_HARD_LIMIT || 50_000),
  );
  private readonly RECONNECT_BASE_MS = Math.max(
    250,
    Number(
      process.env.PROVIDER_QUESTDB_RECONNECT_BASE_MS ||
        process.env.QUESTDB_RECONNECT_INITIAL_DELAY_MS ||
        500,
    ),
  );
  private readonly RECONNECT_MAX_MS = Math.max(
    this.RECONNECT_BASE_MS,
    Number(
      process.env.PROVIDER_QUESTDB_RECONNECT_MAX_MS ||
        process.env.QUESTDB_RECONNECT_MAX_DELAY_MS ||
        10_000,
    ),
  );
  private readonly CIRCUIT_FAILURE_THRESHOLD = Math.max(
    1,
    Number(process.env.PROVIDER_QUESTDB_CIRCUIT_FAILURE_THRESHOLD || 5),
  );
  private readonly CIRCUIT_COOLDOWN_MS = Math.max(
    5000,
    Number(process.env.PROVIDER_QUESTDB_CIRCUIT_COOLDOWN_MS || 30_000),
  );

  /** Adaptive batching tiers: batch size by queue pressure (see getCurrentBatchSize()). */
  private readonly ADAPTIVE_BATCH_TIERS = [100, 500, 1000, 2000] as const;
  private readonly BACKPRESSURE_WARN_PCT = Math.min(
    100,
    Math.max(0, Number(process.env.PROVIDER_QUESTDB_BACKPRESSURE_WARN_PCT || 80)),
  );
  private readonly BACKPRESSURE_DROP_PCT = Math.min(
    100,
    Math.max(0, Number(process.env.PROVIDER_QUESTDB_BACKPRESSURE_DROP_PCT || 95)),
  );
  private readonly COALESCE_WINDOW_MS = Math.max(
    0,
    Number(process.env.PROVIDER_QUESTDB_COALESCE_WINDOW_MS ?? 5),
  );
  /** Comma-separated list of channels where coalescing is allowed (e.g. "candles"). Trades/orderbook/events are not coalesced by default for correctness. */
  private readonly COALESCE_CHANNELS = new Set(
    (process.env.PROVIDER_QUESTDB_COALESCE_CHANNELS ?? 'candles')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  private readonly FLUSH_JITTER_MS = Math.max(
    0,
    Number(process.env.PROVIDER_QUESTDB_FLUSH_JITTER_MS ?? 5),
  );

  private readonly CONNECT_TIMEOUT_MS = 2_000;
  private static readonly WARN_THROTTLE_MS = 2_000;
  private static readonly DRAIN_WAIT_MS = Number(process.env.QUESTDB_DRAIN_WAIT_MS || 30_000);

  private isRunning = false;
  private destroyed = false;
  private acceptingWrites = true;
  private flushWorker: Promise<void> | null = null;

  /** Single TCP connection for all ILP traffic. */
  private socket: net.Socket | null = null;
  private connected = false;
  private connectionState: ConnectionState = 'DISCONNECTED';
  private reconnectLoop: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private reconnectTriggeredTotal = 0;

  /** WriteBuffer: single in-memory queue. */
  private queue: QueueItem[] = [];
  private droppedRowsTotal = 0;
  /** Drop reason counters for metrics and alerting. */
  private droppedOverflowTotal = 0;
  private droppedBackpressureTotal = 0;
  private droppedShutdownTotal = 0;
  private droppedRowsByChannel: Record<SocketChannel, number> = {
    main: 0,
    trades: 0,
    candles: 0,
    orderbook: 0,
    events: 0,
  };
  /** For alert logging: last dropped total so we can detect 0 -> >0. */
  private lastDroppedTotalLogged = 0;
  /** For alert logging: time when queue first entered warn zone; 0 if not in warn. */
  private queueWarnSince = 0;
  private static readonly QUEUE_WARN_SUSTAINED_MS = 30_000;
  /** For alert logging: time when circuit opened; 0 if closed. */
  private circuitOpenedAt = 0;
  private circuitOpenLoggedSustained = false;

  /** BatchWriter: flush state. */
  private isFlushing = false;
  private lastBatchSize = 0;
  private writeSuccessTotal = 0;
  private writeFailuresTotal = 0;
  private consecutiveWriteFailures = 0;

  /** CircuitBreaker: pause writes after N consecutive failures. */
  private circuitOpenUntil = 0;

  /** ConnectionSupervisor: backoff + jitter. */
  private drainWait: DrainWaitState | null = null;
  private lastWarnAt = 0;
  private lastReconnectLogAt = 0;
  private static readonly RECONNECT_LOG_THROTTLE_MS = 1_000;

  /** Adaptive batch: last computed batch size for metrics. */
  private batchSizeCurrent = this.WRITE_BATCH_SIZE;
  private lastBatchSizeChangeAt = 0;
  private static readonly BATCH_SIZE_CHANGE_LOG_THROTTLE_MS = 5_000;

  /** Write latency: last successful write round-trip (ms). */
  private lastWriteLatencyMs = 0;

  /** Coalescing buffer: key = table|timestampNs|symbol. */
  private coalesceBuffer = new Map<string, { channel: SocketChannel; opts: ILPWriteOptions }>();
  private coalesceFlushScheduled: NodeJS.Timeout | null = null;
  private coalesceAppliedCount = 0;

  /** Prometheus counters/histogram (lazy-initialized). */
  private dropCounters: {
    overflow: Counter;
    backpressure: Counter;
    shutdown: Counter;
  } | null = null;
  private latencyHistogram: Histogram<string> | null = null;

  private debug(message: string): void {
    if (this.debugEnabled) {
      this.logger.debug(message);
    }
  }

  async onModuleInit(): Promise<void> {
    this.isRunning = true;
    this.acceptingWrites = true;
    this.batchSizeCurrent = this.computeAdaptiveBatchSize();
    this.initPrometheusMetrics();
    this.logStartup();
    this.reconnectLoop = this.runReconnectWithBackoff();
    this.flushWorker = this.runFlushWorker();
  }

  private initPrometheusMetrics(): void {
    this.dropCounters = {
      overflow: this.getOrCreateCounter('questdb_write_dropped_overflow_total', 'Rows dropped due to queue overflow (trim to capacity)'),
      backpressure: this.getOrCreateCounter('questdb_write_dropped_backpressure_total', 'Rows dropped due to backpressure (DROP_OLDEST)'),
      shutdown: this.getOrCreateCounter('questdb_write_dropped_shutdown_total', 'Rows dropped during shutdown (buffer not drained)'),
    };
    this.latencyHistogram = this.getOrCreateLatencyHistogram();
  }

  private getOrCreateCounter(name: string, help: string): Counter {
    const existing = register.getSingleMetric(name);
    if (existing) return existing as Counter;
    return new Counter({
      name,
      help,
      registers: [register],
    });
  }

  private getOrCreateLatencyHistogram(): Histogram<string> {
    const name = 'questdb_write_latency_seconds';
    const existing = register.getSingleMetric(name);
    if (existing) return existing as Histogram<string>;
    return new Histogram({
      name,
      help: 'QuestDB ILP write latency in seconds (percentile-friendly)',
      labelNames: [],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [register],
    });
  }

  private logStartup(): void {
    this.logger.log(
      `QuestDB ILP startup host=${this.host} port=${this.port} ` +
        `batchSize=${this.WRITE_BATCH_SIZE} flushMs=${this.FLUSH_INTERVAL_MS} queueSize=${this.QUEUE_MAX_SIZE} ` +
        `reconnectBaseMs=${this.RECONNECT_BASE_MS} reconnectMaxMs=${this.RECONNECT_MAX_MS}`,
    );
  }

  private maybeSwitchToIpv4Fallback(reason?: string, errCode?: string): void {
    if (!this.hasIpv4Fallback) return;
    if (this.host === '127.0.0.1') return;
    const shouldFallback =
      reason?.includes('connection_lost') ||
      reason?.includes('write failure') ||
      errCode === 'ECONNRESET' ||
      errCode === 'EPIPE' ||
      errCode === 'ECONNREFUSED';
    if (!shouldFallback) return;
    this.host = '127.0.0.1';
    this.logger.warn(
      'QuestDB ILP localhost connection is unstable; switching to 127.0.0.1 fallback',
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.destroyed) {
      this.logger.warn('ModuleDestroy already executed; skip duplicate call');
      return;
    }
    this.destroyed = true;
    this.isRunning = false;
    this.acceptingWrites = false;

    if (this.coalesceFlushScheduled) {
      clearTimeout(this.coalesceFlushScheduled);
      this.coalesceFlushScheduled = null;
    }
    this.flushCoalescer();

    this.resolveDrainWait();

    if (this.flushWorker) {
      await Promise.race([
        this.flushWorker,
        this.sleep(Math.max(this.FLUSH_INTERVAL_MS * 4, 100)),
      ]);
      this.flushWorker = null;
    }

    await this.flushOnce();

    const remaining = this.queue.length;
    if (remaining > 0) {
      this.logger.warn(
        `QuestDB shutdown with buffered rows still pending=${remaining}; dropping remaining buffer`,
      );
      this.droppedRowsTotal += remaining;
      this.droppedShutdownTotal += remaining;
      this.dropCounters?.shutdown.inc(remaining);
      this.queue = [];
    }

    this.closeSocket(true);
  }

  disconnectChannel(_channel: SocketChannel): void {
    this.connectionState = 'DISCONNECTED';
    this.resolveDrainWait();
    this.closeSocket(true);
    this.connected = false;
  }

  reconnectChannel(_channel: SocketChannel): void {
    this.resolveDrainWait();
    this.closeSocket(true);
    this.connected = false;
    if (!this.reconnectLoop) {
      this.reconnectLoop = this.runReconnectWithBackoff();
    }
  }

  /** Enqueue one row (non-blocking). Redis must be published before calling this. */
  write(channel: SocketChannel, opts: ILPWriteOptions): void {
    const { table, keys = {}, fields, timestampNs } = opts;
    const ts = timestampNs ?? this.nowNs();
    const useCoalescer =
      this.COALESCE_WINDOW_MS > 0 && this.COALESCE_CHANNELS.has(channel);
    if (useCoalescer) {
      this.pushToCoalescer(channel, { table, keys, fields, timestampNs: ts });
      this.scheduleCoalesceFlush();
      if (this.totalQueued() >= this.getCurrentBatchSize()) {
        void this.flushOnce();
      }
      return;
    }
    const line = this.buildILP(table, keys, fields, ts);
    if (!line) return;
    this.enqueue(channel, line);
    if (this.queue.length >= this.getCurrentBatchSize()) {
      void this.flushOnce();
    }
  }

  /** Enqueue multiple rows without waiting for flush (non-blocking). Use after Redis publish. */
  enqueueBatch(channel: SocketChannel, batch: ILPWriteOptions[]): void {
    if (!batch.length) return;
    const useCoalescer =
      this.COALESCE_WINDOW_MS > 0 && this.COALESCE_CHANNELS.has(channel);
    if (useCoalescer) {
      for (const o of batch) {
        const ts = o.timestampNs ?? this.nowNs();
        this.pushToCoalescer(channel, { ...o, timestampNs: ts });
      }
      this.scheduleCoalesceFlush();
      if (this.totalQueued() >= this.getCurrentBatchSize()) {
        void this.flushOnce();
      }
      return;
    }
    for (const o of batch) {
      const ts = o.timestampNs ?? this.nowNs();
      const line = this.buildILP(o.table, o.keys ?? {}, o.fields ?? {}, ts);
      if (line) this.enqueue(channel, line);
    }
    if (this.queue.length >= this.getCurrentBatchSize()) {
      void this.flushOnce();
    }
  }

  /** Blocking batch write: enqueue then flush and wait until queue drained. */
  async writeBatch(channel: SocketChannel, batch: ILPWriteOptions[]): Promise<void> {
    if (!batch.length) return;
    this.enqueueBatch(channel, batch);
    await this.waitUntilBelow(0);
  }

  /** Flush and optionally wait until this channel's queue is drained. */
  async flushChannel(channel: SocketChannel): Promise<void> {
    await this.flushOnce();
    const target = this.queue.filter((i) => i.channel === channel).length;
    if (target > 0) await this.waitUntilBelow(this.totalQueued() - target);
  }

  /** Flush once (kept for backward compat with base.repository flush()). */
  async flush(channel: SocketChannel): Promise<void> {
    await this.flushOnce();
  }

  async writeBatchIlpHttp(
    channel: SocketChannel,
    batch: ILPWriteOptions[],
    options?: { quiet?: boolean },
  ): Promise<void> {
    if (!batch.length) return;

    const lines: string[] = [];
    for (const o of batch) {
      const ts = o.timestampNs ?? this.nowNs();
      const line = this.buildILP(o.table, o.keys ?? {}, o.fields ?? {}, ts);
      if (line) lines.push(line);
    }
    if (!lines.length) return;

    const body = lines.join('\n') + '\n';
    const url = `http://${this.host}:${this.httpPort}/write?precision=ns`;
    if (!options?.quiet) {
      this.logger.log(
        `QuestDB HTTP ILP write channel=${channel} rows=${lines.length} table=${batch[0]?.table ?? '?'}`,
      );
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.influxdb.line.protocol' },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `QuestDB HTTP ILP write failed channel=${channel} status=${res.status} error=${text.slice(0, 200)}`,
      );
    }
  }

  async waitUntilBelow(targetLen: number): Promise<void> {
    const startedAt = Date.now();

    while (this.totalQueued() > targetLen) {
      await this.flushOnce();
      if (this.socket && this.connected && this.socket.writableNeedDrain) {
        await this.waitDrain();
      } else {
        await this.sleep(25);
      }

      if (Date.now() - startedAt > QuestDBWriteService.DRAIN_WAIT_MS * 10) {
        this.logger.warn(
          `QuestDB waitUntilBelow timeout buffered=${this.totalQueued()} target=${targetLen}`,
        );
        break;
      }
    }
  }

  async flushOnce(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;
    this.flushCoalescer();

    try {
      while (true) {
        if (!this.socket || !this.connected) {
          if (this.queue.length > 0) {
            this.debug(`QuestDB not connected, buffered=${this.queue.length}`);
          }
          return;
        }

        if (this.queue.length === 0) return;

        if (this.isCircuitOpen()) {
          this.maybeLogCircuitOpenSustained();
          return;
        }
        this.circuitOpenedAt = 0;
        this.circuitOpenLoggedSustained = false;

        if (this.socket.writableNeedDrain) {
          await this.waitDrain();
          continue;
        }

        const batchSize = this.getCurrentBatchSize();
        this.updateBatchSizeMetric(batchSize);
        const take = Math.min(batchSize, this.queue.length);
        const batch = this.queue.splice(0, take);
        this.lastBatchSize = batch.length;
        const payload = batch.map((i) => i.line).join('\n') + '\n';

        const writeStartedAt = Date.now();
        const ok = this.socket.write(payload, (err) => {
          if (!err) {
            this.writeSuccessTotal += 1;
            this.consecutiveWriteFailures = 0;
            if (this.circuitOpenUntil > 0) {
              this.circuitOpenUntil = 0;
              this.circuitOpenedAt = 0;
              this.circuitOpenLoggedSustained = false;
            }
            return;
          }
          this.writeFailuresTotal += 1;
          this.consecutiveWriteFailures += 1;
          if (
            this.consecutiveWriteFailures >= this.CIRCUIT_FAILURE_THRESHOLD &&
            this.circuitOpenUntil === 0
          ) {
            const now = Date.now();
            this.circuitOpenUntil = now + this.CIRCUIT_COOLDOWN_MS;
            this.circuitOpenedAt = now;
            this.circuitOpenLoggedSustained = false;
            this.logStructured('writer_paused', {
              consecutiveFailures: this.consecutiveWriteFailures,
              cooldownMs: this.CIRCUIT_COOLDOWN_MS,
            });
          }
          this.queue.unshift(...batch);
          this.handleSocketFailure('write failure', err);
        });

        if (!ok) {
          const now = Date.now();
          if (now - this.lastWarnAt >= QuestDBWriteService.WARN_THROTTLE_MS) {
            this.lastWarnAt = now;
            this.logStructured('writer_backpressure', {
              buffered: this.queue.length,
              queueCapacity: this.QUEUE_MAX_SIZE,
            });
          }
          await this.waitDrain();
        } else {
          const latencyMs = Date.now() - writeStartedAt;
          this.lastWriteLatencyMs = latencyMs;
          this.latencyHistogram?.observe(latencyMs / 1000);
        }
      }
    } finally {
      this.isFlushing = false;
    }
  }

  async flushAll(): Promise<void> {
    await this.flushOnce();
  }

  /** Lightweight health snapshot for readiness/health endpoints. */
  getWriterHealth(): {
    queueSize: number;
    queueCapacity: number;
    reconnectAttempts: number;
    circuitState: 'closed' | 'open';
    backpressureState: 'ok' | 'warn' | 'drop';
    batchSizeCurrent: number;
  } {
    const queueSize = this.totalQueued();
    return {
      queueSize,
      queueCapacity: this.QUEUE_MAX_SIZE,
      reconnectAttempts: this.reconnectAttempts,
      circuitState: this.isCircuitOpen() ? 'open' : 'closed',
      backpressureState: this.getBackpressureState(),
      batchSizeCurrent: this.batchSizeCurrent,
    };
  }

  getMetrics() {
    const bufferSizeByChannel = Object.fromEntries(
      SOCKET_CHANNELS.map((ch) => [ch, this.queue.filter((i) => i.channel === ch).length]),
    ) as Record<SocketChannel, number>;
    const total = this.totalQueued();

    return {
      connected: { main: this.connected ? 1 : 0, trades: 0, candles: 0, orderbook: 0, events: 0 },
      buffers: bufferSizeByChannel,
      limits: {
        MAX_BATCH_SIZE: this.WRITE_BATCH_SIZE,
        FLUSH_CHUNK_ROWS: this.WRITE_BATCH_SIZE,
        BUFFER_MAX_ROWS: this.QUEUE_MAX_SIZE,
        BUFFER_HARD_LIMIT: this.QUEUE_HARD_LIMIT,
      },
      questdb_writer_connected: {
        total: this.connected ? 1 : 0,
        channels: { main: this.connected ? 1 : 0, trades: 0, candles: 0, orderbook: 0, events: 0 },
      },
      questdb_writer_buffer_size: {
        total,
        channels: bufferSizeByChannel,
      },
      questdb_writer_reconnect_attempts: {
        total: this.reconnectAttempts,
        channels: { main: this.reconnectAttempts, trades: 0, candles: 0, orderbook: 0, events: 0 },
      },
      questdb_writer_dropped_rows: {
        total: this.droppedRowsTotal,
        channels: this.droppedRowsByChannel,
      },
      questdb_writer_reconnect_total: { total: this.reconnectTriggeredTotal },
      questdb_writer_connection_state: {
        channels: { main: this.connectionState, trades: 'DISCONNECTED', candles: 'DISCONNECTED', orderbook: 'DISCONNECTED', events: 'DISCONNECTED' },
      },
      questdb_writer_write_failures_total: {
        total: this.writeFailuresTotal,
        channels: { main: this.writeFailuresTotal, trades: 0, candles: 0, orderbook: 0, events: 0 },
      },
      questdb_write_queue_size: total,
      questdb_write_batch_size: this.lastBatchSize,
      questdb_reconnect_attempts: this.reconnectAttempts,
      questdb_write_failures_total: this.writeFailuresTotal,
      questdb_write_success_total: this.writeSuccessTotal,
      questdb_write_latency_ms: this.lastWriteLatencyMs,
      questdb_write_dropped_total: this.droppedRowsTotal,
      questdb_write_dropped_overflow_total: this.droppedOverflowTotal,
      questdb_write_dropped_backpressure_total: this.droppedBackpressureTotal,
      questdb_write_dropped_shutdown_total: this.droppedShutdownTotal,
      questdb_circuit_state: this.isCircuitOpen() ? 1 : 0,
      questdb_backpressure_state: this.getBackpressureState() === 'ok' ? 0 : this.getBackpressureState() === 'warn' ? 1 : 2,
      questdb_batch_size_current: this.batchSizeCurrent,
    };
  }

  // ================================================================
  // Adaptive batching
  // ================================================================
  private getCurrentBatchSize(): number {
    return this.computeAdaptiveBatchSize();
  }

  private computeAdaptiveBatchSize(): number {
    const q = this.totalQueued();
    const cap = this.QUEUE_MAX_SIZE;
    if (cap <= 0) return this.ADAPTIVE_BATCH_TIERS[1];
    const pct = q / cap;
    if (pct < 0.2) return this.ADAPTIVE_BATCH_TIERS[0];
    if (pct < 0.5) return this.ADAPTIVE_BATCH_TIERS[1];
    if (pct < 0.8) return this.ADAPTIVE_BATCH_TIERS[2];
    return this.ADAPTIVE_BATCH_TIERS[3];
  }

  private updateBatchSizeMetric(newSize: number): void {
    if (newSize === this.batchSizeCurrent) return;
    const now = Date.now();
    if (now - this.lastBatchSizeChangeAt >= QuestDBWriteService.BATCH_SIZE_CHANGE_LOG_THROTTLE_MS) {
      this.lastBatchSizeChangeAt = now;
      this.logStructured('batch_size_changed', {
        previous: this.batchSizeCurrent,
        current: newSize,
        queueSize: this.totalQueued(),
        queueCapacity: this.QUEUE_MAX_SIZE,
      });
    }
    this.batchSizeCurrent = newSize;
  }

  // ================================================================
  // Backpressure
  // ================================================================
  private getBackpressureState(): 'ok' | 'warn' | 'drop' {
    const q = this.totalQueued();
    const cap = this.QUEUE_MAX_SIZE;
    if (cap <= 0) return 'ok';
    const pct = (q / cap) * 100;
    if (pct >= this.BACKPRESSURE_DROP_PCT) return 'drop';
    if (pct >= this.BACKPRESSURE_WARN_PCT) return 'warn';
    return 'ok';
  }

  // ================================================================
  // WriteBuffer
  // ================================================================
  private enqueue(channel: SocketChannel, line: string): void {
    if (!this.acceptingWrites) return;

    const cap = this.QUEUE_MAX_SIZE;
    const dropPctThreshold = this.BACKPRESSURE_DROP_PCT;
    const dropThreshold = Math.floor((cap * dropPctThreshold) / 100);

    if (this.totalQueued() >= this.QUEUE_HARD_LIMIT) {
      const prevTotal = this.droppedRowsTotal;
      this.droppedRowsTotal += 1;
      this.droppedOverflowTotal += 1;
      this.droppedRowsByChannel[channel] = (this.droppedRowsByChannel[channel] ?? 0) + 1;
      this.dropCounters?.overflow.inc();
      this.logDropAlertFirstTime(prevTotal);
      this.logStructured('write_dropped', {
        policy: 'hard_limit',
        reason: 'overflow',
        queueCapacity: this.QUEUE_MAX_SIZE,
      });
      return;
    }

    const backpressure = this.getBackpressureState();
    if (backpressure === 'drop' && this.totalQueued() >= dropThreshold) {
      const item = this.queue.shift();
      if (item) {
        const prevTotal = this.droppedRowsTotal;
        this.droppedRowsTotal += 1;
        this.droppedBackpressureTotal += 1;
        this.droppedRowsByChannel[item.channel] =
          (this.droppedRowsByChannel[item.channel] ?? 0) + 1;
        this.dropCounters?.backpressure.inc();
        this.logDropAlertFirstTime(prevTotal);
        this.logStructured('write_dropped', {
          policy: 'DROP_OLDEST',
          reason: 'backpressure',
          queueSize: this.queue.length,
          queueCapacity: cap,
        });
      }
    }

    if (backpressure === 'warn') {
      this.warnThrottledBackpressure();
    } else {
      this.queueWarnSince = 0;
    }

    this.queue.push({ channel, line });

    if (this.queue.length > this.QUEUE_MAX_SIZE) {
      const dropCount = this.queue.length - this.QUEUE_MAX_SIZE;
      const prevTotal = this.droppedRowsTotal;
      for (let i = 0; i < dropCount; i++) {
        const item = this.queue.shift();
        if (item) {
          this.droppedRowsTotal += 1;
          this.droppedOverflowTotal += 1;
          this.droppedRowsByChannel[item.channel] =
            (this.droppedRowsByChannel[item.channel] ?? 0) + 1;
        }
      }
      this.dropCounters?.overflow.inc(dropCount);
      this.logDropAlertFirstTime(prevTotal);
      this.logStructured('write_dropped', {
        policy: 'overflow',
        reason: 'overflow',
        droppedRows: dropCount,
        queueSize: this.queue.length,
      });
    }
  }

  /** Log once when dropped_total transitions from 0 to >0 (alert-oriented). */
  private logDropAlertFirstTime(prevDroppedTotal: number): void {
    if (prevDroppedTotal > 0) return;
    if (this.droppedRowsTotal <= 0) return;
    this.logger.warn(
      `QuestDB write_dropped_first total=${this.droppedRowsTotal} overflow=${this.droppedOverflowTotal} backpressure=${this.droppedBackpressureTotal} shutdown=${this.droppedShutdownTotal}`,
    );
    this.lastDroppedTotalLogged = this.droppedRowsTotal;
  }

  private warnThrottledBackpressure(): void {
    const now = Date.now();
    if (this.queueWarnSince === 0) this.queueWarnSince = now;
    const sustainedMs = now - this.queueWarnSince;
    if (sustainedMs >= QuestDBWriteService.QUEUE_WARN_SUSTAINED_MS) {
      if (now - this.lastWarnAt >= QuestDBWriteService.WARN_THROTTLE_MS) {
        this.lastWarnAt = now;
        this.logger.warn(
          `QuestDB queue above warning threshold for sustained period queueSize=${this.queue.length} queueCapacity=${this.QUEUE_MAX_SIZE} sustainedMs=${sustainedMs}`,
        );
        this.queueWarnSince = now;
      }
      return;
    }
    if (now - this.lastWarnAt < QuestDBWriteService.WARN_THROTTLE_MS) return;
    this.lastWarnAt = now;
    this.logStructured('writer_backpressure', {
      event: 'QuestDB backpressure detected',
      queueSize: this.queue.length,
      queueCapacity: this.QUEUE_MAX_SIZE,
      warnPct: this.BACKPRESSURE_WARN_PCT,
    });
  }

  private totalQueued(): number {
    return this.queue.length;
  }

  // ================================================================
  // Coalescing (optional: merge rows same table + timestamp + symbol).
  // Applied only to channels in COALESCE_CHANNELS (default: candles).
  // Trades, orderbook, events are not coalesced for semantic correctness.
  // ================================================================
  private coalescerKey(table: string, timestampNs: bigint, keys: Record<string, string | number>): string {
    const symbol = keys?.symbol ?? '';
    return `${table}|${timestampNs.toString()}|${String(symbol)}`;
  }

  private pushToCoalescer(channel: SocketChannel, opts: ILPWriteOptions): void {
    const ts = opts.timestampNs ?? this.nowNs();
    const table = opts.table;
    const keys = opts.keys ?? {};
    const key = this.coalescerKey(table, ts, keys);
    const existing = this.coalesceBuffer.get(key);
    if (existing) {
      const mergedFields = { ...existing.opts.fields, ...(opts.fields ?? {}) };
      existing.opts = { ...existing.opts, fields: mergedFields };
      this.coalesceAppliedCount += 1;
    } else {
      this.coalesceBuffer.set(key, {
        channel,
        opts: { table, keys, fields: { ...(opts.fields ?? {}) }, timestampNs: ts },
      });
    }
  }

  private scheduleCoalesceFlush(): void {
    if (this.coalesceFlushScheduled || this.coalesceBuffer.size === 0) return;
    this.coalesceFlushScheduled = setTimeout(() => {
      this.coalesceFlushScheduled = null;
      this.flushCoalescer();
    }, this.COALESCE_WINDOW_MS);
  }

  private flushCoalescer(): void {
    if (this.coalesceBuffer.size === 0) return;
    const applied = this.coalesceAppliedCount;
    if (applied > 0) {
      this.logStructured('coalesce_applied', { mergedRows: applied, flushedKeys: this.coalesceBuffer.size });
    }
    for (const { channel, opts } of this.coalesceBuffer.values()) {
      const line = this.buildILP(opts.table, opts.keys ?? {}, opts.fields ?? {}, opts.timestampNs ?? this.nowNs());
      if (line) this.enqueue(channel, line);
    }
    this.coalesceBuffer.clear();
    this.coalesceAppliedCount = 0;
  }

  // ================================================================
  // CircuitBreaker
  // ================================================================
  private isCircuitOpen(): boolean {
    return Date.now() < this.circuitOpenUntil;
  }

  /** Alert-oriented: log when circuit stays open longer than cooldown expectation. */
  private maybeLogCircuitOpenSustained(): void {
    if (this.circuitOpenLoggedSustained || this.circuitOpenedAt === 0) return;
    const elapsed = Date.now() - this.circuitOpenedAt;
    if (elapsed < this.CIRCUIT_COOLDOWN_MS) return;
    this.circuitOpenLoggedSustained = true;
    this.logger.warn(
      `QuestDB circuit still open past cooldown expectation elapsedMs=${elapsed} cooldownMs=${this.CIRCUIT_COOLDOWN_MS}`,
    );
  }

  private onCircuitResumed(): void {
    this.logger.warn('QuestDB writer_resumed');
  }

  // ================================================================
  // ConnectionSupervisor: single socket, backoff + jitter
  // ================================================================
  private async runReconnectWithBackoff(): Promise<void> {
    let delay = this.RECONNECT_BASE_MS;
    let attempt = 0;

    while (this.isRunning && !this.destroyed && !this.connected) {
      attempt += 1;
      this.reconnectAttempts += 1;

      const backoffMs = attempt === 1 ? this.RECONNECT_BASE_MS : delay;
      if (attempt === 1) {
        await this.sleep(backoffMs);
      } else {
        const jitter = Math.floor(Math.random() * (Math.min(500, delay / 2) + 1));
        await this.sleep(delay + jitter);
        delay = Math.min(delay * 2, this.RECONNECT_MAX_MS);
      }

      const now = Date.now();
      if (now - this.lastReconnectLogAt >= QuestDBWriteService.RECONNECT_LOG_THROTTLE_MS) {
        this.lastReconnectLogAt = now;
        this.debug(
          `QuestDB reconnect_attempt attempt=${attempt} backoffMs=${backoffMs} queuePending=${this.queue.length}`,
        );
      }

      const connected = await this.connectOnce();
      if (connected) {
        this.debug(`QuestDB reconnect_success attempt=${attempt}`);
        if (this.consecutiveWriteFailures >= this.CIRCUIT_FAILURE_THRESHOLD) {
          this.onCircuitResumed();
        }
        this.consecutiveWriteFailures = 0;
        void this.flushOnce();
        this.reconnectLoop = null;
        return;
      }
    }
    this.reconnectLoop = null;
  }

  private async connectOnce(): Promise<boolean> {
    this.connectionState = 'CONNECTING';
    const socket = new net.Socket();
    socket.setNoDelay(true);

    const connected = await new Promise<boolean>((resolve) => {
      let done = false;
      const timeout = setTimeout(() => {
        cleanup();
        this.safeDestroySocket(socket);
        resolve(false);
      }, this.CONNECT_TIMEOUT_MS);

      const cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        socket.removeAllListeners('connect');
        socket.removeAllListeners('error');
      };

      socket.once('connect', () => {
        cleanup();
        resolve(true);
      });

      socket.once('error', () => {
        cleanup();
        this.safeDestroySocket(socket);
        resolve(false);
      });

      try {
        socket.connect(this.port, this.host);
      } catch {
        cleanup();
        this.safeDestroySocket(socket);
        resolve(false);
      }
    });

    if (!connected || !this.isRunning || this.destroyed) {
      this.connectionState = 'DISCONNECTED';
      this.safeDestroySocket(socket);
      return false;
    }

    const previous = this.socket;
    if (previous && previous !== socket) {
      this.safeDestroySocket(previous);
    }

    this.socket = socket;
    this.connected = true;
    this.connectionState = 'CONNECTED';

    socket.on('drain', () => {
      this.resolveDrainWait();
      void this.flushOnce();
    });

    socket.on('error', (err: Error & { code?: string }) => {
      this.handleSocketFailure('socket error', err);
    });

    socket.on('close', (hadError) => {
      this.handleSocketFailure(`connection_lost hadError=${String(hadError)}`);
    });

    return true;
  }

  private handleSocketFailure(reason: string, err?: Error & { code?: string }): void {
    const code = String(err?.code ?? '');
    const isConnectionError =
      code === 'EPIPE' ||
      code === 'ECONNRESET' ||
      reason.includes('connection_lost') ||
      reason.includes('write failure');

    this.connected = false;
    this.connectionState = 'DISCONNECTED';
    this.resolveDrainWait();
    this.closeSocket(false);

    const queuePending = this.queue.length;
    const now = Date.now();
    if (now - this.lastReconnectLogAt >= QuestDBWriteService.RECONNECT_LOG_THROTTLE_MS) {
      this.lastReconnectLogAt = now;
      if (isConnectionError) {
        this.logStructured('connection_lost', {
          code: code || 'n/a',
          queuePending,
          error: err ? this.errorMessage(err) : undefined,
        });
      } else if (err) {
        this.logStructured('socket_failure', {
          reason,
          queuePending,
          error: this.errorMessage(err),
        });
      } else {
        this.logStructured('connection_lost', { reason, queuePending });
      }
    }

    this.maybeSwitchToIpv4Fallback(reason, code);
    this.reconnectTriggeredTotal += 1;
    if (!this.reconnectLoop) {
      this.reconnectLoop = this.runReconnectWithBackoff();
    }
  }

  private closeSocket(removeRef: boolean): void {
    const s = this.socket;
    if (!s) return;

    s.removeAllListeners();
    this.safeDestroySocket(s);
    if (removeRef) {
      this.socket = null;
    } else if (this.socket === s) {
      this.socket = null;
    }
  }

  private safeDestroySocket(socket: net.Socket): void {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }

  // ================================================================
  // Drain wait
  // ================================================================
  private waitDrain(): Promise<void> {
    if (this.drainWait) return this.drainWait.promise;

    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });

    const timeout = setTimeout(() => {
      this.resolveDrainWait();
      this.debug(`QuestDB drain wait timeout buffered=${this.queue.length}`);
    }, QuestDBWriteService.DRAIN_WAIT_MS);

    this.drainWait = { promise, resolve, timeout };
    return promise;
  }

  private resolveDrainWait(): void {
    const waiter = this.drainWait;
    if (!waiter) return;
    this.drainWait = null;
    clearTimeout(waiter.timeout);
    waiter.resolve();
  }

  private warnThrottled(message: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < QuestDBWriteService.WARN_THROTTLE_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(message);
  }

  private logStructured(event: string, data: Record<string, unknown>): void {
    const msg = `QuestDB ${event} ${JSON.stringify(data)}`;
    const warnEvents = [
      'write_dropped',
      'writer_backpressure',
      'writer_paused',
      'connection_lost',
      'socket_failure',
    ];
    if (warnEvents.includes(event)) {
      this.logger.warn(msg);
    } else if (this.debugEnabled) {
      this.logger.debug(msg);
    }
  }

  private async runFlushWorker(): Promise<void> {
    while (this.isRunning) {
      await this.flushOnce();
      const jitter =
        this.FLUSH_JITTER_MS > 0
          ? (Math.random() * 2 - 1) * this.FLUSH_JITTER_MS
          : 0;
      await this.sleep(Math.max(1, this.FLUSH_INTERVAL_MS + jitter));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  // ================================================================
  // ILP helpers
  // ================================================================
  private nowNs(): bigint {
    return BigInt(Date.now()) * 1_000_000n;
  }

  private buildILP(
    table: string,
    keys: Record<string, any>,
    fields: Record<string, any>,
    timestampNs: bigint,
  ): string | null {
    if (timestampNs <= 0n) {
      this.logger.warn(`ILP drop row: table=${table} invalid timestampNs=${timestampNs}`);
      return null;
    }

    const fieldParts = Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => this.formatField(k, v))
      .filter((x): x is string => Boolean(x));

    if (fieldParts.length === 0) {
      this.logger.warn(`ILP drop row: table=${table} has no fields`);
      return null;
    }

    const measurement = this.escapeMeasurement(table);
    const tagParts = Object.entries(keys)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${this.escapeTagKey(k)}=${this.escapeTagValue(v)}`);

    return `${measurement}${tagParts.length ? ',' + tagParts.join(',') : ''} ${fieldParts.join(',')} ${timestampNs.toString()}`;
  }

  private formatField(key: string, value: any): string | null {
    const k = this.escapeFieldKey(key);

    if (typeof value === 'string') {
      const v = this.escapeFieldString(value);
      return `${k}="${v}"`;
    }

    if (typeof value === 'boolean') return `${k}=${value ? 1 : 0}`;
    if (typeof value === 'number') return Number.isFinite(value) ? `${k}=${value}` : null;
    if (typeof value === 'bigint') return `${k}=${value.toString()}`;

    return null;
  }

  private escapeMeasurement(s: string): string {
    return String(s).replace(/,/g, '\\,').replace(/ /g, '\\ ');
  }
  private escapeTagKey(s: string): string {
    return String(s).replace(/,/g, '\\,').replace(/=/g, '\\=').replace(/ /g, '\\ ');
  }
  private escapeTagValue(v: any): string {
    return String(v).replace(/,/g, '\\,').replace(/=/g, '\\=').replace(/ /g, '\\ ');
  }
  private escapeFieldKey(s: string): string {
    return String(s).replace(/,/g, '\\,').replace(/=/g, '\\=').replace(/ /g, '\\ ');
  }
  private escapeFieldString(s: string): string {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
}
