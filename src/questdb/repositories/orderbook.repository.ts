import { Injectable, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(OrderBookRepository.name);

  constructor(writer: QuestDBWriteService, reader: QuestDBQueryService) {
    super('orderbook_levels', writer, reader);
  }

  async getLatest(symbol: string) {
    symbol = symbol.replace(/'/g, "''");

    const rows = await this.query(`
            WITH latest_snapshot AS (
                SELECT max(ts) AS snapshot_ts
                FROM orderbook_levels
                WHERE symbol='${symbol}'
            )
            SELECT symbol, side, price, volume, ts
            FROM orderbook_levels
            WHERE symbol='${symbol}'
              AND ts = (SELECT snapshot_ts FROM latest_snapshot)
            LIMIT 5000
        `);
    this.logger.debug(`[ORDERBOOK] rows=${rows.length} symbol=${symbol}`);
    return rows;
  }
}
