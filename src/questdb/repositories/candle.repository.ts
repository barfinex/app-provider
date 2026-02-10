import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';
import { QuestDBWriteService } from '../questdb-write.service';
import { QuestDBQueryService } from '../questdb-query.service';

export interface CandleEntity {
  symbol: string;
  interval: string;
  connectorType: string;
  marketType: string;

  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;

  ts: number; // ms
}

@Injectable()
export class CandleRepository extends BaseRepository<CandleEntity> {
  constructor(
    writer: QuestDBWriteService,
    reader: QuestDBQueryService,
  ) {
    super('candles', writer, reader);
    this.channel = 'candles';
  }

  async bulkInsertHistory(bars: CandleEntity[]) {
    if (!bars.length) return;

    this.writer.writeBatch(
      this.channel,
      bars.map(b => ({
        table: this.tableName,
        keys: {
          symbol: b.symbol,
          interval: b.interval,
          connectorType: b.connectorType,
          marketType: b.marketType,
        },
        fields: {
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        },
        timestampNs: b.ts * 1_000_000,
      }))
    );
  }

  async upsertFromTrade(params: {
    symbol: string;
    interval: string;
    connectorType: string;
    marketType: string;
    ts: number;
    price: number;
    volumeDelta: number;
  }) {
    const { symbol, interval, connectorType, marketType, ts, price, volumeDelta } = params;

    this.writer.write(this.channel, {
      table: this.tableName,
      keys: { symbol, interval, connectorType, marketType },
      fields: {
        close: price,
        high: price,
        low: price,
        volume: volumeDelta,
      },
      timestampNs: ts * 1_000_000,
    });
  }

  async finalizeCandle(b: CandleEntity) {
    this.writer.write(this.channel, {
      table: this.tableName,
      keys: {
        symbol: b.symbol,
        interval: b.interval,
        connectorType: b.connectorType,
        marketType: b.marketType,
      },
      fields: {
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      },
      timestampNs: b.ts * 1_000_000,
    });
  }

  async getRange(symbol: string, interval: string, from: number, to: number) {
    symbol = symbol.replace(/'/g, "''");
    interval = interval.replace(/'/g, "''");

    return this.reader.queryAsObjects(`
      SELECT *
      FROM candles
      WHERE symbol='${symbol}'
        AND interval='${interval}'
        AND ts BETWEEN ${from} * 1000 AND ${to} * 1000
      ORDER BY ts ASC
    `);
  }

}
