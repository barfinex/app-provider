import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';
import { QuestDBWriteService } from '../questdb-write.service';
import { QuestDBQueryService } from '../questdb-query.service';

export interface OrderbookSnapshotRow {
  connectorType: string;
  marketType: string;
  symbol: string;
  depthLevels: number;
  snapshotJson: string;
  ts: number;
}

@Injectable()
export class OrderbookSnapshotsRepository extends BaseRepository<OrderbookSnapshotRow> {
  protected override channel:
    | 'main'
    | 'trades'
    | 'candles'
    | 'orderbook'
    | 'events' = 'orderbook';

  constructor(writer: QuestDBWriteService, reader: QuestDBQueryService) {
    super('orderbook_snapshots', writer, reader);
  }

  enqueueSnapshot(row: OrderbookSnapshotRow): void {
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
        depthLevels: BigInt(
          Math.max(0, Math.floor(Number(row.depthLevels ?? 0))),
        ),
        snapshotJson: String(row.snapshotJson ?? '{}'),
      },
      timestampNs: tsNs,
    });
  }
}
