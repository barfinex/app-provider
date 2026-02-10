import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';
import { QuestDBWriteService } from '../questdb-write.service';
import { QuestDBQueryService } from '../questdb-query.service';

export interface OrderBookLevelEntity {
    symbol: string;
    side: 'bid' | 'ask';
    price: number;
    volume: number;
}

@Injectable()
export class OrderBookRepository extends BaseRepository<OrderBookLevelEntity> {
    constructor(writer: QuestDBWriteService, reader: QuestDBQueryService) {
        super('orderbook_levels', writer, reader);
    }

    async getLatest(symbol: string) {
        symbol = symbol.replace(/'/g, "''");

        return this.query(`
            SELECT *
            FROM orderbook_levels
            LATEST BY ts
            WHERE symbol='${symbol}'
        `);
    }

}
