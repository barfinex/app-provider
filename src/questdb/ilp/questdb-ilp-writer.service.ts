import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ILPWriteOptions } from './types';
import * as net from 'net';

@Injectable()
export class QuestDbIlpWriterService implements OnModuleDestroy {
    private socket: net.Socket;
    private readonly host = 'localhost';
    private readonly port = 9009;

    private buffer: string[] = [];
    private readonly flushInterval = 20; // ms
    private flushTimer: NodeJS.Timeout;

    constructor() {
        this.socket = new net.Socket();
        this.socket.connect(this.port, this.host, () =>
            console.log('[ILP] Connected to QuestDB ILP'),
        );

        this.flushTimer = setInterval(() => this.flush(), this.flushInterval);
    }

    /** Преобразование в ILP строку */
    private formatLine(o: ILPWriteOptions): string {
        const tags = o.keys
            ? ',' + Object.entries(o.keys)
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
        this.buffer.push(this.formatLine(o));
    }

    async writeMany(list: ILPWriteOptions[]) {
        for (const o of list) {
            this.buffer.push(this.formatLine(o));
        }
    }

    private flush() {
        if (this.buffer.length === 0) return;

        const payload = this.buffer.join('\n') + '\n';
        this.buffer = [];

        this.socket.write(payload);
    }

    onModuleDestroy() {
        clearInterval(this.flushTimer);
        this.socket.end();
    }
}
