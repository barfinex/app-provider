import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { ConnectorType, MarketType, TimeFrame } from '@barfinex/types';
import { BinanceService } from '../connector/datasource/binance/binance.service';
import { CandleQueryService } from '../candle/candle-query.service';
import { HorizontalVolumeProfileRepository } from '../questdb/repositories/horizontal-volume-profile.repository';
import { MarketQualityDto } from '../dto';

@ApiTags('Runtime')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('provider/market-quality')
export class ProviderMarketQualityController {
  constructor(
    private readonly binanceService: BinanceService,
    private readonly candleQueryService: CandleQueryService,
    private readonly horizontalVolumeProfileRepository: HorizontalVolumeProfileRepository,
  ) {}

  private async getPersistedCandleCount(
    symbol: string,
    interval: TimeFrame,
  ): Promise<number> {
    const [spotCoverage, futuresCoverage] = await Promise.all([
      this.candleQueryService.loadSeriesCoverage({
        symbol,
        connectorType: String(ConnectorType.binance),
        marketType: String(MarketType.spot),
        interval,
      }),
      this.candleQueryService.loadSeriesCoverage({
        symbol,
        connectorType: String(ConnectorType.binance),
        marketType: String(MarketType.futures),
        interval,
      }),
    ]);
    return Math.max(
      Number(spotCoverage?.count ?? 0),
      Number(futuresCoverage?.count ?? 0),
    );
  }

  @Get(':symbol')
  @ApiOperation({
    summary: 'Market quality report',
    description:
      'Returns market quality report for a symbol: health score, orderbook (best bid/ask, spread), trades (volume, VWAP), candle counts. ' +
      'Used for symbol health and liquidity assessment.',
  })
  @ApiParam({
    name: 'symbol',
    example: 'BTCUSDT',
    description: 'Trading symbol',
  })
  @ApiOkResponse({
    description: 'Market quality report',
    type: MarketQualityDto,
  })
  @ApiNotFoundResponse({ description: 'Symbol not found' })
  async getMarketQuality(@Param('symbol') symbol: string) {
    const snapshot = this.binanceService.getMarketQualitySnapshot(symbol);
    if (!snapshot) {
      throw new NotFoundException(
        `Market quality report not found for symbol ${symbol}`,
      );
    }
    const [persistedH1, persistedH4, persistedD1] = await Promise.all([
      this.getPersistedCandleCount(snapshot.symbol, TimeFrame.h1),
      this.getPersistedCandleCount(snapshot.symbol, TimeFrame.h4),
      this.getPersistedCandleCount(snapshot.symbol, TimeFrame.day),
    ]);
    const snapshotH1 = Number(snapshot?.candles?.h1?.length ?? 0);
    const snapshotH4 = Number(snapshot?.candles?.h4?.length ?? 0);
    const snapshotD1 = Number(snapshot?.candles?.d1?.length ?? 0);
    const effectiveSnapshot = {
      ...snapshot,
      candlesCountH1: Math.max(snapshotH1, persistedH1),
      candlesCountH4: Math.max(snapshotH4, persistedH4),
      candlesCountD1: Math.max(snapshotD1, persistedD1),
    };
    const report = this.binanceService.getMarketQualityReport(
      snapshot.symbol,
      effectiveSnapshot,
    );
    if (!report) {
      throw new NotFoundException(
        `Market quality report not found for symbol ${symbol}`,
      );
    }
    return {
      symbol: report.symbol,
      healthScore: report.healthScore,
      valid: report.valid,
      critical: report.critical,
      componentStatuses: report.componentStatuses,
      reasons: report.reasons,
      checkedAt: report.checkedAt,
      bestBid: Number(snapshot?.orderbook?.bestBid ?? 0),
      bestAsk: Number(snapshot?.orderbook?.bestAsk ?? 0),
      mid: Number(snapshot?.orderbook?.mid ?? 0),
      spread: Number(snapshot?.orderbook?.spread ?? 0),
      spreadPct: Number(
        snapshot?.orderbook?.spreadPct ?? Number.POSITIVE_INFINITY,
      ),
      orderbookDepth: Number(snapshot?.orderbook?.depth ?? 0),
      tradeCount: Number(snapshot?.trades?.tradeCount ?? 0),
      buyVolume: Number(snapshot?.trades?.buyVolume ?? 0),
      sellVolume: Number(snapshot?.trades?.sellVolume ?? 0),
      vwap: Number(snapshot?.trades?.vwap ?? 0),
      avgTradeSize: Number(snapshot?.trades?.avgTradeSize ?? 0),
      maxTradeSize: Number(snapshot?.trades?.maxTradeSize ?? 0),
      lastTradeTimestamp: Number(snapshot?.trades?.lastTrade?.timestamp ?? 0),
      orderbookTimestamp: Number(snapshot?.timestamps?.orderbookTimestamp ?? 0),
      tradeTimestamp: Number(snapshot?.timestamps?.tradeTimestamp ?? 0),
      candleTimestamp: Number(snapshot?.timestamps?.candleTimestamp ?? 0),
      candlesCountH1: effectiveSnapshot.candlesCountH1,
      candlesCountH4: effectiveSnapshot.candlesCountH4,
      candlesCountD1: effectiveSnapshot.candlesCountD1,
      horizontalVolumeProfile: snapshot?.trades?.horizontalVolumeProfileSummary,
      liquidityMap: snapshot?.trades?.liquidityMap ?? {},
    };
  }

