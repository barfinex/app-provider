import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';
import { QuestDBWriteService } from '../questdb-write.service';
import { QuestDBQueryService } from '../questdb-query.service';

export interface OrderbookFeaturesRow {
  connectorType: string;
  marketType: string;
  symbol: string;
  spreadBps: number;
  depthImbalance: number;
  microprice: number;
  liquidityTop1: number;
  liquidityTop5: number;
  liquidityTop10: number;
  bidPressure: number;
  askPressure: number;
  replenishmentSignal: number;
  depletionSignal: number;
  spreadWideningSignal?: number;
  ts: number;
}

@Injectable()
export class OrderbookFeaturesRepository extends BaseRepository<OrderbookFeaturesRow> {
  protected override channel:
    | 'main'
    | 'trades'
    | 'candles'
    | 'orderbook'
    | 'events' = 'orderbook';

  constructor(writer: QuestDBWriteService, reader: QuestDBQueryService) {
    super('orderbook_features', writer, reader);
  }

  enqueueFeatures(row: OrderbookFeaturesRow): void {
    const tsMs = Math.trunc(Number(row.ts ?? Date.now()));
    const tsNs = BigInt(tsMs) * 1_000_000n;
    this.writer.write(this.channel, {
      table: this.tableName,
      keys: {
        connectorType: String(row.connectorType ?? ''),
        marketType: String(row.marketType ?? ''),
        symbol: String(row.symbol ?? '').toUpperCase(),
      },
      fields: {
        spreadBps: Number(row.spreadBps ?? 0),
        depthImbalance: Number(row.depthImbalance ?? 0),
        microprice: Number(row.microprice ?? 0),
        liquidityTop1: Number(row.liquidityTop1 ?? 0),
        liquidityTop5: Number(row.liquidityTop5 ?? 0),
        liquidityTop10: Number(row.liquidityTop10 ?? 0),
        bidPressure: Number(row.bidPressure ?? 0),
        askPressure: Number(row.askPressure ?? 0),
        replenishmentSignal: BigInt(
          Math.trunc(Number(row.replenishmentSignal ?? 0)),
        ),
        depletionSignal: BigInt(Math.trunc(Number(row.depletionSignal ?? 0))),
        spreadWideningSignal: BigInt(
          Number.isFinite(row.spreadWideningSignal)
            ? Math.trunc(row.spreadWideningSignal!)
            : 0,
        ),
      },
      timestampNs: tsNs,
    });
  }
}
