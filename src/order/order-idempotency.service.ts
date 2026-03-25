import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import Redis from 'ioredis';

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

export const ORDER_IDEMPOTENCY_OPTIONS = 'ORDER_IDEMPOTENCY_OPTIONS';
type OrderIdempotencyOptions = {
  ttlMs?: number;
  lockTtlMs?: number;
};

@Injectable()
export class OrderIdempotencyService implements OnModuleDestroy {
  private readonly logger = new Logger(OrderIdempotencyService.name);
  private readonly lifecycleFile =
    'apps/provider/src/order/order-idempotency.service.ts';
  private readonly lifecycleClientId = `provider-order-idempotency-${
    process.pid
  }-${Math.random().toString(36).slice(2, 10)}`;
  private readonly prefix = 'bf:provider:orders:idemp:';
  private readonly ttlMs: number;
  private readonly lockTtlMs: number;

  private redis: Redis | null = null;
  private redisInitTried = false;
  private redisUnavailable = false;

  private readonly processingMap = new Map<string, CacheEntry<string>>();
  private readonly finalResponseMap = new Map<string, CacheEntry<unknown>>();

  constructor(
    @Optional()
    @Inject(ORDER_IDEMPOTENCY_OPTIONS)
    options?: OrderIdempotencyOptions,
  ) {
    this.ttlMs = Number(
      process.env.PROVIDER_ORDER_IDEMPOTENCY_TTL_MS ?? options?.ttlMs ?? 600000,
    );
    this.lockTtlMs = Number(options?.lockTtlMs ?? 30000);
  }

  async tryStartProcessing(idempotencyKey: string): Promise<boolean> {
    const key = this.normalizeKey(idempotencyKey);
    if (!key) return false;

    const redis = await this.getRedis();
    if (redis) {
      try {
        const result = await redis.set(
          this.getProcessingKey(key),
          '1',
          'PX',
          this.lockTtlMs,
          'NX',
        );
        return result === 'OK';
      } catch {
        // Fall through to in-memory mode if Redis becomes unavailable during runtime.
      }
    }

    const now = Date.now();
    const existing = this.processingMap.get(key);
    if (existing && existing.expiresAt > now) {
      return false;
    }

    this.processingMap.set(key, {
      value: '1',
      expiresAt: now + this.lockTtlMs,
    });
    return true;
  }

  async setFinalResponse<T>(
    idempotencyKey: string,
    response: T,
  ): Promise<void> {
    const key = this.normalizeKey(idempotencyKey);
    if (!key) return;

    const redis = await this.getRedis();
    if (redis) {
      try {
        await redis.set(
          this.getResultKey(key),
          JSON.stringify(response),
          'PX',
          this.ttlMs,
        );
        return;
      } catch {
        // Fall through to in-memory mode if Redis becomes unavailable during runtime.
      }
    }

    this.finalResponseMap.set(key, {
      value: response,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  async getFinalResponse<T>(idempotencyKey: string): Promise<T | null> {
    const key = this.normalizeKey(idempotencyKey);
    if (!key) return null;

    const redis = await this.getRedis();
    if (redis) {
      try {
        const value = await redis.get(this.getResultKey(key));
        if (!value) return null;
        return JSON.parse(value) as T;
      } catch {
        // Fall through to in-memory mode if Redis becomes unavailable during runtime.
      }
    }

    const now = Date.now();
    const entry = this.finalResponseMap.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now) {
      this.finalResponseMap.delete(key);
      return null;
    }

    return entry.value as T;
  }

  async waitForFinalResponse<T>(
    idempotencyKey: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<T | null> {
    const maxWaitMs = options?.maxWaitMs ?? 1200;
    const pollIntervalMs = options?.pollIntervalMs ?? 100;
    const startedAt = Date.now();

    while (Date.now() - startedAt < maxWaitMs) {
      const replay = await this.getFinalResponse<T>(idempotencyKey);
      if (replay) return replay;
      await this.delay(pollIntervalMs);
    }

    return null;
  }

  private async getRedis(): Promise<Redis | null> {
    if (this.redisUnavailable) return null;
    if (this.redis) return this.redis;
    if (this.redisInitTried) return null;

    this.redisInitTried = true;

    const host = process.env.REDIS_HOST;
    const portRaw = process.env.REDIS_PORT;
    const port = Number(portRaw ?? 6379);

    // Keep backward compatibility: if redis is not explicitly configured for this process,
    // run in in-memory mode without failing order execution.
    if (!host && !portRaw) {
      return null;
    }

    try {
      const client = new Redis({
        host: host ?? 'localhost',
        port,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 300,
      });
      this.logRedisLifecycle('created');
      client.on('connect', () => this.logRedisLifecycle('connect_event'));
      client.on('ready', () => this.logRedisLifecycle('ready'));
      client.on('close', () => this.logRedisLifecycle('closed'));
      client.on('end', () => this.logRedisLifecycle('disconnected'));
      client.on('reconnecting', () =>
        this.logRedisLifecycle('reconnect_attempt'),
      );
      client.on('error', () => this.logRedisLifecycle('error'));

      this.logRedisLifecycle('connect_start');
      await client.connect();
      this.logRedisLifecycle('connected');
      this.redis = client;
      return client;
    } catch (error: any) {
      this.redisUnavailable = true;
      this.logRedisLifecycle('connect_error');
      this.logger.warn(
        `[provider-idempotency] redis_unavailable reason=${String(
          error?.message ?? error ?? 'unknown',
        )}`,
      );
      return null;
    }
  }

  private getProcessingKey(key: string): string {
    return `${this.prefix}${key}:processing`;
  }

  private getResultKey(key: string): string {
    return `${this.prefix}${key}:result`;
  }

  private normalizeKey(value?: string): string | null {
    if (!value || typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length ? normalized : null;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private logRedisLifecycle(
    action: string,
    channels?: string | string[],
  ): void {
    const channelText = Array.isArray(channels)
      ? channels.join(',')
      : channels || '-';
    this.logger.warn(
      `[RedisLifecycle] clientId=${this.lifecycleClientId} action=${action} channels=${channelText} file=${this.lifecycleFile}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.redis;
    this.redis = null;
    if (!client) return;
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
}
