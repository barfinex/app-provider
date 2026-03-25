import { Injectable } from '@nestjs/common';
import { TimeFrame, TradingSymbol, Candle } from '@barfinex/types';
import { DetectorService } from '../../detector/detector.service';
import { CandleQueryService } from '../candle-query.service';

@Injectable()
export class DetectorHistoryService {
  constructor(
    private readonly detectorService: DetectorService,
    private readonly candleQueryService: CandleQueryService,
  ) {}

  async getByDetectorSysname(
    detectorSysname: string,
    symbol: string | TradingSymbol,
    interval: TimeFrame,
  ): Promise<Candle[]> {
    // ✅ ЕДИНАЯ НОРМАЛИЗАЦИЯ
    const symbolName = typeof symbol === 'string' ? symbol : symbol.name;

    const detector = await this.detectorService.getDetector({
      sysname: detectorSysname,
    });

    const to = Date.now();
    const from =
      interval === TimeFrame.day
        ? to - 100 * 24 * 60 * 60 * 1000
        : to - 7 * 24 * 60 * 60 * 1000;

    const tasks: Promise<Candle[]>[] = [];

    for (const provider of detector.providers ?? []) {
      for (const connector of provider.connectors ?? []) {
        for (const market of connector.markets ?? []) {
          tasks.push(
            this.candleQueryService.loadRangeNormalized({
              connectorType: connector.connectorType,
              marketType: market.marketType,
              symbol: symbolName,
              interval,
              from,
              to,
            }),
          );
        }
      }
    }

    if (!tasks.length) return [];

    return (await Promise.all(tasks)).flat().sort((a, b) => a.time - b.time);
  }
}
