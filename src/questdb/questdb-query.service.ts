import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Client } from 'pg';

/**
 * QuestDB SQL Reader (PostgreSQL wire protocol)
 * Устойчивый, безопасный, с очередью как API, но каждый запрос работает
 * через НОВОЕ соединение (QuestDB не рвёт короткие соединения).
 */
@Injectable()
export class QuestDBQueryService implements OnModuleInit {
    private connected = false;

    // Очередь всё ещё работает, но теперь каждый запрос создаёт свой PG-клиент
    private queue: {
        sql: string;
        resolve: (v: any) => void;
        reject: (e: any) => void;
    }[] = [];

    private readonly logger = new Logger('QuestDBQuery');

    private readonly host = process.env.QUESTDB_HOST || 'localhost';
    private readonly port = Number(process.env.QUESTDB_PG_PORT || 8812);
    private readonly user = process.env.QUESTDB_USER || 'admin';
    private readonly password = process.env.QUESTDB_PASSWORD || 'quest';
    private readonly database = process.env.QUESTDB_DATABASE || 'qdb';

    // ============================================================
    // INIT
    // ============================================================
    async onModuleInit() {
        this.logger.log(
            `Initializing QuestDB PG connection handler: ${this.host}:${this.port}`,
        );

        // Не подключаемся заранее — это провоцирует обрывы!
        // Просто считаем сервис "готовым".
        this.connected = true;

        this.flushQueue();
    }

    // ============================================================
    // PG CLIENT FACTORY — создаёт новое соединение под каждый запрос
    // ============================================================
    private makeClient(): Client {
        return new Client({
            host: this.host,
            port: this.port,
            user: this.user,
            password: this.password,
            database: this.database,
            keepAlive: true,
        });
    }

    // ============================================================
    // RECONNECT (фактически просто разрешаем очереди работать дальше)
    // ============================================================
    private safeReconnect() {
        this.logger.warn('Reconnecting QuestDB PG (virtual reconnection)');
        this.connected = true;
        setTimeout(() => this.flushQueue(), 50);
    }

    // ============================================================
    // QUEUE — API остаётся, но теперь не зависит от единственного клиента
    // ============================================================
    private enqueue(sql: string): Promise<any> {
        return new Promise((resolve, reject) => {
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

        try {
            await client.connect();
            const res = await client.query(sql);
            return res;
        } catch (err) {
            this.logger.error(`Query failed (${retry}): ${sql}`, err);

            // Retry при обрыве QuestDB
            if (retry <= 2) {
                await new Promise(r => setTimeout(r, 100));
                return this.executeSql(sql, retry + 1);
            }

            throw err;
        } finally {
            await client.end().catch(() => { });
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
}
