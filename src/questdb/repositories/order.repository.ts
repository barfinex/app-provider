import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';
import { QuestDBWriteService } from '../questdb-write.service';
import { QuestDBQueryService } from '../questdb-query.service';

export interface OrderEventEntity {
    externalId: string;
    symbol: string;
    connectorType: string;
    marketType: string;
    sourceSysname: string;
    sourceType: string;
    price?: number;
    quantity?: number;
    quantityExecuted?: number;
    status?: string;
}

@Injectable()
export class OrderRepository extends BaseRepository<OrderEventEntity> {
    constructor(writer: QuestDBWriteService, reader: QuestDBQueryService) {
        super('orders_events', writer, reader);
    }

    async getByExternalId(externalId: string) {
        externalId = externalId.replace(/'/g, "''");
        return this.query(`
            SELECT *
            FROM orders_events
            WHERE externalId='${externalId}'
            ORDER BY ts DESC
        `);
    }

    async getHistory(symbol: string, limit = 200) {
        symbol = symbol.replace(/'/g, "''");
        return this.query(`
            SELECT *
            FROM orders_events
            WHERE symbol='${symbol}'
            ORDER BY ts DESC
            LIMIT ${limit}
        `);
    }

}
