import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';
import { QuestDBWriteService } from '../questdb-write.service';
import { QuestDBQueryService } from '../questdb-query.service';

export interface OrderbookTopRow {
  connectorType: string;
  marketType: string;
  symbol: string;
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadBps?: number;
  midPrice: number;
  microprice?: number;
  bidDepthTopN?: number;
  askDepthTopN?: number;
  depthImbalance?: number;
  liquidity1bps?: number;
  liquidity5bps?: number;
  bookPressure?: number;
  bookSlope?: number;
  lastBookTs: number;
  ts: number;
}

@Injectable()
export class OrderbookTopRepository extends BaseRepository<OrderbookTopRow> {
  protected override channel:
    | 'main'
    | 'trades'
    | 'candles'
    | 'orderbook'
    | 'events' = 'orderbook';

  constructor(writer: QuestDBWriteService, reader: QuestDBQueryService) {
    super('orderbook_top', writer, reader);
  }

  enqueueTop(row: OrderbookTopRow): void {
    const tsMs = Math.trunc(Number(row.ts ?? row.lastBookTs ?? Date.now()));
    const tsNs = BigInt(tsMs) * 1_000_000n;
    this.writer.write(this.channel, {
      table: this.tableName,
      keys: {
        connectorType: String(row.connectorType ?? ''),
        marketType: String(row.marketType ?? ''),
        symbol: String(row.symbol ?? '').toUpperCase(),
      },
      fields: {
        bestBid: Number(row.bestBid ?? 0),
        bestAsk: Number(row.bestAsk ?? 0),
        spread: Number(row.spread ?? 0),
        midPrice: Number(row.midPrice ?? 0),
        lastBookTs: BigInt(Math.trunc(row.lastBookTs ?? tsMs)),
        ...(Number.isFinite(row.spreadBps) && { spreadBps: row.spreadBps }),
        ...(Number.isFinite(row.microprice) && { microprice: row.microprice }),
        ...(Number.isFinite(row.bidDepthTopN) && {
          bidDepthTopN: row.bidDepthTopN,
        }),
        ...(Number.isFinite(row.askDepthTopN) && {
          askDepthTopN: row.askDepthTopN,
        }),
        ...(Number.isFinite(row.depthImbalance) && {
          depthImbalance: row.depthImbalance,
        }),
        ...(Number.isFinite(row.liquidity1bps) && {
          liquidity1bps: row.liquidity1bps,
        }),
        ...(Number.isFinite(row.liquidity5bps) && {
          liquidity5bps: row.liquidity5bps,
        }),
        ...(Number.isFinite(row.bookPressure) && {
          bookPressure: row.bookPressure,
        }),
        ...(Number.isFinite(row.bookSlope) && { bookSlope: row.bookSlope }),
      },
      timestampNs: tsNs,
    });
  }
}
