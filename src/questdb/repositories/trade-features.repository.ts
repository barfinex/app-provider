import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';
import { QuestDBWriteService } from '../questdb-write.service';
import { QuestDBQueryService } from '../questdb-query.service';

export interface TradeFeaturesRow {
  connectorType: string;
  marketType: string;
  symbol: string;
  window: string;
  tradeCount: number;
  buyVolume: number;
  sellVolume: number;
  signedVolume: number;
  imbalance: number;
  avgTradeSize: number;
  maxTradeSize: number;
  tapeSpeed: number;
  vwap: number;
  burstScore: number;
  ts: number;
}

@Injectable()
export class TradeFeaturesRepository extends BaseRepository<TradeFeaturesRow> {
  protected override channel:
    | 'main'
    | 'trades'
    | 'candles'
    | 'orderbook'
    | 'events' = 'trades';

  constructor(writer: QuestDBWriteService, reader: QuestDBQueryService) {
    super('trade_features', writer, reader);
  }

  enqueueFeatures(row: TradeFeaturesRow): void {
    const tsMs = Math.trunc(Number(row.ts ?? Date.now()));
    const tsNs = BigInt(tsMs) * 1_000_000n;
    this.writer.write(this.channel, {
      table: this.tableName,
      keys: {
        connectorType: String(row.connectorType ?? ''),
        marketType: String(row.marketType ?? ''),
        symbol: String(row.symbol ?? '').toUpperCase(),
        window: String(row.window ?? ''),
      },
      fields: {
        tradeCount: BigInt(Math.trunc(Number(row.tradeCount ?? 0))),
        buyVolume: Number(row.buyVolume ?? 0),
        sellVolume: Number(row.sellVolume ?? 0),
        signedVolume: Number(row.signedVolume ?? 0),
        imbalance: Number(row.imbalance ?? 0),
        avgTradeSize: Number(row.avgTradeSize ?? 0),
        maxTradeSize: Number(row.maxTradeSize ?? 0),
        tapeSpeed: Number(row.tapeSpeed ?? 0),
        vwap: Number(row.vwap ?? 0),
        burstScore: Number(row.burstScore ?? 0),
      },
      timestampNs: tsNs,
    });
  }
}
