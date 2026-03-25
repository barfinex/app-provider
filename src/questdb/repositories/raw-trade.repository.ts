import { Injectable, Logger } from '@nestjs/common';
import { BaseRepository } from './base.repository';
import { QuestDBWriteService } from '../questdb-write.service';
import { QuestDBQueryService } from '../questdb-query.service';

export interface RawTradeRow {
  connectorType: string;
  marketType: string;
  symbol: string;
  tradeId?: string;
  price: number;
  qty: number;
  side: string;
  aggressorSide?: string;
  isBuyerMaker?: boolean;
  eventTs?: number;
  ingestTs: number;
  ts: number;
}

@Injectable()
export class RawTradeRepository extends BaseRepository<RawTradeRow> {
  private readonly logger = new Logger(RawTradeRepository.name);
  protected override channel:
    | 'main'
    | 'trades'
    | 'candles'
    | 'orderbook'
    | 'events' = 'trades';

  constructor(writer: QuestDBWriteService, reader: QuestDBQueryService) {
    super('raw_trades', writer, reader);
  }

  /**
   * Non-blocking enqueue of one raw trade. Use from ingestion path to avoid blocking on DB.
   */
  enqueueRawTrade(row: RawTradeRow): void {
    const tsMs = Math.trunc(
      Number(row.ts ?? row.eventTs ?? row.ingestTs ?? Date.now()),
    );
    const tsNs = BigInt(tsMs) * 1_000_000n;
    this.writer.write(this.channel, {
      table: this.tableName,
      keys: {
        connectorType: String(row.connectorType ?? ''),
        marketType: String(row.marketType ?? ''),
        symbol: String(row.symbol ?? '').toUpperCase(),
        tradeId: String(row.tradeId ?? ''),
        side: String(row.side ?? ''),
        aggressorSide: String(row.aggressorSide ?? ''),
      },
      fields: {
        price: Number(row.price ?? 0),
        qty: Number(row.qty ?? 0),
        ...(row.isBuyerMaker !== undefined && {
          isBuyerMaker: !!row.isBuyerMaker,
        }),
        eventTs: BigInt(Math.trunc(row.eventTs ?? tsMs)),
        ingestTs: BigInt(Math.trunc(row.ingestTs ?? Date.now())),
      },
      timestampNs: tsNs,
    });
  }

  /**
   * Non-blocking enqueue batch of raw trades.
   */
  enqueueBatchRawTrades(rows: RawTradeRow[]): void {
    if (rows.length === 0) return;
    const opts = rows
      .map((row) => {
        const tsMs = Math.trunc(
          Number(row.ts ?? row.eventTs ?? row.ingestTs ?? Date.now()),
        );
        const tsNs = BigInt(tsMs) * 1_000_000n;
        return {
          table: this.tableName as string,
          keys: {
            connectorType: String(row.connectorType ?? ''),
            marketType: String(row.marketType ?? ''),
            symbol: String(row.symbol ?? '').toUpperCase(),
            tradeId: String(row.tradeId ?? ''),
            side: String(row.side ?? ''),
            aggressorSide: String(row.aggressorSide ?? ''),
          },
          fields: {
            price: Number(row.price ?? 0),
            qty: Number(row.qty ?? 0),
            ...(row.isBuyerMaker !== undefined && {
              isBuyerMaker: !!row.isBuyerMaker,
            }),
            eventTs: BigInt(Math.trunc(row.eventTs ?? tsMs)),
            ingestTs: BigInt(Math.trunc(row.ingestTs ?? Date.now())),
          },
          timestampNs: tsNs,
        };
      })
      .filter((o) => o.fields.price > 0 && o.fields.qty > 0);
    if (opts.length > 0) {
      this.writer.enqueueBatch(this.channel, opts as any);
    }
  }
}
