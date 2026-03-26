import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EventBusService } from '@barfinex/event-bus';
import { EventMessageByType, SubscriptionType } from '@barfinex/types';
import { randomUUID } from 'crypto';
import { Counter, Gauge, Histogram, register } from 'prom-client';

type QueuedEmitEvent = {
  pattern: SubscriptionType;
  payload: Record<string, unknown>;
};

@Injectable()
export class ExchangeRedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExchangeRedisService.name);
  private readonly debugEnabled = process.env.EVENTBUS_DEBUG === 'true';
  private readonly eventSource = process.env.SERVICE_NAME || 'provider';
  private readonly emitQueueMaxSize = Math.max(
    1_000,
    Number(process.env.REDIS_EMIT_QUEUE_MAX_SIZE || 5_000),
  );
  private readonly emitQueue: QueuedEmitEvent[] = [];
  private readonly disconnectedLatestByPattern = new Map<
    SubscriptionType,
    Record<string, unknown>
  >();
  private static readonly DISCONNECTED_BUFFER_MAX_PATTERNS = 100;
  private readonly healthIntervalMs = 10_000;
  private readonly emitErrorCooldownMs = Math.max(
    250,
    Number(process.env.REDIS_EMIT_ERROR_COOLDOWN_MS || 5_000),
  );
  private readonly emitLogThrottleMs = Math.max(
    250,
    Number(process.env.REDIS_EMIT_DEBUG_THROTTLE_MS || 1_000),
  );
  private readonly emitDisconnectedWarnThrottleMs = Math.max(
    1_000,
    Number(process.env.REDIS_EMIT_QUEUE_WARN_THROTTLE_MS || 5_000),
  );

  public isEmitToRedisEnabled = true;
  private clientConnected = true;
  private droppedQueuedEvents = 0;
  private disconnectedBufferOverwriteCount = 0;
  private flushInFlight = false;
  private emitSuspendedUntil = 0;
  private healthInterval?: NodeJS.Timeout;
  private flushInterval?: NodeJS.Timeout;
  private lastEmitLogAt = 0;
  private lastEmitDisconnectedWarnAt = 0;
  private readonly publishErrorsTotal: Counter<string>;
  private readonly publishLatencyMs: Histogram<string>;
  private readonly emitQueueSizeGauge: Gauge<string>;
  private readonly consumerLagMs: Histogram<string>;
  private lastObservedConsumerLagMs = 0;

  constructor(private readonly eventBus: EventBusService) {
    this.publishErrorsTotal = this.getOrCreatePublishErrorsCounter();
    this.publishLatencyMs = this.getOrCreatePublishLatencyHistogram();
    this.emitQueueSizeGauge = this.getOrCreateEmitQueueGauge();
    this.consumerLagMs = this.getOrCreateConsumerLagHistogram();
  }

  async onModuleInit(): Promise<void> {
    const port = Number(process.env.REDIS_PORT ?? '6379');
    if (Number.isNaN(port) || port <= 0 || port > 65535) {
      this.logger.error(`Invalid Redis port: ${port}`);
      throw new InternalServerErrorException('Invalid Redis port');
    }
    this.clientConnected = true;
    this.updateRedisQueueMetrics();
    this.startHealthDiagnostics();
    this.startFlushLoop();
  }

  emit<TPayload extends object>(
    pattern: SubscriptionType,
    data: TPayload,
  ): void {
    if (!this.isEmitToRedisEnabled) return;
    const payload = {
      ...data,
      metadata: this.normalizeEventMetadata(
        (
          data as {
            metadata?: EventMessageByType<SubscriptionType>['metadata'];
          }
        ).metadata,
      ),
    };
    const now = Date.now();
    const emitSuspended = now < this.emitSuspendedUntil;
    if (emitSuspended) {
      this.publishErrorsTotal.inc();
      if (
        now - this.lastEmitDisconnectedWarnAt >=
        this.emitDisconnectedWarnThrottleMs
      ) {
        this.lastEmitDisconnectedWarnAt = now;
        this.logger.warn(
          `[RedisEmitSkip] pattern=${String(
            pattern,
          )} suspended=true buffered_patterns=${
            this.disconnectedLatestByPattern.size
          }`,
        );
      }
      this.bufferDisconnectedEmitEvent(
        pattern,
        payload as Record<string, unknown>,
      );
      return;
    }
    this.enqueueEmitEvent(pattern, payload as Record<string, unknown>);
    void this.flushQueuedEvents();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.healthInterval) clearInterval(this.healthInterval);
    if (this.flushInterval) clearInterval(this.flushInterval);
    this.clientConnected = false;
  }

  getMetrics() {
    return {
      connected: this.clientConnected ? 1 : 0,
      reconnectAttempt: 0,
      reconnectTotal: 0,
      emitQueueSize: this.emitQueue.length,
      emitQueueMaxSize: this.emitQueueMaxSize,
      queuedEvents: this.emitQueue.length,
      disconnectedBufferedPatterns: this.disconnectedLatestByPattern.size,
      disconnectedBufferOverwriteCount: this.disconnectedBufferOverwriteCount,
      droppedQueuedEvents: this.droppedQueuedEvents,
      flushInFlight: this.flushInFlight ? 1 : 0,
      consumerLagMs: this.lastObservedConsumerLagMs,
    };
  }

  private normalizeEventMetadata(
    metadata?: EventMessageByType<SubscriptionType>['metadata'],
  ) {
    const eventId = metadata?.eventId ?? randomUUID();
    return {
      eventId,
      traceId: metadata?.traceId || eventId,
      timestamp: metadata?.timestamp ?? Date.now(),
      version: metadata?.version ?? 1,
      source: metadata?.source ?? this.eventSource,
    };
  }

  private enqueueEmitEvent(
    pattern: SubscriptionType,
    payload: Record<string, unknown>,
  ): void {
    this.emitQueue.push({ pattern, payload });
    this.updateRedisQueueMetrics();
    if (this.emitQueue.length <= this.emitQueueMaxSize) return;

    const dropped = this.emitQueue.length - this.emitQueueMaxSize;
    this.emitQueue.splice(0, dropped);
    this.droppedQueuedEvents += dropped;
    this.updateRedisQueueMetrics();
    this.logger.warn(
      `[RedisEmitQueueOverflow] dropped_events=${dropped} queue_size=${this.emitQueue.length} dropped_total=${this.droppedQueuedEvents}`,
    );
  }

  private bufferDisconnectedEmitEvent(
    pattern: SubscriptionType,
    payload: Record<string, unknown>,
  ): void {
    if (this.disconnectedLatestByPattern.has(pattern)) {
      this.disconnectedBufferOverwriteCount += 1;
    }
    if (
      !this.disconnectedLatestByPattern.has(pattern) &&
      this.disconnectedLatestByPattern.size >=
        ExchangeRedisService.DISCONNECTED_BUFFER_MAX_PATTERNS
    ) {
      const oldestKey = this.disconnectedLatestByPattern.keys().next().value;
      if (oldestKey !== undefined)
        this.disconnectedLatestByPattern.delete(oldestKey);
    }
    this.disconnectedLatestByPattern.set(pattern, payload);
    this.updateRedisQueueMetrics();
  }

  private drainDisconnectedBufferToQueue(): void {
    if (this.disconnectedLatestByPattern.size === 0) return;
    for (const [
      pattern,
      payload,
    ] of this.disconnectedLatestByPattern.entries()) {
      this.enqueueEmitEvent(pattern, payload);
    }
    this.disconnectedLatestByPattern.clear();
    this.updateRedisQueueMetrics();
  }

  private static readonly FLUSH_BATCH_SIZE = 50;

  private async flushQueuedEvents(): Promise<void> {
    if (this.flushInFlight) return;
    if (Date.now() < this.emitSuspendedUntil) return;
    this.flushInFlight = true;
    this.drainDisconnectedBufferToQueue();

    try {
      while (this.emitQueue.length > 0) {
        const batch = this.emitQueue.splice(
          0,
          ExchangeRedisService.FLUSH_BATCH_SIZE,
        );
        await Promise.all(
          batch.map((evt) => this.publishSingle(evt.pattern, evt.payload)),
        );
      }
    } finally {
      this.updateRedisQueueMetrics();
      this.flushInFlight = false;
    }
  }

  private async publishSingle(
    pattern: SubscriptionType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const startAt = process.hrtime.bigint();
    const traceId = this.extractTraceId(payload);
    const consumerLagMs = this.extractConsumerLagMs(payload);
    if (consumerLagMs !== null) {
      this.lastObservedConsumerLagMs = consumerLagMs;
      this.consumerLagMs.observe(consumerLagMs);
    }

    if (
      this.debugEnabled &&
      Date.now() - this.lastEmitLogAt >= this.emitLogThrottleMs
    ) {
      this.lastEmitLogAt = Date.now();
      this.logger.debug(
        `[RedisEmit] pattern=${String(pattern)} trace=${traceId ?? 'n/a'}`,
      );
    }

    try {
      await this.eventBus.publish({
        channel: pattern,
        payload,
      });
      this.clientConnected = true;
    } catch (error) {
      this.publishErrorsTotal.inc();
      this.clientConnected = false;
      this.emitSuspendedUntil = Date.now() + this.emitErrorCooldownMs;
      this.logger.error(
        `[RedisEmitError] pattern=${String(pattern)} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.enqueueEmitEvent(pattern, payload);
      throw error;
    } finally {
      const latencyMs = Number(process.hrtime.bigint() - startAt) / 1_000_000;
      if (Number.isFinite(latencyMs) && latencyMs >= 0) {
        this.publishLatencyMs.observe(latencyMs);
      }
    }
  }

  private startHealthDiagnostics(): void {
    if (this.healthInterval) return;
    this.healthInterval = setInterval(() => {
      if (this.debugEnabled) {
        this.logger.debug(
          `[RedisHealth] connected=${this.clientConnected} queue=${this.emitQueue.length}`,
        );
      }
    }, this.healthIntervalMs);
  }

  private startFlushLoop(): void {
    if (this.flushInterval) return;
    this.flushInterval = setInterval(() => {
      void this.flushQueuedEvents();
    }, 250);
  }

  private extractTraceId(data: unknown): string | undefined {
    const maybeMetadata = (
      data as { metadata?: { traceId?: unknown } } | undefined
    )?.metadata;
    const traceId = maybeMetadata?.traceId;
    return typeof traceId === 'string' && traceId.length > 0
      ? traceId
      : undefined;
  }

  private getOrCreatePublishErrorsCounter(): Counter<string> {
    const existing = register.getSingleMetric(
      'provider_redis_publish_errors_total',
    );
    if (existing) return existing as Counter<string>;
    return new Counter({
      name: 'provider_redis_publish_errors_total',
      help: 'Total Redis publish errors in Provider service',
      registers: [register],
    });
  }

  private getOrCreatePublishLatencyHistogram(): Histogram<string> {
    const existing = register.getSingleMetric(
      'provider_redis_publish_latency_ms',
    );
    if (existing) return existing as Histogram<string>;
    return new Histogram({
      name: 'provider_redis_publish_latency_ms',
      help: 'Redis publish call latency in milliseconds',
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50],
      registers: [register],
    });
  }

  private getOrCreateEmitQueueGauge(): Gauge<string> {
    const existing = register.getSingleMetric('provider_redis_emit_queue_size');
    if (existing) return existing as Gauge<string>;
    return new Gauge({
      name: 'provider_redis_emit_queue_size',
      help: 'Pending Redis emits buffered in memory (queue + disconnected latest-by-pattern)',
      registers: [register],
    });
  }

  private getOrCreateConsumerLagHistogram(): Histogram<string> {
    const existing = register.getSingleMetric('provider_redis_consumer_lag_ms');
    if (existing) return existing as Histogram<string>;
    return new Histogram({
      name: 'provider_redis_consumer_lag_ms',
      help: 'Observed lag between event update timestamp and Redis publish attempt (ms)',
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000],
      registers: [register],
    });
  }

  private updateRedisQueueMetrics(): void {
    this.emitQueueSizeGauge.set(
      this.emitQueue.length + this.disconnectedLatestByPattern.size,
    );
  }

  private extractConsumerLagMs(
    payload: Record<string, unknown>,
  ): number | null {
    const optionsMoment = (payload as { options?: { updateMoment?: unknown } })
      .options?.updateMoment;
    const metadataMoment = (payload as { metadata?: { timestamp?: unknown } })
      .metadata?.timestamp;
    const sourceTimestamp = Number(optionsMoment ?? metadataMoment);
    if (!Number.isFinite(sourceTimestamp) || sourceTimestamp <= 0) return null;
    const lag = Date.now() - sourceTimestamp;
    if (!Number.isFinite(lag)) return null;
    return Math.max(0, lag);
  }
}