  @Get(':symbol/volume-profile')
  @ApiOperation({
    summary: 'Horizontal volume profile',
    description:
      'Returns horizontal volume profile for the symbol (live and/or persisted). POC, value area, levels.',
  })
  @ApiParam({ name: 'symbol', example: 'BTCUSDT' })
  @ApiOkResponse({
    description:
      'symbol, live { summary, levels }, persisted { updatedAt, summary, levels }',
  })
  @ApiNotFoundResponse({ description: 'Symbol not found' })
  async getHorizontalVolumeProfile(@Param('symbol') symbol: string) {
    const normalized = String(symbol || '')
      .trim()
      .toUpperCase();
    const snapshot = this.binanceService.getMarketQualitySnapshot(normalized);
    const persisted = await this.horizontalVolumeProfileRepository.getLatest(
      normalized,
    );
    if (!snapshot && !persisted) {
      throw new NotFoundException(
        `Horizontal volume profile not found for symbol ${symbol}`,
      );
    }
    const liveSummary =
      snapshot?.trades?.horizontalVolumeProfileSummary ?? null;
    const liveLevels = snapshot?.trades?.horizontalVolumeProfileLevels ?? [];
    const persistedLevelsRaw = String(
      persisted?.levelsjson ?? persisted?.levelsJson ?? '[]',
    );
    let persistedLevels: unknown[] = [];
    try {
      persistedLevels = JSON.parse(persistedLevelsRaw);
    } catch {
      persistedLevels = [];
    }
    return {
      symbol: normalized,
      live: liveSummary
        ? {
            summary: liveSummary,
            levels: liveLevels,
          }
        : null,
      persisted: persisted
        ? {
            updatedAt: Number(
              persisted.ts
                ? new Date(String(persisted.ts)).getTime()
                : Date.now(),
            ),
            summary: {
              bucketSize: Number(
                persisted.bucketsize ?? persisted.bucketSize ?? 0,
              ),
              tradeCount: Number(
                persisted.tradecount ?? persisted.tradeCount ?? 0,
              ),
              buyVolume: Number(
                persisted.buyvolume ?? persisted.buyVolume ?? 0,
              ),
              sellVolume: Number(
                persisted.sellvolume ?? persisted.sellVolume ?? 0,
              ),
              totalVolume: Number(
                persisted.totalvolume ?? persisted.totalVolume ?? 0,
              ),
              deltaVolume: Number(
                persisted.deltavolume ?? persisted.deltaVolume ?? 0,
              ),
              pocPrice: Number(persisted.pocprice ?? persisted.pocPrice ?? NaN),
              valueAreaLow: Number(
                persisted.valuearealow ?? persisted.valueAreaLow ?? NaN,
              ),
              valueAreaHigh: Number(
                persisted.valueareahigh ?? persisted.valueAreaHigh ?? NaN,
              ),
            },
            levels: persistedLevels,
          }
        : null,
    };
  }

  @Get(':symbol/liquidity-map')
  @ApiOperation({
    summary: 'Liquidity map',
    description:
      'Returns liquidity map for the symbol (compact and diagnostics by scope: rolling_30m, candle_30m, etc.).',
  })
  @ApiParam({ name: 'symbol', example: 'BTCUSDT' })
  @ApiQuery({ name: 'marketType', required: false, enum: ['SPOT', 'FUTURES'] })
  @ApiOkResponse({ description: 'symbol, compact, diagnostics' })
  @ApiNotFoundResponse({ description: 'Symbol not found' })
  async getLiquidityMap(
    @Param('symbol') symbol: string,
    @Query('marketType') marketType?: MarketType,
  ) {
    const normalized = String(symbol || '')
      .trim()
      .toUpperCase();
    const snapshot = this.binanceService.getMarketQualitySnapshot(normalized);
    if (!snapshot) {
      throw new NotFoundException(
        `Liquidity map not found for symbol ${symbol}`,
      );
    }
    const scopes: Array<
      | 'rolling_30m'
      | 'candle_30m'
      | 'prev_candle_30m'
      | 'rolling_4h'
      | 'candle_4h'
      | 'prev_candle_4h'
      | 'rolling_24h'
      | 'candle_24h'
      | 'prev_candle_24h'
    > = [
      'rolling_30m',
      'candle_30m',
      'prev_candle_30m',
      'rolling_4h',
      'candle_4h',
      'prev_candle_4h',
      'rolling_24h',
      'candle_24h',
      'prev_candle_24h',
    ];
    return {
      symbol: normalized,
      compact: snapshot?.trades?.liquidityMap ?? {},
      diagnostics: Object.fromEntries(
        scopes.map((scope) => [
          scope,
          this.binanceService.getLiquidityMapSnapshot(
            normalized,
            scope,
            marketType ?? MarketType.futures,
          ),
        ]),
      ),
    };
  }
}
