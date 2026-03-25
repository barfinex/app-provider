import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { Client } from 'pg';

/**
 * QuestDB SQL Reader (PostgreSQL wire protocol)
 * Устойчивый, безопасный, с очередью как API, но каждый запрос работает
 * через НОВОЕ соединение (QuestDB не рвёт короткие соединения).
 */
/** Макс. длина SQL в логе (для поиска запроса, вызвавшего suspended). */
const QUESTDB_SQL_LOG_MAX_LEN = 400;
const QUESTDB_QUERY_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.QUESTDB_QUERY_MAX_ATTEMPTS ?? 3),
);
const QUESTDB_QUERY_RETRY_BASE_MS = Math.max(
  50,
  Number(process.env.QUESTDB_QUERY_RETRY_BASE_MS ?? 200),
);
const QUESTDB_QUERY_RETRY_MAX_DELAY_MS = Math.max(
  QUESTDB_QUERY_RETRY_BASE_MS,
  Number(process.env.QUESTDB_QUERY_RETRY_MAX_DELAY_MS ?? 3000),
);
const QUESTDB_QUERY_QUEUE_MAX_SIZE = Math.max(
  100,
  Number(process.env.QUESTDB_QUERY_QUEUE_MAX_SIZE ?? 5000),
);

const WAL_DRAIN_INITIAL_SLEEP_MS = 500;
const WAL_DRAIN_BACKOFF_SLEEP_MS = 1000;
const WAL_DRAIN_INITIAL_ATTEMPTS = 5;
const WAL_DRAIN_MAX_SLEEP_MS = 2000;
const WAL_RESUME_THROTTLE_MS = 5000;
const WAL_SUSPENDED_STREAK_FOR_RESUME = 2;
const WAL_HEALTHY_STREAK_REQUIRED = 2;

export interface WaitForWalDrainOptions {
  timeoutMs?: number;
  lagThreshold?: number;
}

function safeTableName(table: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(table);
}

@Injectable()
export class QuestDBQueryService implements OnModuleInit, OnModuleDestroy {
  private connected = false;
  private destroyed = false;
  private readonly debugEnabled = process.env.QUESTDB_DEBUG === 'true';

  /** Single-flight per table: only one concurrent RESUME WAL per table. */
  private walResumeLocks = new Map<string, Promise<void>>();
  private walLastResumeAt = new Map<string, number>();

  // Очередь всё ещё работает, но теперь каждый запрос создаёт свой PG-клиент
  private queue: {
    sql: string;
    resolve: (v: any) => void;
    reject: (e: any) => void;
  }[] = [];

  private readonly logger = new Logger('QuestDBQuery');

  /** Счётчик операций: по нему в логах можно найти запрос перед suspended. */
  private sqlOpId = 0;

  /** Лог SQL выключен по умолчанию; включается только при QUESTDB_LOG_SQL=true. */
  private readonly logSql = process.env.QUESTDB_LOG_SQL === 'true';

  private readonly configuredHost = (process.env.QUESTDB_HOST || '127.0.0.1')
    .trim()
    .replace(/^localhost$/i, '127.0.0.1');
  private currentHost = this.configuredHost;
  private readonly hasIpv4Fallback = false;
  private readonly port = Number(process.env.QUESTDB_PG_PORT || 8812);
  private readonly user = process.env.QUESTDB_USER || 'admin';
  private readonly password = process.env.QUESTDB_PASSWORD || 'quest';
  private readonly database = process.env.QUESTDB_DATABASE || 'qdb';

  private debug(message: string): void {
    if (this.debugEnabled) {
      this.logger.debug(message);
    }
  }

  // ============================================================
  // INIT
  // ============================================================
  async onModuleInit() {
    this.logger.log(
      `Initializing QuestDB PG connection handler: ${this.currentHost}:${this.port}`,
    );

    // Не подключаемся заранее — это провоцирует обрывы!
    // Просто считаем сервис "готовым".
    this.connected = true;

    this.flushQueue();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    this.connected = false;
    const pending = this.queue.splice(0);
    if (pending.length > 0) {
      this.logger.warn(
        `[QuestDBQuery] rejecting ${pending.length} queued queries on shutdown`,
      );
      const err = new Error('QuestDBQueryService is shutting down');
      for (const item of pending) {
        item.reject(err);
      }
    }
  }

