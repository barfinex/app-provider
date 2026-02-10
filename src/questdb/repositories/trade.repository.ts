import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';
import { QuestDBWriteService } from '../questdb-write.service';
import { QuestDBQueryService } from '../questdb-query.service';

export interface TradeEntity {
    symbol: string;
    side: string; // LONG, SHORT
    price: number;
    volume: number;
}

@Injectable()
export class TradeRepository extends BaseRepository<TradeEntity> {
    constructor(writer: QuestDBWriteService, reader: QuestDBQueryService) {
        super('trades', writer, reader);
    }

    async getTrades(symbol: string, limit = 200) {
        symbol = symbol.replace(/'/g, "''");

        return this.query(`
            SELECT *
            FROM trades
            WHERE symbol='${symbol}'
            ORDER BY ts DESC
            LIMIT ${limit}
        `);
    }

}
