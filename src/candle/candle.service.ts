import { Injectable } from '@nestjs/common';
import {
    TimeFrame,
    History,
    MarketType,
    ConnectorType,
    Symbol,
    Candle,
} from '@barfinex/types';

import { CandleWriterService } from './candle-writer.service';
import { HistoryLoaderService } from './history/history-loader.service';
import { DetectorHistoryService } from './detector/detector-history.service';

@Injectable()
export class CandleService {
    constructor(
        private readonly history: HistoryLoaderService,
        private readonly detectorHistory: DetectorHistoryService,
        private readonly writer: CandleWriterService,
    ) { }

    // ================================================================
    // PUBLIC READ API
    // ================================================================
    async getHistory(options: History): Promise<Candle[]> {
        return this.history.getHistory(options);
    }

    async get(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbol: Symbol,
        interval: TimeFrame,
    ): Promise<Candle[]> {
        return this.history.getSingle({
            connectorType,
            marketType,
            symbol,
            interval,
        });
    }

    async getByDetectorSysname(
        detectorSysname: string,
        symbol: string | Symbol,
        interval: TimeFrame,
    ): Promise<Candle[]> {
        return this.detectorHistory.getByDetectorSysname(
            detectorSysname,
            symbol,
            interval,
        );
    }

    // ================================================================
    // PUBLIC WRITE API (БЕЗ ИЗМЕНЕНИЙ)
    // ================================================================
    async writeFinalCandle(params: {
        symbol: string;
        interval: TimeFrame;
        connectorType: ConnectorType;
        marketType: MarketType;
        candle: Candle;
    }) {
        const { symbol, interval, connectorType, marketType, candle } = params;
        this.writer.writeFinalCandle(symbol, interval, candle, connectorType, marketType);
    }

    async bulkInsertHistory(
        symbol: string,
        interval: TimeFrame,
        connectorType: ConnectorType,
        marketType: MarketType,
        list: Candle[],
    ) {
        const payload = list.map(c => ({
            symbol,
            connectorType,
            marketType,
            interval,
            ts: c.time,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
        }));

        this.writer.writeBatch(payload);
    }

    async upsertFinalCandle(params: {
        connectorType: ConnectorType;
        marketType: MarketType;
        symbol: string;
        interval: TimeFrame;
        candle: Candle;
    }) {
        await this.writeFinalCandle(params);
    }
}
