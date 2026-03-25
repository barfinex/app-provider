import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';
import type { IOwnershipStore } from './ownership-store.interface';
import { OwnershipRecord } from './ownership.types';

const KEY_PREFIX = 'bf:provider:ownership:';

/** Delay (ms) between background Redis connect retries. Env: REDIS_OWNERSHIP_RECONNECT_INTERVAL_MS */
const RECONNECT_INTERVAL_MS = Math.max(
  2000,
  Number(process.env.REDIS_OWNERSHIP_RECONNECT_INTERVAL_MS || 5000),
);

/** Redis-backed ownership store with atomic claim/renew/release via Lua. */
@Injectable()
export class RedisOwnershipStore
  implements IOwnershipStore, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedisOwnershipStore.name);
  private client!: RedisClientType;
  private connected = false;
  private isShuttingDown = false;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private reconnectTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly configService: ConfigService) {
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  async onModuleInit(): Promise<void> {
    const url =
      this.configService.get<string>('REDIS_URL') ??
      `redis://${this.configService.get('REDIS_HOST') ?? 'localhost'}:${
        this.configService.get('REDIS_PORT') ?? 6379
      }`;
    this.client = createClient({ url });
    this.client.on('error', (err) =>
      this.logger.warn(`Redis ownership store error: ${err?.message}`),
    );
    try {
      await this.client.connect();
      this.connected = true;
      this.resolveReady();
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `Redis ownership store: initial connect failed (${msg}). HTTP server will still bind; reconnecting in background every ${
          RECONNECT_INTERVAL_MS / 1000
        }s.`,
      );
      this.resolveReady();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = setInterval(() => {
      if (this.isShuttingDown) return;
      if (this.connected) {
        if (this.reconnectTimer) clearInterval(this.reconnectTimer);
        this.reconnectTimer = null;
        return;
      }
      this.client
        .connect()
        .then(() => {
          this.connected = true;
          if (this.reconnectTimer) {
            clearInterval(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          this.logger.log('Redis ownership store: reconnected.');
        })
        .catch((e) => {
          this.logger.debug(
            `Redis ownership store: reconnect failed (${
              e instanceof Error ? e.message : String(e)
            }).`,
          );
        });
    }, RECONNECT_INTERVAL_MS);
  }

  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    this.connected = false;
    if (this.reconnectTimer != null) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    if (!client) return;
    try {
      await client.quit();
    } catch (e) {
      // quit() can reject if client already closed or socket closed; avoid disconnect() to prevent
      // ClientClosedError and command-queue races (Cannot destructure 'resolve' of undefined).
      const msg = (e as Error)?.message ?? '';
      if (
        !msg.includes('closed') &&
        (e as Error & { name?: string })?.name !== 'ClientClosedError'
      ) {
        this.logger.debug(
          `Redis ownership store quit failed on shutdown: ${msg}`,
        );
      }
    }
  }

  private key(k: string): string {
    return `${KEY_PREFIX}${k}`;
  }

  async claim(
    ownershipKey: string,
    ownerInstanceId: string,
    leaseDurationMs: number,
  ): Promise<{
    success: boolean;
    fencingToken?: number;
    current?: OwnershipRecord;
  }> {
    if (!this.connected) {
      return { success: false, current: undefined };
    }
    const key = this.key(ownershipKey);
    const now = Date.now();
    const leaseExpiresAt = now + leaseDurationMs;

    // Lua: get current; if exists and not expired, return 0 and current; else set new and return 1, token
    const script = `
      local k = KEYS[1]
      local owner = ARGV[1]
      local leaseExp = tonumber(ARGV[2])
      local now = tonumber(ARGV[3])
      local ttl = tonumber(ARGV[4])
      local logicalKey = ARGV[5]
      local v = redis.call('GET', k)
      local token = 1
      if v and v ~= '' then
        local r = cjson.decode(v)
        if r.leaseExpiresAt and r.leaseExpiresAt > now then
          r.ownershipKey = logicalKey
          return cjson.encode({ok = 0, current = r})
        end
        token = (r.fencingToken or 0) + 1
      end
      local rec = {
        ownershipKey = logicalKey,
        ownerInstanceId = owner,
        fencingToken = token,
        leaseExpiresAt = leaseExp,
        lastHeartbeat = now
      }
      redis.call('SET', k, cjson.encode(rec), 'PX', ttl)
      return cjson.encode({ok = 1, fencingToken = token})
    `;

    try {
      const result = await this.client.eval(script, {
        keys: [key],
        arguments: [
          ownerInstanceId,
          String(leaseExpiresAt),
          String(now),
          String(leaseDurationMs),
          ownershipKey,
        ],
      });
      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      if (parsed.ok === 1) {
        return { success: true, fencingToken: parsed.fencingToken };
      }
      const cur = parsed.current as OwnershipRecord | undefined;
      if (cur) {
        cur.ownershipKey = ownershipKey;
      }
      return { success: false, current: cur };
    } catch (e) {
      this.logger.warn(
        `Ownership claim failed key=${ownershipKey} err=${
          (e as Error)?.message
        }`,
      );
      return { success: false };
    }
  }

  async renew(
    ownershipKey: string,
    ownerInstanceId: string,
    fencingToken: number,
    leaseDurationMs: number,
  ): Promise<boolean> {
    if (!this.connected) return false;
    const key = this.key(ownershipKey);
    const now = Date.now();
    const leaseExpiresAt = now + leaseDurationMs;

    const script = `
      local k = KEYS[1]
      local v = redis.call('GET', k)
      if not v or v == '' then return 0 end
      local r = cjson.decode(v)
      if r.ownerInstanceId ~= ARGV[1] or tonumber(r.fencingToken) ~= tonumber(ARGV[2]) then
        return 0
      end
      r.leaseExpiresAt = tonumber(ARGV[3])
      r.lastHeartbeat = tonumber(ARGV[4])
      redis.call('SET', k, cjson.encode(r), 'PX', tonumber(ARGV[5]))
      return 1
    `;

    try {
      const result = await this.client.eval(script, {
        keys: [key],
        arguments: [
          ownerInstanceId,
          String(fencingToken),
          String(leaseExpiresAt),
          String(now),
          String(leaseDurationMs),
        ],
      });
      return Number(result) === 1;
    } catch (e) {
      this.logger.warn(
        `Ownership renew failed key=${ownershipKey} err=${
          (e as Error)?.message
        }`,
      );
      return false;
    }
  }

  async release(
    ownershipKey: string,
    ownerInstanceId: string,
    fencingToken: number,
  ): Promise<boolean> {
    if (!this.connected) return false;
    const key = this.key(ownershipKey);

    const script = `
      local k = KEYS[1]
      local v = redis.call('GET', k)
      if not v or v == '' then return 1 end
      local r = cjson.decode(v)
      if r.ownerInstanceId ~= ARGV[1] or tonumber(r.fencingToken) ~= tonumber(ARGV[2]) then
        return 0
      end
      redis.call('DEL', k)
      return 1
    `;

    try {
      const result = await this.client.eval(script, {
        keys: [key],
        arguments: [ownerInstanceId, String(fencingToken)],
      });
      return Number(result) === 1;
    } catch (e) {
      this.logger.warn(
        `Ownership release failed key=${ownershipKey} err=${
          (e as Error)?.message
        }`,
      );
      return false;
    }
  }

  async get(ownershipKey: string): Promise<OwnershipRecord | null> {
    if (!this.connected) return null;
    const key = this.key(ownershipKey);
    try {
      const v = await this.client.get(key);
      if (!v) return null;
      const r = JSON.parse(v) as OwnershipRecord;
      r.ownershipKey = ownershipKey;
      return r;
    } catch {
      return null;
    }
  }

  async listKeys(prefix: string): Promise<string[]> {
    if (!this.connected) return [];
    const fullPrefix = this.key(prefix || '');
    try {
      const keys: string[] = [];
      for await (const k of this.client.scanIterator({
        MATCH: `${fullPrefix}*`,
        COUNT: 100,
      })) {
        keys.push(k.replace(KEY_PREFIX, ''));
      }
      return keys;
    } catch {
      return [];
    }
  }
}
