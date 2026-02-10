import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import * as net from 'net';

export interface ILPWriteOptions {
    table: string;
    keys?: Record<string, string | number>;
    fields: Record<string, string | number | boolean>;
    timestampNs?: number; // nanoseconds
}

type SocketChannel = 'main' | 'trades' | 'candles' | 'orderbook' | 'events';

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

    private readonly MAX_BATCH_SIZE =
        Number(process.env.QUESTDB_BATCH_SIZE || 2000);

    private readonly FLUSH_INTERVAL_MS =
        Number(process.env.QUESTDB_FLUSH_INTERVAL || 50);

    private flushTimer!: NodeJS.Timeout;

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
        const socket = new net.Socket();
        this.sockets[channel] = socket;

        const connect = () => {
            try {
                socket.connect(this.port, this.host);
            } catch (e) {
                this.logger.error(`ILP connect error [${channel}]`, e);
            }
        };

        socket.on('connect', () => {
            this.connected[channel] = true;
            this.logger.log(`⚡ ILP connected [${channel}] ${this.host}:${this.port}`);

            // отправляем всё, что накопилось
            this.flush(channel);
        });

        socket.on('drain', () => {
            // Дойдёт очередь — продолжим писать
            this.flush(channel);
        });

        socket.on('error', err => {
            this.connected[channel] = false;
            this.logger.error(`❌ ILP error [${channel}]`, err);
        });

        socket.on('close', hadError => {
            this.connected[channel] = false;
            this.logger.warn(`⚠️ ILP closed [${channel}] hadError=${hadError}`);
            setTimeout(connect, 1000);
        });

        connect();
    }

    // ================================================================
    // PUBLIC WRITE
    // ================================================================
    write(
        channel: SocketChannel,
        { table, keys = {}, fields, timestampNs = Date.now() * 1_000_000 }: ILPWriteOptions
    ) {
        const line = this.buildILP(table, keys, fields, timestampNs);
        this.buffers[channel].push(line);

        if (this.buffers[channel].length >= this.MAX_BATCH_SIZE) {
            this.flush(channel);
        }
    }

    writeBatch(channel: SocketChannel, batch: ILPWriteOptions[]) {
        for (const o of batch) {
            const line = this.buildILP(
                o.table,
                o.keys ?? {},
                o.fields ?? {},
                o.timestampNs ?? Date.now() * 1_000_000
            );
            this.buffers[channel].push(line);
        }
        if (this.buffers[channel].length >= this.MAX_BATCH_SIZE) {
            this.flush(channel);
        }
    }

    // ================================================================
    // ILP line builder
    // ================================================================
    private buildILP(
        table: string,
        keys: Record<string, any>,
        fields: Record<string, any>,
        timestampNs: number,
    ): string {
        const tagParts = Object.entries(keys).map(
            ([k, v]) => `${k}=${this.escape(v)}`
        );

        const fieldParts = Object.entries(fields)
            .filter(([_, v]) => v !== undefined && v !== null)
            .map(([k, v]) => {
                if (typeof v === 'string') return `${k}="${this.escape(v)}"`;
                if (typeof v === 'boolean') return `${k}=${v ? 1 : 0}`;
                return `${k}=${v}`;
            });

        return `${table}${tagParts.length ? ',' + tagParts.join(',') : ''} ` +
            `${fieldParts.join(',')} ${timestampNs}`;
    }

    private escape(v: any) {
        return String(v).replace(/"/g, '\\"').replace(/ /g, '\\ ');
    }

    // ================================================================
    // FLUSH
    // ================================================================
    flush(channel: SocketChannel) {
        const socket = this.sockets[channel];
        if (!socket || !this.connected[channel]) return;

        const buf = this.buffers[channel];
        if (buf.length === 0) return;

        const payload = buf.join('\n') + '\n';
        this.buffers[channel] = [];

        const ok = socket.write(payload);
        if (!ok) {
            // Socket busy — вернём строки назад, flush продолжится после "drain"
            this.buffers[channel].unshift(...buf);
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
        this.flushAll();

        for (const ch of Object.keys(this.sockets) as SocketChannel[]) {
            try {
                this.sockets[ch]?.end();
            } catch { }
        }
    }

    // ================================================================
    // METRICS
    // ================================================================
    getMetrics() {
        return {
            connected: this.connected,
            buffers: Object.fromEntries(
                Object.entries(this.buffers).map(([k, v]) => [k, v.length])
            ),
        };
    }
}
