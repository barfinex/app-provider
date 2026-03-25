import { Injectable } from '@nestjs/common';
import { ConnectorType, MarketType } from '@barfinex/types';
import {
  HorizontalVolumeProfileLevel,
  HorizontalVolumeProfileSummary,
} from '@barfinex/types';
import { BaseRepository } from './base.repository';
import { QuestDBQueryService } from '../questdb-query.service';
import { QuestDBWriteService } from '../questdb-write.service';

@Injectable()
export class HorizontalVolumeProfileRepository extends BaseRepository {
  constructor(writer: QuestDBWriteService, reader: QuestDBQueryService) {
    super('horizontal_volume_profile', writer, reader);
  }

  enqueueSummary(params: {
    symbol: string;
    connectorType: ConnectorType;
    marketType: MarketType;
    summary: HorizontalVolumeProfileSummary;
    levels: HorizontalVolumeProfileLevel[];
  }): void {
    const ts =
      BigInt(Math.trunc(Number(params.summary.updatedAt || Date.now()))) *
      1_000_000n;
    const levelsJson = JSON.stringify(
      (params.levels || []).map((level) => ({
        p: Number(level.price),
        b: Number(level.buyVolume),
        s: Number(level.sellVolume),
        t: Number(level.totalVolume),
        c: Number(level.tradeCount),
      })),
    );
    this.enqueueBatch([
      {
        keys: {
          symbol: String(params.symbol || '').toUpperCase(),
          connectorType: String(params.connectorType),
          marketType: String(params.marketType),
          scope: String(params.summary.scope),
        },
        fields: {
          bucketSize: Number(params.summary.bucketSize || 0),
          tradeCount: BigInt(
            Math.trunc(Number(params.summary.tradeCount || 0)),
          ),
          buyVolume: Number(params.summary.buyVolume || 0),
          sellVolume: Number(params.summary.sellVolume || 0),
          totalVolume: Number(params.summary.totalVolume || 0),
          deltaVolume: Number(params.summary.deltaVolume || 0),
          pocPrice: Number(params.summary.pocPrice ?? NaN),
          valueAreaLow: Number(params.summary.valueAreaLow ?? NaN),
          valueAreaHigh: Number(params.summary.valueAreaHigh ?? NaN),
          nearestHighAbove: Number(
            params.summary.nearestHighVolumeNodeAbove ?? NaN,
          ),
          nearestHighBelow: Number(
            params.summary.nearestHighVolumeNodeBelow ?? NaN,
          ),
          nearestLowAbove: Number(
            params.summary.nearestLowVolumeNodeAbove ?? NaN,
          ),
          nearestLowBelow: Number(
            params.summary.nearestLowVolumeNodeBelow ?? NaN,
          ),
          profileSkew: Number(params.summary.profileSkew || 0),
          concentrationScore: Number(params.summary.concentrationScore || 0),
          localImbalance: Number(params.summary.localImbalance || 0),
          buySellDeltaAtCurrentRegion: Number(
            params.summary.buySellDeltaAtCurrentRegion || 0,
          ),
          distanceToPocBps: Number(params.summary.distanceToPocBps ?? NaN),
          windowStart: BigInt(
            Math.trunc(Number(params.summary.windowStart || 0)),
          ),
          windowEnd: BigInt(Math.trunc(Number(params.summary.windowEnd || 0))),
          levelsJson,
        },
        timestampNs: ts,
      },
    ]);
  }

  async getLatest(symbol: string): Promise<Record<string, unknown> | null> {
    const escaped = String(symbol || '')
      .trim()
      .toUpperCase()
      .replace(/'/g, "''");
    const rows = await this.query<Record<string, unknown>>(`
      SELECT *
      FROM horizontal_volume_profile
      WHERE symbol='${escaped}'
      ORDER BY ts DESC
      LIMIT 1
    `);
    return rows[0] ?? null;
  }
}