  // ============================================================
  // PG CLIENT FACTORY — создаёт новое соединение под каждый запрос
  // ============================================================
  private makeClient(): Client {
    return new Client({
      host: this.currentHost,
      port: this.port,
      user: this.user,
      password: this.password,
      database: this.database,
      keepAlive: true,
    });
  }

  private maybeSwitchToIpv4Fallback(err: unknown): void {
    if (!this.hasIpv4Fallback) return;
    if (this.currentHost === '127.0.0.1') return;
    if (!this.isRetriableConnectionError(err)) return;
    this.currentHost = '127.0.0.1';
    this.logger.warn(
      'QuestDB PG localhost connection is unstable; switching to 127.0.0.1 fallback',
    );
  }

  // ============================================================
  // QUEUE — API остаётся, но теперь не зависит от единственного клиента
  // ============================================================
  private enqueue(sql: string): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error('QuestDBQueryService is shutting down'));
        return;
      }
      if (this.queue.length >= QUESTDB_QUERY_QUEUE_MAX_SIZE) {
        this.logger.error(
          `[QuestDBQuery] queue overflow size=${this.queue.length} max=${QUESTDB_QUERY_QUEUE_MAX_SIZE}`,
        );
        reject(
          new Error(
            `QuestDB query queue overflow (max=${QUESTDB_QUERY_QUEUE_MAX_SIZE})`,
          ),
        );
        return;
      }
      this.queue.push({ sql, resolve, reject });
      this.flushQueue();
    });
  }

  private async flushQueue() {
    if (!this.connected) return;
    if (this.queue.length === 0) return;

    const item = this.queue.shift();
    if (!item) return;

    try {
      const res = await this.executeSql(item.sql);
      item.resolve(res);
    } catch (err) {
      item.reject(err);
    }

    setImmediate(() => this.flushQueue());
  }

  // ============================================================
  // CORE: корректное выполнение SQL с новым соединением каждый раз
  // ============================================================
  private async executeSql(sql: string, retry = 1): Promise<any> {
    const client = this.makeClient();
    const opId = ++this.sqlOpId;
    const logSql =
      sql.length > QUESTDB_SQL_LOG_MAX_LEN
        ? sql.slice(0, QUESTDB_SQL_LOG_MAX_LEN) + '...'
        : sql;
    if (this.logSql) {
      this.logger.log(
        `[QuestDB SQL #${opId}] ${logSql.replace(/\s+/g, ' ').trim()}`,
      );
    }

    try {
      await client.connect();
      const res = await client.query(sql);
      return res;
    } catch (err) {
      const message =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const retriable = this.isRetriableConnectionError(err);

      if (retriable && retry < QUESTDB_QUERY_MAX_ATTEMPTS) {
        this.maybeSwitchToIpv4Fallback(err);
        const delay = Math.min(
          QUESTDB_QUERY_RETRY_MAX_DELAY_MS,
          QUESTDB_QUERY_RETRY_BASE_MS * Math.pow(2, retry - 1),
        );
        const logLine = `[QuestDB SQL #${opId}] transient connection error (attempt ${retry}/${QUESTDB_QUERY_MAX_ATTEMPTS}): ${message}. Retrying in ${delay}ms`;
        if (retry === 1) {
          this.logger.warn(logLine);
        } else {
          this.debug(logLine);
        }
        await new Promise((r) => setTimeout(r, delay));
        return this.executeSql(sql, retry + 1);
      }

      this.logger.error(
        `[QuestDB SQL #${opId}] FAILED (attempt ${retry}/${QUESTDB_QUERY_MAX_ATTEMPTS}): ${logSql
          .replace(/\s+/g, ' ')
          .trim()}`,
        err,
      );

      throw err;
    } finally {
      await client.end().catch(() => {});
    }
  }

  // ============================================================
  // PUBLIC API — полностью сохранён
  // ============================================================
  async query(sql: string) {
    return this.enqueue(sql);
  }

  async queryAsObjects(sql: string): Promise<any[]> {
    const result = await this.query(sql);

    if (!result?.rows?.length) return [];

    return result.rows.map((row: any) => {
      const obj: any = {};

      for (const key of Object.keys(row)) {
        const value = row[key];

        obj[key] = value;
      }

      return obj;
    });
  }

  async queryOne(sql: string): Promise<any | null> {
    const rows = await this.queryAsObjects(sql);
    return rows.length ? rows[0] : null;
  }

  async queryValue<T = any>(sql: string): Promise<T | null> {
    const row = await this.queryOne(sql);
    if (!row) return null;
    return Object.values(row)[0] as T;
  }

  // ============================================================
  // WAL management (single-flight resume, drain, healthy)
  // ============================================================

  /** Single place for wal_tables() query; avoids duplicate checks. */
  private async queryWalState(table: string): Promise<{
    suspended: boolean;
    writerTxn: number;
    sequencerTxn: number;
  } | null> {
    if (!safeTableName(table)) return null;
    const rows = await this.queryAsObjects(
      `SELECT * FROM wal_tables() WHERE name = '${table}'`,
    );
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    if (!row) return null;
    return {
      suspended: Boolean(row.suspended),
      writerTxn: Number(row.writerTxn ?? row.writer_txn ?? 0),
      sequencerTxn: Number(row.sequencerTxn ?? row.sequencer_txn ?? 0),
    };
  }

  /**
   * Single-flight RESUME WAL per table. Concurrent callers for the same table
   * await the same promise; only one ALTER TABLE runs.
   */
  private async resumeWalSingleFlight(table: string): Promise<void> {
    if (!safeTableName(table)) return;

    if (this.walResumeLocks.has(table)) {
      return this.walResumeLocks.get(table)!;
    }

    const promise = (async () => {
      try {
        const state = await this.queryWalState(table);
        if (state?.suspended === true) {
          const now = Date.now();
          const lastResumeAt = this.walLastResumeAt.get(table) ?? 0;
          if (now - lastResumeAt < WAL_RESUME_THROTTLE_MS) {
            this.debug(
              `[WAL] resume cooldown for ${table} (${WAL_RESUME_THROTTLE_MS}ms)`,
            );
            return;
          }
          this.debug(`[WAL] resume triggered for ${table}`);
          await this.query(`ALTER TABLE ${table} RESUME WAL`);
          this.walLastResumeAt.set(table, now);
        }
      } finally {
        this.walResumeLocks.delete(table);
      }
    })();

    this.walResumeLocks.set(table, promise);
    return promise;
  }

  /** Public API: trigger single-flight RESUME WAL if table is suspended. */
  async resumeWalIfNeeded(table: string): Promise<void> {
    await this.resumeWalSingleFlight(table);
  }

  /**
   * Return current WAL lag (sequencerTxn - writerTxn) for the table. 0 if no row or invalid.
   */
  async getWalLag(table: string): Promise<number> {
    if (!safeTableName(table)) return 0;
    const state = await this.queryWalState(table);
    if (!state) return 0;
    const lag = state.sequencerTxn - state.writerTxn;
    return Number.isFinite(lag) ? lag : 0;
  }

  /**
   * Return current WAL state for the table: lag and suspended flag. For use by WAL-aware ingestion.
   */
  async getWalState(
    table: string,
  ): Promise<{ lag: number; suspended: boolean }> {
    if (!safeTableName(table)) return { lag: 0, suspended: false };
    const state = await this.queryWalState(table);
    if (!state) return { lag: 0, suspended: false };
    const lag = state.sequencerTxn - state.writerTxn;
    return {
      lag: Number.isFinite(lag) ? lag : 0,
      suspended: state.suspended,
    };
  }

  /**
   * Wait until WAL lag is <= maxLag or timeout. Does not throw; logs warning on timeout.
   */
  async waitForWalCatchup(
    table: string,
    maxLag: number,
    timeoutMs = 10_000,
  ): Promise<void> {
    if (!safeTableName(table)) return;
    const started = Date.now();
    while (true) {
      const lag = await this.getWalLag(table);
      if (lag <= maxLag) return;
      if (Date.now() - started > timeoutMs) {
        this.logger.warn(
          `[WAL] waitForWalCatchup timeout | table=${table} | lag=${lag}`,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * Wait until WAL apply catches up (suspended === false and lag <= lagThreshold).
   * Never throws; on timeout or error logs and continues so startup is not blocked.
   */
  async waitForWalDrain(
    table: string,
    optionsOrTimeout?: number | WaitForWalDrainOptions,
  ): Promise<void> {
    if (!safeTableName(table)) return;

    const options: Required<WaitForWalDrainOptions> =
      typeof optionsOrTimeout === 'number'
        ? { timeoutMs: optionsOrTimeout, lagThreshold: 10 }
        : {
            timeoutMs: optionsOrTimeout?.timeoutMs ?? 45000,
            lagThreshold: optionsOrTimeout?.lagThreshold ?? 10,
          };

    try {
      const start = Date.now();
      let attempt = 0;
      let sleepMs = WAL_DRAIN_INITIAL_SLEEP_MS;
      let suspendedStreak = 0;
      let healthyStreak = 0;

      while (true) {
        const state = await this.queryWalState(table);
        if (!state) {
          this.debug('[WAL] drain completed');
          return;
        }

        const lag = state.sequencerTxn - state.writerTxn;
        this.debug(
          `[WAL] checking table=${table} lag=${lag} suspended=${state.suspended}`,
        );

        if (state.suspended) {
          healthyStreak = 0;
          suspendedStreak += 1;
          if (suspendedStreak >= WAL_SUSPENDED_STREAK_FOR_RESUME) {
            this.logger.warn(
              `[WAL] table=${table} suspended(${suspendedStreak}) — triggering RESUME WAL`,
            );
            await this.resumeWalSingleFlight(table);
          }
        } else if (lag <= options.lagThreshold) {
          healthyStreak += 1;
          suspendedStreak = 0;
          if (healthyStreak >= WAL_HEALTHY_STREAK_REQUIRED) {
            this.debug('[WAL] drain completed');
            return;
          }
        } else {
          healthyStreak = 0;
          suspendedStreak = 0;
        }

        if (Date.now() - start >= options.timeoutMs) {
          this.logger.warn(`[WAL] drain timeout — continuing with lag=${lag}`);
          return;
        }

        attempt += 1;
        await new Promise((r) => setTimeout(r, sleepMs));
        sleepMs =
          attempt < WAL_DRAIN_INITIAL_ATTEMPTS
            ? WAL_DRAIN_INITIAL_SLEEP_MS
            : Math.min(
                WAL_DRAIN_MAX_SLEEP_MS,
                sleepMs + WAL_DRAIN_BACKOFF_SLEEP_MS,
              );
      }
    } catch (err) {
      this.logger.warn(
        '[WAL] waitForWalDrain error — continuing startup',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Ensure table WAL is not suspended and drain has caught up.
   */
  async ensureWalHealthy(table: string): Promise<void> {
    if (!safeTableName(table)) return;
    await this.resumeWalSingleFlight(table);
    await this.waitForWalDrain(table, {
      timeoutMs: 45_000,
      lagThreshold: 400,
    });
  }

  private isRetriableConnectionError(err: unknown): boolean {
    const raw =
      err instanceof Error ? `${err.name} ${err.message}` : String(err ?? '');
    const text = raw.toLowerCase();
    return (
      text.includes('econnreset') ||
      text.includes('econnrefused') ||
      text.includes('socket hang up') ||
      text.includes('connection terminated unexpectedly') ||
      text.includes('connection reset')
    );
  }
}
