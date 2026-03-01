import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import * as net from 'net';

export interface ILPWriteOptions {
  table: string;
  keys?: Record<string, string | number>;
  fields: Record<string, string | number | boolean | bigint>;
  /** Nanoseconds since epoch. If omitted, will be generated with BigInt to avoid precision loss. */
  timestampNs?: bigint;
}

export type SocketChannel = 'main' | 'trades' | 'candles' | 'orderbook' | 'events';

@Injectable()
export class QuestDBWriteService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('QuestDBWrite');

  private sockets: Record<SocketChannel, net.Socket | null> = {
    main: null,
    trades: null,
    candles: null,
    orderbook: null,
    events: null,
  };

  private connected: Record<SocketChannel, boolean> = {
    main: false,
    trades: false,
    candles: false,
    orderbook: false,
    events: false,
  };

  private buffers: Record<SocketChannel, string[]> = {
    main: [],
    trades: [],
    candles: [],
    orderbook: [],
    events: [],
  };

  private readonly host = process.env.QUESTDB_HOST || 'localhost';
  private readonly port = Number(process.env.QUESTDB_ILP_PORT || 9009);
  /** HTTP port for ILP over HTTP (bulk candles). */
  private readonly httpPort = Number(process.env.QUESTDB_HTTP_PORT || 9000);

  

  /**
   * Важно:
   * - BATCH_SIZE ограничивает, как часто мы форсим flush при добавлении строк.
   * - FLUSH_CHUNK_ROWS ограничивает, сколько строк отправляем за один socket.write.
   * - MAX_BUFFER_ROWS — жёсткий лимит RAM (если превышаем, новые строки дропаем, иначе процесс "умирает").
   */
  private readonly MAX_BATCH_SIZE = Number(process.env.QUESTDB_BATCH_SIZE || 1000);
  private readonly FLUSH_INTERVAL_MS = Number(process.env.QUESTDB_FLUSH_INTERVAL || 50);
  /** Smaller chunks = less TCP buffer pressure, drain can fire (default 50). */
  private readonly FLUSH_CHUNK_ROWS = Math.min(
    Number(process.env.QUESTDB_FLUSH_CHUNK_ROWS || 50),
    5000,
  );
  private readonly MAX_BUFFER_ROWS = Math.max(
    Number(process.env.QUESTDB_MAX_BUFFER_ROWS || 100_000),
    10_000,
  );

  private flushTimer!: NodeJS.Timeout;

  /**
   * Single-flight drain waiter per channel.
   * ВАЖНО: прежняя версия перезаписывала drainWait[channel] и "теряла" предыдущие Promise,
   * из-за этого waitUntilBelow мог зависать/таймаутиться при активной записи (особенно history warmup).
   */
  private drainWait: Record<
    SocketChannel,
    | {
        promise: Promise<void>;
        resolve: () => void;
        timeout: NodeJS.Timeout;
      }
    | null
  > = {
    main: null,
    trades: null,
    candles: null,
    orderbook: null,
    events: null,
  };

  /** Throttle "write buffer full" WARN per channel (last log time). */
  private lastWarnAt: Record<SocketChannel, number> = {
    main: 0,
    trades: 0,
    candles: 0,
    orderbook: 0,
    events: 0,
  };

  private static readonly WARN_THROTTLE_MS = 2000;
  /** Wait up to 30s for socket drain (bulk history needs time for QuestDB to consume). */
  private static readonly DRAIN_WAIT_MS = Number(process.env.QUESTDB_DRAIN_WAIT_MS || 30_000);

  async onModuleInit() {
    for (const channel of Object.keys(this.sockets) as SocketChannel[]) {
      this.createSocket(channel);
    }
    this.flushTimer = setInterval(() => this.flushAll(), this.FLUSH_INTERVAL_MS);
  }

  // ================================================================
  // SOCKET CREATION + RECONNECT
  // ================================================================
  private createSocket(channel: SocketChannel) {
    // если по какой-то причине старый сокет не убит — убиваем
    if (this.sockets[channel]) {
      try {
        this.sockets[channel]!.removeAllListeners();
        this.sockets[channel]!.destroy();
      } catch {
        // ignore
      }
      this.sockets[channel] = null;
    }

    const socket = new net.Socket();
    this.sockets[channel] = socket;
    socket.setNoDelay(true);

    const connect = () => {
      try {
        // если сокет уже уничтожен/закрыт — выходим (пересоздадим ниже)
        if (socket.destroyed) return;
        socket.connect(this.port, this.host);
      } catch (e) {
        this.logger.error(`ILP connect error [${channel}]`, e as any);
      }
    };

    socket.on('connect', () => {
      this.connected[channel] = true;
      this.logger.log(`⚡ ILP connected [${channel}] ${this.host}:${this.port}`);
      this.flush(channel);
    });

    socket.on('drain', () => {
      const w = this.drainWait[channel];
      if (w) {
        clearTimeout(w.timeout);
        this.drainWait[channel] = null;
        w.resolve();
      }
      this.flush(channel);
    });

    socket.on('error', (err) => {
      this.connected[channel] = false;
      this.logger.error(`❌ ILP error [${channel}]`, err);
    });

    socket.on('close', (hadError) => {
      this.connected[channel] = false;
      this.logger.warn(`⚠️ ILP closed [${channel}] hadError=${hadError}`);

      // если кто-то ждёт drain — разбудим, чтобы не висеть
      const w = this.drainWait[channel];
      if (w) {
        clearTimeout(w.timeout);
        this.drainWait[channel] = null;
        w.resolve();
      }

      // ВАЖНО: не пытаемся connect() тем же сокетом после close.
      // Создаём новый сокет (иначе возможны вечные "buffered" и непредсказуемое состояние)
      setTimeout(() => {
        // если уже переподключили вручную — не мешаем
        if (this.sockets[channel] !== socket) return;
        this.createSocket(channel);
      }, 1000);
    });

    connect();
  }

  disconnectChannel(channel: SocketChannel): void {
    const w = this.drainWait[channel];
    if (w) {
      clearTimeout(w.timeout);
      this.drainWait[channel] = null;
      w.resolve();
    }

    const socket = this.sockets[channel];
    if (socket) {
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      this.sockets[channel] = null;
    }

    this.connected[channel] = false;
    this.buffers[channel] = [];
  }

  reconnectChannel(channel: SocketChannel): void {
    if (this.sockets[channel]) this.disconnectChannel(channel);
    this.createSocket(channel);
  }

  // ================================================================
  // PUBLIC WRITE
  // ================================================================
  write(
    channel: SocketChannel,
    { table, keys = {}, fields, timestampNs }: ILPWriteOptions,
  ) {
    const ts = timestampNs ?? this.nowNs();
    const line = this.buildILP(table, keys, fields, ts);
    if (!line) return;

    if (this.buffers[channel].length >= this.MAX_BUFFER_ROWS) {
      // Жёсткий предохранитель: лучше дропнуть историю, чем уронить процесс по памяти.
      // (Для realtime свечей при нормальной нагрузке сюда не дойдёт.)
      this.logger.error(
        `[ILP] ${channel}: HARD LIMIT reached (${this.buffers[channel].length} >= ${this.MAX_BUFFER_ROWS}). Dropping new row.`,
      );
      return;
    }

    this.buffers[channel].push(line);

    if (this.buffers[channel].length >= this.MAX_BATCH_SIZE) {
      this.flush(channel);
    }
  }

  /**
   * writeBatch — теперь контролируемо добавляет строки в буфер, уважая backpressure.
   * Главное: не “заливать” 10к строк мгновенно, иначе socket.write всегда будет full.
   */
  async writeBatch(channel: SocketChannel, batch: ILPWriteOptions[]): Promise<void> {
    if (!batch.length) return;

    const table = batch[0]?.table ?? '?';
    this.logger.log(`[QuestDB ILP] ${channel} writeBatch → ${batch.length} rows (table=${table})`);

    // Потоковое добавление: порциями, с ожиданием дренажа при необходимости
    for (const o of batch) {
      const ts = o.timestampNs ?? this.nowNs();
      const line = this.buildILP(o.table, o.keys ?? {}, o.fields ?? {}, ts);
      if (!line) continue;

      // Если буфер подбирается к лимиту — ждём, пока он уменьшится
      if (this.buffers[channel].length >= this.MAX_BUFFER_ROWS) {
        this.logger.warn(
          `[ILP] ${channel}: buffer near HARD LIMIT (${this.buffers[channel].length}/${this.MAX_BUFFER_ROWS}), waiting for drain...`,
        );
        await this.waitUntilBelow(channel, Math.floor(this.MAX_BUFFER_ROWS * 0.7));
      }

      this.buffers[channel].push(line);

      // периодически форсим flush
      if (this.buffers[channel].length >= this.MAX_BATCH_SIZE) {
        this.flush(channel);
      }
    }

    // после добавления — делаем flush и ждём, чтобы история реально “приземлилась”
    this.flush(channel);
    await this.waitUntilBelow(channel, 0);
  }

  /**
   * Flush channel buffer and wait until drained. Used for throttled history TCP streaming.
   */
  async flushChannel(channel: SocketChannel): Promise<void> {
    this.flush(channel);
    await this.waitUntilBelow(channel, 0);
  }

  /**
   * Отправка батча через HTTP ILP (POST /write).
   * Используется для bulk свечей, чтобы не упираться в TCP backpressure и получать явный ответ от QuestDB.
   * Требует line.http.enabled=true в QuestDB.
   * @param options.quiet - when true (e.g. warmup), skip per-batch log to avoid console spam; summary is logged by caller.
   */
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
      const table = batch[0]?.table ?? '?';
      this.logger.log(
        `[QuestDB ILP] ${channel} writeBatchIlpHttp → ${lines.length} rows (table=${table})`,
      );
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.influxdb.line.protocol' },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      this.logger.error(
        `[ILP] ${channel} HTTP write failed: ${res.status} ${res.statusText} — ${text.slice(0, 500)}`,
      );
      throw new Error(`QuestDB ILP HTTP write failed: ${res.status} ${text.slice(0, 200)}`);
    }
  }

  // ================================================================
  // BACKPRESSURE / DRAIN WAIT
  // ================================================================
  private waitDrain(channel: SocketChannel): Promise<void> {
    // ✅ single-flight: если уже есть waiter — возвращаем его promise
    const existing = this.drainWait[channel];
    if (existing) return existing.promise;

    let resolve!: () => void;

    const promise = new Promise<void>((r) => {
      resolve = r;
    });

    const timeout = setTimeout(() => {
      const w = this.drainWait[channel];
      if (w) {
        this.drainWait[channel] = null;
        this.logger.debug(
          `[ILP] ${channel}: drain wait timeout, ${this.buffers[channel].length} rows still buffered`,
        );
        w.resolve();
      }
    }, QuestDBWriteService.DRAIN_WAIT_MS);

    this.drainWait[channel] = { promise, resolve, timeout };
    return promise;
  }

  /** Ждём, пока буфер не станет <= targetLen */
  async waitUntilBelow(channel: SocketChannel, targetLen: number): Promise<void> {
    const start = Date.now();

    while (this.buffers[channel].length > targetLen) {
      this.flush(channel);

      // если socket в backpressure — ждём drain, иначе небольшой sleep
      const socket = this.sockets[channel];
      if (socket && this.connected[channel] && socket.writableNeedDrain) {
        await this.waitDrain(channel);
      } else {
        await new Promise((r) => setTimeout(r, 25));
      }

      // safety: не зависаем бесконечно (10 циклов по DRAIN_WAIT_MS)
      if (Date.now() - start > QuestDBWriteService.DRAIN_WAIT_MS * 10) {
        this.logger.warn(
          `[ILP] ${channel}: waitUntilBelow timeout, buffered=${this.buffers[channel].length}, target=${targetLen}`,
        );
        break;
      }
    }
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

  // 🔒 Гарантия: никогда не отправляем 0 или отрицательный timestamp
  if (timestampNs <= 0n) {
    this.logger.warn(`[ILP] drop row: table=${table} invalid timestampNs=${timestampNs}`);
    return null;
  }


    const fieldParts = Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => this.formatField(k, v))
      .filter((x): x is string => Boolean(x));

    if (fieldParts.length === 0) {
      this.logger.warn(`[ILP] drop row: table=${table} has no fields`);
      return null;
    }

    const measurement = this.escapeMeasurement(table);

    const tagParts = Object.entries(keys)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${this.escapeTagKey(k)}=${this.escapeTagValue(v)}`);

    return `${measurement}${tagParts.length ? ',' + tagParts.join(',') : ''} ${fieldParts.join(
      ',',
    )} ${timestampNs.toString()}`;
  }

  private formatField(key: string, value: any): string | null {
    const k = this.escapeFieldKey(key);

    if (typeof value === 'string') {
      const v = this.escapeFieldString(value);
      return `${k}="${v}"`;
    }

    if (typeof value === 'boolean') {
      return `${k}=${value ? 1 : 0}`;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      return `${k}=${value}`;
    }

    if (typeof value === 'bigint') {
      return `${k}=${value.toString()}`;
    }

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

  // ================================================================
  // FLUSH
  // ================================================================
  async flush(channel: SocketChannel) {
    const socket = this.sockets[channel];

    if (!socket || !this.connected[channel]) {
      if (this.buffers[channel].length > 0) {
        this.logger.debug(
          `[ILP] ${channel}: not connected, buffered=${this.buffers[channel].length}`,
        );
      }
      return;
    }

    const buf = this.buffers[channel];
    if (buf.length === 0) return;

    if (socket.writableNeedDrain) return;

    const chunkSize = this.FLUSH_CHUNK_ROWS;
    const toSend =
      chunkSize > 0 && buf.length > chunkSize ? buf.splice(0, chunkSize) : buf.splice(0, buf.length);

    if (toSend.length === 0) return;

    const payload = toSend.join('\n') + '\n';
    const ok = socket.write(payload);

    if (!ok) {
      const now = Date.now();
      if (now - this.lastWarnAt[channel] >= QuestDBWriteService.WARN_THROTTLE_MS) {
        this.lastWarnAt[channel] = now;
        this.logger.warn(
          `[ILP] ${channel}: write buffer full, waiting for drain (buffer=${this.buffers[channel].length})`,
        );
      }

      // ВАЖНО:
      // ❌ НИКАКОГО unshift обратно
      // данные уже ушли в сокет буфер
      // ждём drain, дальше продолжит socket.on('drain')
    }
  }

  flushAll() {
    for (const ch of Object.keys(this.sockets) as SocketChannel[]) {
      this.flush(ch);
    }
  }

  // ================================================================
  // SHUTDOWN
  // ================================================================
  onModuleDestroy() {
    clearInterval(this.flushTimer);

    for (const ch of Object.keys(this.drainWait) as SocketChannel[]) {
      const w = this.drainWait[ch];
      if (w) {
        clearTimeout(w.timeout);
        this.drainWait[ch] = null;
        w.resolve();
      }
    }

    this.flushAll();

    for (const ch of Object.keys(this.sockets) as SocketChannel[]) {
      try {
        this.sockets[ch]?.end();
      } catch {
        // ignore
      }
    }
  }

  getMetrics() {
    return {
      connected: this.connected,
      buffers: Object.fromEntries(Object.entries(this.buffers).map(([k, v]) => [k, v.length])),
      limits: {
        MAX_BATCH_SIZE: this.MAX_BATCH_SIZE,
        FLUSH_CHUNK_ROWS: this.FLUSH_CHUNK_ROWS,
        MAX_BUFFER_ROWS: this.MAX_BUFFER_ROWS,
      },
    };
  }
}
