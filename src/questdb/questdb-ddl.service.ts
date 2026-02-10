import { Injectable, OnModuleInit } from '@nestjs/common';
import { QuestDBQueryService } from './questdb-query.service';

@Injectable()
export class QuestDBDDLService implements OnModuleInit {
    constructor(private readonly reader: QuestDBQueryService) { }

    async onModuleInit() {
        console.log('🛠 Generating QuestDB tables...');

        await this.createCandlesTable();
        await this.createTradesTable();
        await this.createOrdersTable();
        await this.createOrderBookTable();
        await this.createSymbolsTable();
        await this.createConnectorsTable();
        await this.createDetectorsTable();
        await this.createInspectorsTable();
        await this.createEventSinkTable();

        console.log('✅ QuestDB schema ready');
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
                symbol SYMBOL,
                interval SYMBOL,
                connectorType SYMBOL,
                marketType SYMBOL,
                open DOUBLE,
                high DOUBLE,
                low DOUBLE,
                close DOUBLE,
                volume DOUBLE,
                ts TIMESTAMP
            ) timestamp(ts)
            PARTITION BY DAY;
        `);
    }

    // =====================================================================
    // TRADES
    // =====================================================================
    private async createTradesTable() {
        await this.exec(`
            CREATE TABLE IF NOT EXISTS trades (
                symbol SYMBOL,
                side SYMBOL,
                price DOUBLE,
                volume DOUBLE,
                ts TIMESTAMP
            ) timestamp(ts)
            PARTITION BY DAY;
        `);
    }

    // =====================================================================
    // ORDERS (soft-delete)
    // =====================================================================
    private async createOrdersTable() {
        await this.exec(`
            CREATE TABLE IF NOT EXISTS orders (
                id SYMBOL,
                externalId SYMBOL,
                connectorType SYMBOL,
                marketType SYMBOL,
                symbol SYMBOL,

                side SYMBOL,
                type SYMBOL,
                price DOUBLE,

                sourceSysname SYMBOL,
                sourceType SYMBOL,
                sourceBaseApiUrl STRING,

                time TIMESTAMP,
                updateTime TIMESTAMP,

                quantity DOUBLE,
                quantityExecuted DOUBLE,

                priceClose DOUBLE,
                closeTime TIMESTAMP,

                useSandbox BOOLEAN,

                status SYMBOL,        -- active | closed | deleted
                deletedAt TIMESTAMP   -- soft delete timestamp
            ) timestamp(updateTime)
            PARTITION BY DAY;
        `);
    }

    // =====================================================================
    // ORDERBOOK LEVELS
    // =====================================================================
    private async createOrderBookTable() {
        await this.exec(`
            CREATE TABLE IF NOT EXISTS orderbook_levels (
                symbol SYMBOL,
                side SYMBOL,
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
                symbol SYMBOL,
                connectorType SYMBOL,
                marketType SYMBOL,
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
    // CONNECTORS (добавлены status, deletedAt)
    // =====================================================================
    private async createConnectorsTable() {
        await this.exec(`
            CREATE TABLE IF NOT EXISTS connectors (
                connectorType SYMBOL,
                options STRING,
                created TIMESTAMP,
                updated TIMESTAMP,

                status SYMBOL,        -- active | disabled | deleted
                deletedAt TIMESTAMP   -- soft delete timestamp
            ) timestamp(updated)
            PARTITION BY DAY;
        `);
    }

    // =====================================================================
    // DETECTORS (добавлены status, deletedAt)
    // =====================================================================
    private async createDetectorsTable() {
        await this.exec(`
            CREATE TABLE IF NOT EXISTS detectors (
                key SYMBOL,
                name SYMBOL,
                options STRING,
                created TIMESTAMP,
                updated TIMESTAMP,

                status SYMBOL,        -- active | disabled | deleted
                deletedAt TIMESTAMP   -- soft delete timestamp
            ) timestamp(updated)
            PARTITION BY DAY;
        `);
    }

    // =====================================================================
    // INSPECTORS (добавлены status, deletedAt)
    // =====================================================================
    private async createInspectorsTable() {
        await this.exec(`
            CREATE TABLE IF NOT EXISTS inspectors (
                name SYMBOL,
                options STRING,
                created TIMESTAMP,
                updated TIMESTAMP,

                status SYMBOL,        -- active | disabled | deleted
                deletedAt TIMESTAMP   -- soft delete timestamp
            ) timestamp(updated)
            PARTITION BY DAY;
        `);
    }

    // =====================================================================
    // EVENT SINK
    // =====================================================================
    private async createEventSinkTable() {
        await this.exec(`
            CREATE TABLE IF NOT EXISTS event_sink (
                eventType SYMBOL,
                symbol SYMBOL,
                connectorType SYMBOL,
                marketType SYMBOL,
                payload STRING,
                ts TIMESTAMP
            ) timestamp(ts)
            PARTITION BY DAY;
        `);
    }
}
