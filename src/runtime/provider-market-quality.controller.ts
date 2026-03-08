import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConnectorType, MarketType, TimeFrame } from '@barfinex/types';
import { BinanceService } from '../connector/datasource/binance/binance.service';
import { CandleQueryService } from '../candle/candle-query.service';

@ApiTags('Runtime')
@Controller('provider/market-quality')
export class ProviderMarketQualityController {
  constructor(
    private readonly binanceService: BinanceService,
    private readonly candleQueryService: CandleQueryService,
  ) {}

  private async getPersistedCandleCount(symbol: string, interval: TimeFrame): Promise<number> {
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
  async getMarketQuality(@Param('symbol') symbol: string) {
    const snapshot = this.binanceService.getMarketQualitySnapshot(symbol);
    if (!snapshot) {
      throw new NotFoundException(`Market quality report not found for symbol ${symbol}`);
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
    const report = this.binanceService.getMarketQualityReport(snapshot.symbol, effectiveSnapshot);
    if (!report) {
      throw new NotFoundException(`Market quality report not found for symbol ${symbol}`);
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
      spreadPct: Number(snapshot?.orderbook?.spreadPct ?? Number.POSITIVE_INFINITY),
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
    };
  }
}
