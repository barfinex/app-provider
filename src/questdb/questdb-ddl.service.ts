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

@Injectable()
export class QuestDBDDLService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QuestDBDDLService.name);
  private postInitWalCheckTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly reader: QuestDBQueryService) {}

  async onModuleInit() {
    console.log('🛠 Generating QuestDB tables...');

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

    console.log('✅ QuestDB schema ready');

    this.postInitWalCheckTimer = setTimeout(() => {
      this.postInitWalCheckTimer = null;
      this.tryResumeCandlesWal()
        .then(() => {})
        .catch(() => {});
    }, POST_INIT_WAL_CHECK_DELAY_MS);
    // Лог только если задержка включена (для отладки)
    if (POST_INIT_WAL_CHECK_DELAY_MS > 0) {
      console.log(
        `QuestDB: scheduled WAL re-check in ${POST_INIT_WAL_CHECK_DELAY_MS / 1000}s (candles suspended recovery).`,
      );
    }
  }

  onModuleDestroy() {
    if (this.postInitWalCheckTimer != null) {
      clearTimeout(this.postInitWalCheckTimer);
      this.postInitWalCheckTimer = null;
    }
  }

  private async exec(sql: string) {
    try {
      await this.reader.query(sql);
    } catch (e) {
      console.error('❌ QuestDB DDL error:', e);
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
          'QuestDB: candles still suspended after RESUME WAL. Stopping application.',
        );
        this.exitOnSuspended(lastWriteContext);
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
   * Если после попытки RESUME таблица всё ещё suspended — останавливаем приложение (process.exit(1)),
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
            'QuestDB: table candles still suspended after RESUME WAL. Stopping application.',
          );
          this.exitOnSuspended();
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

  private exitOnSuspended(lastWriteContext?: CandlesSuspendContext): never {
    console.error(
      '🛑 Candles table suspended — application stopped. Check logs above for last [QuestDB SQL #N] and [QuestDB ILP].',
    );
    if (lastWriteContext) {
      console.error(
        'Suspend context:\n' +
          QuestDBDDLService.formatLastWriteContext(lastWriteContext),
      );
    }
    process.exit(1);
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
