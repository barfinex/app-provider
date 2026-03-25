import { Injectable } from '@nestjs/common';
import {
  ConnectorType,
  LiquidityMapSnapshot,
  MarketType,
} from '@barfinex/types';
import { BaseRepository } from './base.repository';
import { QuestDBQueryService } from '../questdb-query.service';
import { QuestDBWriteService } from '../questdb-write.service';

@Injectable()
export class LiquidityMapRepository extends BaseRepository {
  constructor(writer: QuestDBWriteService, reader: QuestDBQueryService) {
    super('liquidity_map_snapshot', writer, reader);
  }

  enqueueSnapshot(params: {
    symbol: string;
    connectorType: ConnectorType;
    marketType: MarketType;
    snapshot: LiquidityMapSnapshot;
  }): void {
    const summary = params.snapshot.summary;
    const ts =
      BigInt(Math.trunc(Number(summary.updatedAt || Date.now()))) * 1_000_000n;
    this.enqueueBatch([
      {
        keys: {
          symbol: String(params.symbol || '').toUpperCase(),
          connectorType: String(params.connectorType),
          marketType: String(params.marketType),
          scope: String(summary.scope),
        },
        fields: {
          bucketSize: Number(summary.bucketSize || 0),
          pocPrice: Number(summary.pocPrice ?? NaN),
          valueAreaLow: Number(summary.valueAreaLow ?? NaN),
          valueAreaHigh: Number(summary.valueAreaHigh ?? NaN),
          distanceToPocBps: Number(summary.distanceToPocBps ?? NaN),
          distanceToValueAreaLowBps: Number(
            summary.distanceToValueAreaLowBps ?? NaN,
          ),
          distanceToValueAreaHighBps: Number(
            summary.distanceToValueAreaHighBps ?? NaN,
          ),
          nearestHvnAboveDistanceBps: Number(
            summary.nearestHvnAboveDistanceBps ?? NaN,
          ),
          nearestHvnBelowDistanceBps: Number(
            summary.nearestHvnBelowDistanceBps ?? NaN,
          ),
          nearestLvnAboveDistanceBps: Number(
            summary.nearestLvnAboveDistanceBps ?? NaN,
          ),
          nearestLvnBelowDistanceBps: Number(
            summary.nearestLvnBelowDistanceBps ?? NaN,
          ),
          nearestLiquidityWallAboveDistanceBps: Number(
            summary.nearestLiquidityWallAboveDistanceBps ?? NaN,
          ),
          nearestLiquidityWallBelowDistanceBps: Number(
            summary.nearestLiquidityWallBelowDistanceBps ?? NaN,
          ),
          strongestClusterAboveDistanceBps: Number(
            summary.strongestClusterAboveDistanceBps ?? NaN,
          ),
          strongestClusterBelowDistanceBps: Number(
            summary.strongestClusterBelowDistanceBps ?? NaN,
          ),
          localOrderbookImbalance: Number(summary.localOrderbookImbalance || 0),
          localBidLiquidityDensity: Number(
            summary.localBidLiquidityDensity || 0,
          ),
          localAskLiquidityDensity: Number(
            summary.localAskLiquidityDensity || 0,
          ),
          thinZoneAboveDistanceBps: Number(
            summary.thinZoneAboveDistanceBps ?? NaN,
          ),
          thinZoneBelowDistanceBps: Number(
            summary.thinZoneBelowDistanceBps ?? NaN,
          ),
          liquidityPullVelocity: Number(summary.liquidityPullVelocity || 0),
          liquidityAddVelocity: Number(summary.liquidityAddVelocity || 0),
          liquidityConsumeVelocity: Number(
            summary.liquidityConsumeVelocity || 0,
          ),
          liquidityInstabilityScore: Number(
            summary.liquidityInstabilityScore || 0,
          ),
          localAbsorptionScore: Number(summary.localAbsorptionScore || 0),
          localAggressionImbalance: Number(
            summary.localAggressionImbalance || 0,
          ),
          liquidityClusterConfluenceScore: Number(
            summary.liquidityClusterConfluenceScore || 0,
          ),
          liquidityGapPressure: Number(summary.liquidityGapPressure || 0),
          profileOrderbookAlignmentScore: Number(
            summary.profileOrderbookAlignmentScore || 0,
          ),
          currentPriceInValueArea: Number(summary.currentPriceInValueArea || 0),
          topClustersJson: JSON.stringify(params.snapshot.topClusters ?? []),
          topGapsJson: JSON.stringify(params.snapshot.topGaps ?? []),
        },
        timestampNs: ts,
      },
    ]);
  }

  async getLatest(
    symbol: string,
    scope?: string,
  ): Promise<Record<string, unknown> | null> {
    const escaped = String(symbol || '')
      .trim()
      .toUpperCase()
      .replace(/'/g, "''");
    const scopeFilter = scope
      ? `AND scope='${String(scope).replace(/'/g, "''")}'`
      : '';
    const rows = await this.query<Record<string, unknown>>(`
      SELECT *
      FROM liquidity_map_snapshot
      WHERE symbol='${escaped}'
      ${scopeFilter}
      ORDER BY ts DESC
      LIMIT 1
    `);
    return rows[0] ?? null;
  }
}
