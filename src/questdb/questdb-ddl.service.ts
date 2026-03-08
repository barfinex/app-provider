import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { QuestDBQueryService } from './questdb-query.service';

/** Контекст последней записи в candles — при suspend выводится в лог. */
export interface CandlesSuspendContext {
  symbol: string;
  interval: string;
  connectorType: string;
  marketType: string;
  totalRows: number;
  batchCount: number;
  firstTsIso?: string;
  lastTsIso?: string;
  batchSnapshots?: {
    batchIndex: number;
    rowCount: number;
    first: Record<string, number | string>;
    last: Record<string, number | string>;
  }[];
}

/** Задержка повторной проверки WAL после старта (если QuestDB снова переведёт таблицу в suspended). */
const POST_INIT_WAL_CHECK_DELAY_MS = 10_000;

/** Wait for QuestDB to accept connections before DDL. 0 = disabled. env: QUESTDB_READY_MAX_ATTEMPTS, QUESTDB_READY_INTERVAL_MS. */
const READY_MAX_ATTEMPTS = Math.max(0, Number(process.env.QUESTDB_READY_MAX_ATTEMPTS ?? 30));
const READY_INTERVAL_MS = Math.max(500, Number(process.env.QUESTDB_READY_INTERVAL_MS ?? 1000));

/** Delay before running DDL after ready (or after startup if ready disabled). env: QUESTDB_DDL_INITIAL_DELAY_MS. */
const DDL_INITIAL_DELAY_MS = Math.max(0, Number(process.env.QUESTDB_DDL_INITIAL_DELAY_MS ?? 5000));

/** Retry whole DDL phase on transient errors (e.g. ECONNRESET). env: QUESTDB_DDL_PHASE_MAX_ATTEMPTS. */
const DDL_PHASE_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.QUESTDB_DDL_PHASE_MAX_ATTEMPTS || 10),
);
/** Base delay (ms) between DDL phase retries. env: QUESTDB_DDL_PHASE_BASE_MS. */
const DDL_PHASE_BASE_MS = Math.max(
  1000,
  Number(process.env.QUESTDB_DDL_PHASE_BASE_MS || 3000),
);
/** If true, on final DDL failure do not throw — schedule background retries until success. env: QUESTDB_DDL_DEFERRED_ON_FAIL. */
const DDL_DEFERRED_ON_FAIL =
  String(process.env.QUESTDB_DDL_DEFERRED_ON_FAIL || 'true').toLowerCase() === 'true';
/** Interval (ms) for deferred DDL retries. env: QUESTDB_DDL_DEFERRED_INTERVAL_MS. */
const DDL_DEFERRED_INTERVAL_MS = Math.max(
  5000,
  Number(process.env.QUESTDB_DDL_DEFERRED_INTERVAL_MS || 30_000),
);

function isRetriableConnectionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const s = msg.toLowerCase();
  return (
    s.includes('econnreset') ||
    s.includes('econnrefused') ||
    s.includes('connection reset') ||
    s.includes('socket hang up') ||
    s.includes('etimedout') ||
    s.includes('connection refused')
  );
}

