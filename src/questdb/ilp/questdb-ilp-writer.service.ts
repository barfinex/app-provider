import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ILPWriteOptions } from './types';
import * as net from 'net';

@Injectable()
export class QuestDbIlpWriterService implements OnModuleDestroy {
  private readonly logger = new Logger(QuestDbIlpWriterService.name);
  private socket: net.Socket;
  private readonly host = (process.env.QUESTDB_HOST || '127.0.0.1')
    .trim()
    .replace(/^localhost$/i, '127.0.0.1');
  private readonly port = Number(process.env.QUESTDB_ILP_PORT || 9009);
  private readonly reconnectBaseMs = Math.max(
    500,
    Number(process.env.PROVIDER_QUESTDB_RECONNECT_BASE_MS || 500),
  );
  private readonly reconnectMaxMs = Math.max(
    this.reconnectBaseMs,
    Number(process.env.PROVIDER_QUESTDB_RECONNECT_MAX_MS || 10_000),
  );

  private buffer: string[] = [];
  private readonly flushInterval = 20; // ms
  private readonly maxBufferRows = Math.max(
    1000,
    Number(process.env.QUESTDB_BUFFER_HARD_LIMIT || 50_000),
  );
  private readonly maxFlushBatchRows = 5000;
  private flushTimer: NodeJS.Timeout;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private connected = false;
  private destroying = false;
  private droppedRowsTotal = 0;

  constructor() {
    this.socket = this.createSocket();
    this.connect();
    this.flushTimer = setInterval(() => this.flush(), this.flushInterval);
    this.logger.warn(
      '[ILP_LEGACY_PATH] QuestDbIlpWriterService is active (symbols writer). Applying bounded queue + reconnect guardrails.',
    );
  }

  /** Преобразование в ILP строку */
  private formatLine(o: ILPWriteOptions): string {
    const tags = o.keys
      ? ',' +
        Object.entries(o.keys)
          .map(([k, v]) => `${k}=${v}`)
          .join(',')
      : '';

    const fields = o.fields
      ? ' ' +
        Object.entries(o.fields)
          .map(([k, v]) =>
            typeof v === 'string' ? `${k}="${v}"` : `${k}=${v}`,
          )
          .join(',')
      : '';

    const ts = o.timestamp ?? Date.now() * 1_000_000;

    return `${o.table}${tags}${fields} ${ts}`;
  }

  async write(o: ILPWriteOptions) {
    this.enqueueLine(this.formatLine(o));
  }

  async writeMany(list: ILPWriteOptions[]) {
    for (const o of list) {
      this.enqueueLine(this.formatLine(o));
    }
  }

  private flush() {
    if (!this.connected || this.buffer.length === 0) return;
    const batchSize = Math.min(this.buffer.length, this.maxFlushBatchRows);
    const payloadLines = this.buffer.slice(0, batchSize);
    const payload = payloadLines.join('\n') + '\n';
    this.socket.write(payload, (error) => {
      if (error) {
        this.connected = false;
        this.logger.warn(
          `[ILP] flush failed: ${error.message}; queued=${this.buffer.length} reconnecting`,
        );
        this.scheduleReconnect();
        return;
      }
      this.buffer.splice(0, batchSize);
    });
  }

  onModuleDestroy() {
    this.destroying = true;
    clearInterval(this.flushTimer);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket.end();
    this.socket.destroy();
  }

  private createSocket(): net.Socket {
    const socket = new net.Socket();
    socket.on('connect', () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.logger.log('[ILP] connected to QuestDB ILP');
    });
    socket.on('error', (error) => {
      this.connected = false;
      this.logger.warn(`[ILP] socket error: ${error.message}`);
    });
    socket.on('close', () => {
      this.connected = false;
      if (!this.destroying) {
        this.scheduleReconnect();
      }
    });
    return socket;
  }

  private connect(): void {
    if (this.destroying || this.connected) return;
    try {
      this.socket.connect(this.port, this.host);
    } catch (error) {
      this.connected = false;
      this.logger.warn(
        `[ILP] connect threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.destroying || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const expBackoff = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs *
        Math.pow(2, Math.min(this.reconnectAttempt - 1, 6)),
    );
    const jitter = Math.floor(
      Math.random() * Math.max(100, Math.floor(expBackoff * 0.2)),
    );
    const delayMs = Math.min(this.reconnectMaxMs, expBackoff + jitter);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.socket.destroyed) {
        this.socket = this.createSocket();
      }
      this.connect();
    }, delayMs);
  }

  private enqueueLine(line: string): void {
    this.buffer.push(line);
    if (this.buffer.length <= this.maxBufferRows) return;
    const overflow = this.buffer.length - this.maxBufferRows;
    this.buffer.splice(0, overflow);
    this.droppedRowsTotal += overflow;
    if (this.droppedRowsTotal % 1000 <= overflow) {
      this.logger.warn(
        `[ILP] legacy buffer overflow: dropped_total=${this.droppedRowsTotal} capacity=${this.maxBufferRows}`,
      );
    }
  }
}
