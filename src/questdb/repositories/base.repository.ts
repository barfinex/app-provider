import { QuestDBWriteService, ILPWriteOptions } from '../questdb-write.service';
import { QuestDBQueryService } from '../questdb-query.service';

export abstract class BaseRepository<T = any> {

    protected channel: 'main' | 'trades' | 'candles' | 'orderbook' | 'events' = 'main';

    /**
     * @param tableName  - имя таблицы в QuestDB
     * @param writer     - сервис записи ILP
     * @param reader     - сервис PostgreSQL-запросов
     */
    constructor(
        protected readonly tableName: string,
        protected readonly writer: QuestDBWriteService,
        protected readonly reader: QuestDBQueryService,
        // protected readonly channel: 'main' | 'trades' | 'candles' | 'orderbook' | 'events' = 'main',
    ) { }

    // ===============================================
    // INSERT SINGLE ROW
    // ===============================================
    async insert(options: Omit<ILPWriteOptions, 'table'>) {
        await this.writer.write(this.channel, {
            ...options,
            table: this.tableName,
        });
    }

    // ===============================================
    // BATCH INSERT (blocking: enqueue + flush + wait)
    // ===============================================
    async insertBatch(rows: Omit<ILPWriteOptions, 'table'>[]) {
        await this.writer.writeBatch(
            this.channel,
            rows.map(r => ({
                ...r,
                table: this.tableName,
            }))
        );
    }

    // ===============================================
    // ENQUEUE BATCH (non-blocking; use after Redis publish)
    // ===============================================
    enqueueBatch(rows: Omit<ILPWriteOptions, 'table'>[]) {
        this.writer.enqueueBatch(
            this.channel,
            rows.map(r => ({
                ...r,
                table: this.tableName,
            }))
        );
    }

    // ===============================================
    // FLUSH CHANNEL
    // ===============================================
    async flush() {
        await this.writer.flush(this.channel);
    }

    // ===============================================
    // SQL QUERY METHODS
    // ===============================================
    async query<T = any>(sql: string): Promise<T[]> {
        return this.reader.queryAsObjects(sql);
    }

    async queryValue(sql: string): Promise<any> {
        return this.reader.queryValue(sql);
    }

    async findLast(limit = 100) {
        return this.query(
            `SELECT * FROM ${this.tableName} ORDER BY ts DESC LIMIT ${limit}`
        );
    }
}