@Injectable()
export class QuestDBDDLService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QuestDBDDLService.name);
  private readonly isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  private readonly stopOnWalSuspended =
    String(
      process.env.QUESTDB_STOP_ON_WAL_SUSPENDED
      || (this.isProduction ? 'true' : 'false'),
    ).toLowerCase() === 'true';
  private walSuspendedDetectedAt: number | null = null;
  private postInitWalCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredDdlTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly reader: QuestDBQueryService) {}

  async onModuleInit() {
    this.logger.log('Generating QuestDB tables...');

    if (READY_MAX_ATTEMPTS > 0) {
      await this.waitForQuestDBReady();
    }

    if (DDL_INITIAL_DELAY_MS > 0) {
      this.logger.log(`Waiting ${DDL_INITIAL_DELAY_MS}ms before DDL (QUESTDB_DDL_INITIAL_DELAY_MS).`);
      await new Promise((r) => setTimeout(r, DDL_INITIAL_DELAY_MS));
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= DDL_PHASE_MAX_ATTEMPTS; attempt++) {
      try {
        await this.runDdlPhase();
        this.schedulePostInitWalCheck();
        return;
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (!isRetriableConnectionError(e)) {
          this.logger.error(`QuestDB DDL error (non-retriable): ${msg}`);
          throw e;
        }
        if (attempt < DDL_PHASE_MAX_ATTEMPTS) {
          const delayMs = Math.min(
            DDL_PHASE_BASE_MS * Math.pow(2, attempt - 1),
            DDL_PHASE_BASE_MS * 32,
          );
          this.logger.warn(
            `QuestDB DDL phase failed (attempt ${attempt}/${DDL_PHASE_MAX_ATTEMPTS}): ${msg}. Retrying in ${delayMs}ms`,
          );
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }

    if (DDL_DEFERRED_ON_FAIL) {
      this.logger.warn(
        `QuestDB DDL failed after ${DDL_PHASE_MAX_ATTEMPTS} attempts (${lastError instanceof Error ? lastError.message : String(lastError)}). Deferred mode: will retry in background every ${DDL_DEFERRED_INTERVAL_MS / 1000}s until success.`,
      );
      this.scheduleDeferredDdl();
      return;
    }

    this.logger.error(
      `QuestDB DDL error after ${DDL_PHASE_MAX_ATTEMPTS} attempts: ${lastError instanceof Error ? (lastError as Error).message : String(lastError)}`,
    );
    throw lastError;
  }

  /** Poll QuestDB with SELECT 1 until it responds or READY_MAX_ATTEMPTS exceeded. Prevents ECONNRESET during DDL. */
  private async waitForQuestDBReady(): Promise<void> {
    for (let attempt = 1; attempt <= READY_MAX_ATTEMPTS; attempt++) {
      try {
        await this.reader.query('SELECT 1');
        this.logger.log(`QuestDB ready (attempt ${attempt}/${READY_MAX_ATTEMPTS}).`);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < READY_MAX_ATTEMPTS) {
          this.logger.warn(
            `QuestDB not ready (${attempt}/${READY_MAX_ATTEMPTS}): ${msg}. Retrying in ${READY_INTERVAL_MS}ms.`,
          );
          await new Promise((r) => setTimeout(r, READY_INTERVAL_MS));
        } else {
          this.logger.warn(`QuestDB not ready after ${READY_MAX_ATTEMPTS} attempts: ${msg}. Proceeding with DDL (will retry on failure).`);
        }
      }
    }
  }

  /** Single full DDL phase: all tables + WAL resume. */
  private async runDdlPhase(): Promise<void> {
    await this.createCandlesTable();
    await this.tryResumeCandlesWal();
    await this.createTradesTable();
    await this.createOrdersTable();
    await this.createOrderBookTable();
    await this.createSymbolsTable();
    await this.createConnectorsTable();
    await this.createDetectorsTable();
    await this.createInspectorsTable();
    await this.createAppRegistryTable();
    await this.createEventSinkTable();
    this.logger.log('QuestDB schema ready');
  }

  private schedulePostInitWalCheck(): void {
    this.postInitWalCheckTimer = setTimeout(() => {
      this.postInitWalCheckTimer = null;
      this.tryResumeCandlesWal()
        .then(() => {})
        .catch(() => {});
    }, POST_INIT_WAL_CHECK_DELAY_MS);
    if (POST_INIT_WAL_CHECK_DELAY_MS > 0) {
      this.logger.log(
        `QuestDB: WAL re-check scheduled in ${POST_INIT_WAL_CHECK_DELAY_MS / 1000}s (candles recovery).`,
      );
    }
  }

  private scheduleDeferredDdl(): void {
    if (this.deferredDdlTimer != null) return;
    this.deferredDdlTimer = setInterval(() => {
      this.runDdlPhase()
        .then(() => {
          if (this.deferredDdlTimer != null) {
            clearInterval(this.deferredDdlTimer);
            this.deferredDdlTimer = null;
          }
          this.logger.log('QuestDB deferred DDL completed successfully.');
          this.schedulePostInitWalCheck();
        })
        .catch((e) => {
          this.logger.warn(
            `QuestDB deferred DDL retry failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
    }, DDL_DEFERRED_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.postInitWalCheckTimer != null) {
      clearTimeout(this.postInitWalCheckTimer);
      this.postInitWalCheckTimer = null;
    }
    if (this.deferredDdlTimer != null) {
      clearInterval(this.deferredDdlTimer);
      this.deferredDdlTimer = null;
    }
  }

  getWalSuspensionStatus(): { suspended: boolean; detectedAt: number | null } {
    return {
      suspended: this.walSuspendedDetectedAt != null,
      detectedAt: this.walSuspendedDetectedAt,
    };
  }

  /** Runs DDL; on failure logs and rethrows so init does not claim "schema ready". */
  private async exec(sql: string): Promise<void> {
    try {
      await this.reader.query(sql);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`QuestDB DDL error ${msg}`);
      throw e;
    }
  }

  // =====================================================================
  // CANDLES
  // =====================================================================
  private async createCandlesTable() {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS candles (
        symbol SYMBOL CAPACITY 256 CACHE,
        interval SYMBOL CAPACITY 32 CACHE,
        connectorType SYMBOL CAPACITY 32 CACHE,
        marketType SYMBOL CAPACITY 32 CACHE,
        open DOUBLE,
        high DOUBLE,
        low DOUBLE,
        close DOUBLE,
        volume DOUBLE,
        ts TIMESTAMP
      ) timestamp(ts)
      PARTITION BY DAY
      WAL;
    `);
  }

  async ensureCandlesTable() {
    await this.createCandlesTable();
  }

  /**
   * After a full bulk insert for a table, wait until QuestDB WAL apply catches up
   * (writerTxn approaches sequencerTxn) before proceeding. Delegates to reader.
   */
  async waitForWalDrain(tableName: string): Promise<void> {
    await this.reader.waitForWalDrain(tableName, 20_000);
  }

  /** Контекст последней массовой записи — выводится при обнаружении suspend. */
  static formatLastWriteContext(ctx: CandlesSuspendContext): string {
    const lines = [
      `  symbol=${ctx.symbol}`,
      `  interval=${ctx.interval}`,
      `  connectorType=${ctx.connectorType}`,
      `  marketType=${ctx.marketType}`,
      `  totalRows=${ctx.totalRows}`,
      `  batchCount=${ctx.batchCount}`,
    ];
    if (ctx.firstTsIso) lines.push(`  firstTs=${ctx.firstTsIso}`);
    if (ctx.lastTsIso) lines.push(`  lastTs=${ctx.lastTsIso}`);
    if (ctx.batchSnapshots?.length) {
      lines.push('  batches (first/last row per batch):');
      for (const b of ctx.batchSnapshots) {
        lines.push(`    batch[${b.batchIndex}] rows=${b.rowCount}:`);
        lines.push(`      first: ${JSON.stringify(b.first)}`);
        lines.push(`      last:  ${JSON.stringify(b.last)}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Проверка после массовой записи: если candles в suspended — пробуем RESUME WAL один раз,
   * выходим только если RESUME не помог или таблица остаётся suspended.
   * lastWriteContext — данные последней записи, при suspend выводятся в лог.
   */
  async checkCandlesSuspendedAndExitIfNeeded(lastWriteContext?: CandlesSuspendContext): Promise<void> {
    try {
      const rows = await this.reader.queryAsObjects(
        `SELECT * FROM wal_tables() WHERE suspended = true`,
      );
      if (!Array.isArray(rows) || rows.length === 0) return;
      const nameCol = (r: Record<string, unknown>) =>
        (r?.name ?? r?.table_name ?? '').toString().toLowerCase();
      const candlesRow = rows.find((r) => nameCol(r) === 'candles');
      if (!candlesRow) return;

      console.error('--- QuestDB candles SUSPENDED (WAL) ---');
      if (lastWriteContext) {
        console.error(
          'Last bulk write (при этих данных сработал suspend):\n' +
            QuestDBDDLService.formatLastWriteContext(lastWriteContext),
        );
      }
      console.error('wal_tables() row:', JSON.stringify(candlesRow, null, 2));
      const errMsg = (candlesRow?.errorMessage ?? candlesRow?.error_message) as string | undefined;
      const errTag = (candlesRow?.errorTag ?? candlesRow?.error_tag) as string | undefined;
      if (errMsg) console.error('QuestDB errorMessage:', errMsg);
      if (errTag) console.error('QuestDB errorTag:', errTag);
      console.warn(
        'QuestDB: table candles is suspended (WAL) after bulk write. Attempting RESUME WAL...',
      );

      try {
        await this.reader.resumeWalIfNeeded('candles');
      } catch (resumeErr) {
        console.error('QuestDB RESUME WAL failed:', resumeErr);
        this.exitOnSuspended(lastWriteContext);
      }

      const rowsAfter = await this.reader.queryAsObjects(
        `SELECT * FROM wal_tables() WHERE suspended = true`,
      );
      const stillSuspended =
        Array.isArray(rowsAfter) &&
        rowsAfter.length > 0 &&
        rowsAfter.some(
          (r: Record<string, unknown>) =>
            nameCol(r) === 'candles',
        );
      if (stillSuspended) {
        console.error(
          'QuestDB: candles still suspended after RESUME WAL.',
        );
        this.exitOnSuspended(lastWriteContext);
      } else {
        this.markWalHealthy();
      }
      console.log('✅ QuestDB: candles table WAL resumed after bulk write.');
    } catch (err) {
      console.warn(
        'QuestDB: wal_tables() check failed (suspend detection skipped):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Если таблица candles в состоянии suspended (WAL приостановлен из‑за ошибки),
   * пытаемся возобновить: ALTER TABLE candles RESUME WAL.
   * Вызывается при старте и по крону каждую минуту.
   * Если после попытки RESUME таблица всё ещё suspended — инициируем graceful shutdown,
   * чтобы не пропустить момент и сохранить в логах последние [QuestDB SQL #N] и [QuestDB ILP] операции.
   */
  async tryResumeCandlesWal(): Promise<void> {
    try {
      let suspended = false;
      const rows = await this.reader.queryAsObjects(
        `SELECT * FROM wal_tables() WHERE suspended = true`,
      );
      if (Array.isArray(rows) && rows.length > 0) {
        const nameCol = (r: Record<string, unknown>) =>
          (r?.name ?? r?.table_name ?? '').toString().toLowerCase();
        suspended = rows.some((r) => nameCol(r) === 'candles');
      }
      if (suspended) {
        console.warn(
          '⚠ QuestDB: table candles is suspended (WAL). Attempting ALTER TABLE candles RESUME WAL...',
        );
        try {
          await this.reader.resumeWalIfNeeded('candles');
        } catch (resumeErr) {
          console.error('QuestDB RESUME WAL failed:', resumeErr);
          this.exitOnSuspended();
        }
        // Проверяем, снялся ли suspended
        const rowsAfter = await this.reader.queryAsObjects(
          `SELECT * FROM wal_tables() WHERE suspended = true`,
        );
        const stillSuspended =
          Array.isArray(rowsAfter) &&
          rowsAfter.length > 0 &&
          rowsAfter.some(
            (r: Record<string, unknown>) =>
              (r?.name ?? r?.table_name ?? '').toString().toLowerCase() === 'candles',
          );
        if (stillSuspended) {
          console.error(
            'QuestDB: table candles still suspended after RESUME WAL.',
          );
          this.exitOnSuspended();
        } else {
          this.markWalHealthy();
        }
        console.log('✅ QuestDB: candles table WAL resumed.');
      }
    } catch (err) {
      console.warn(
        'QuestDB: wal_tables() check failed (suspend detection skipped):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private exitOnSuspended(lastWriteContext?: CandlesSuspendContext): void {
    this.markWalSuspended();
    console.error('🛑 Candles table suspended (WAL).');
    if (lastWriteContext) {
      console.error(
        'Suspend context:\n' +
          QuestDBDDLService.formatLastWriteContext(lastWriteContext),
      );
    }

    if (this.stopOnWalSuspended) {
      console.error(
        'QuestDB strict mode enabled (QUESTDB_STOP_ON_WAL_SUSPENDED=true): requesting graceful shutdown via SIGTERM.',
      );
      try {
        process.kill(process.pid, 'SIGTERM');
      } catch (error) {
        this.logger.error(
          `Failed to request SIGTERM shutdown after WAL suspension: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.error(
      'QuestDB WAL suspended state detected, but process termination is disabled. Provider stays online and will continue periodic recovery attempts.',
    );
  }

  private markWalSuspended(): void {
    if (this.walSuspendedDetectedAt == null) {
      this.walSuspendedDetectedAt = Date.now();
    }
  }

  private markWalHealthy(): void {
    this.walSuspendedDetectedAt = null;
  }

  /** Периодическая проверка и возобновление WAL для candles (каждую минуту). */
  @Cron('*/1 * * * *')
  async cronResumeCandlesWal(): Promise<void> {
    await this.tryResumeCandlesWal();
  }

  // =====================================================================
  // TRADES
  // =====================================================================
  private async createTradesTable() {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        symbol SYMBOL CAPACITY 256 CACHE,
        side SYMBOL CAPACITY 8 CACHE,
        price DOUBLE,
        volume DOUBLE,
        ts TIMESTAMP
      ) timestamp(ts)
      PARTITION BY DAY;
    `);
  }

  // =====================================================================
  // ORDERS
  // =====================================================================
  private async createOrdersTable() {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id SYMBOL CAPACITY 256 CACHE,
        externalId SYMBOL CAPACITY 256 CACHE,
        connectorType SYMBOL CAPACITY 32 CACHE,
        marketType SYMBOL CAPACITY 32 CACHE,
        symbol SYMBOL CAPACITY 256 CACHE,

        side SYMBOL CAPACITY 16 CACHE,
        type SYMBOL CAPACITY 16 CACHE,
        price DOUBLE,

        sourceSysname SYMBOL CAPACITY 128 CACHE,
        sourceType SYMBOL CAPACITY 32 CACHE,
        sourceBaseApiUrl STRING,

        time TIMESTAMP,
        updateTime TIMESTAMP,

        quantity DOUBLE,
        quantityExecuted DOUBLE,

        priceClose DOUBLE,
        closeTime TIMESTAMP,

        useSandbox BOOLEAN,

        status SYMBOL CAPACITY 16 CACHE,
        deletedAt TIMESTAMP
      ) timestamp(time)
      PARTITION BY DAY;
    `);
  }

  // =====================================================================
  // ORDERBOOK
  // =====================================================================
  private async createOrderBookTable() {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS orderbook_levels (
        symbol SYMBOL CAPACITY 256 CACHE,
        side SYMBOL CAPACITY 8 CACHE,
        price DOUBLE,
        volume DOUBLE,
        ts TIMESTAMP
      ) timestamp(ts)
      PARTITION BY DAY;
    `);
  }

  // =====================================================================
  // SYMBOLS
  // =====================================================================
  private async createSymbolsTable() {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        symbol SYMBOL CAPACITY 256 CACHE,
        connectorType SYMBOL CAPACITY 32 CACHE,
        marketType SYMBOL CAPACITY 32 CACHE,
        baseAsset STRING,
        quoteAsset STRING,
        status STRING,
        createdAt TIMESTAMP,
        updatedAt TIMESTAMP
      ) timestamp(updatedAt)
      PARTITION BY DAY;
    `);
  }

  // =====================================================================
  // CONNECTORS
  // =====================================================================
  private async createConnectorsTable() {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS connectors (
        connectorType SYMBOL CAPACITY 32 CACHE,
        options STRING,
        created TIMESTAMP,
        updated TIMESTAMP,
        status SYMBOL CAPACITY 16 CACHE,
        deletedAt TIMESTAMP
      ) timestamp(updated)
      PARTITION BY DAY;
    `);
  }

  // =====================================================================
  // DETECTORS
  // =====================================================================
  private async createDetectorsTable() {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS detectors (
        key SYMBOL CAPACITY 256 CACHE,
        name SYMBOL CAPACITY 256 CACHE,
        options STRING,
        created TIMESTAMP,
        updated TIMESTAMP,
        status SYMBOL CAPACITY 16 CACHE,
        deletedAt TIMESTAMP
      ) timestamp(updated)
      PARTITION BY DAY;
    `);
  }

  // =====================================================================
  // INSPECTORS
  // =====================================================================
  private async createInspectorsTable() {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS inspectors (
        name SYMBOL CAPACITY 256 CACHE,
        options STRING,
        created TIMESTAMP,
        updated TIMESTAMP,
        status SYMBOL CAPACITY 16 CACHE,
        deletedAt TIMESTAMP
      ) timestamp(updated)
      PARTITION BY DAY;
    `);
  }

  // =====================================================================
  // EVENT SINK
  // =====================================================================
  private async createAppRegistryTable() {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS app_registry (
        appKey SYMBOL CAPACITY 256 CACHE,
        appType SYMBOL CAPACITY 32 CACHE,
        baseUrl STRING,
        displayName SYMBOL CAPACITY 256 CACHE,
        version SYMBOL CAPACITY 64 CACHE,
        ip STRING,
        meta STRING,
        status SYMBOL CAPACITY 32 CACHE,
        registeredAt TIMESTAMP,
        lastHeartbeatAt TIMESTAMP,
        updatedAt TIMESTAMP,
        unregisteredAt TIMESTAMP
      ) timestamp(updatedAt)
      PARTITION BY DAY;
    `);
  }

  // =====================================================================
  // EVENT SINK
  // =====================================================================
  private async createEventSinkTable() {
    await this.exec(`
      CREATE TABLE IF NOT EXISTS event_sink (
        eventType SYMBOL CAPACITY 64 CACHE,
        symbol SYMBOL CAPACITY 256 CACHE,
        connectorType SYMBOL CAPACITY 32 CACHE,
        marketType SYMBOL CAPACITY 32 CACHE,
        payload STRING,
        ts TIMESTAMP
      ) timestamp(ts)
      PARTITION BY DAY;
    `);
  }
}
