import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    ConnectorType,
    MarketType,
    Symbol,
    TimeFrame,
} from '@barfinex/types';

import { CANDLE_SUBSCRIPTIONS_UPDATED } from '../common/constants';
// import {
//     AlpacaService,
//     TinkoffService,
//     TestnetBinanceFuturesService,
// } from './datasource';
import { BinanceService } from './datasource/binance/binance.service';
import { CandleSyncService } from '../candle/sync/candle-sync.service';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import {
    normalizeTradingSymbol,
    sanitizeTradingSymbolObjects,
} from './utils/trading-symbol-sanitizer';

interface SymbolPipelineBalanceMeta {
    rawAssetsCount?: number;
    activeAssetsCount?: number;
}

@Injectable()
export class ConnectorSubscriptionService {
    private readonly logger = new Logger(ConnectorSubscriptionService.name);
    private static readonly MAX_SYMBOLS = 100;
    private readonly symbolPipelineLogThrottleMs = Math.max(
        1_000,
        Number(process.env.SYMBOL_PIPELINE_LOG_THROTTLE_MS || 5_000),
    );
    private readonly lastSymbolPipelineLogAt = new Map<string, number>();

    constructor(
        private readonly eventEmitter: EventEmitter2,
        private readonly binanceService: BinanceService,
        @Inject(forwardRef(() => CandleSyncService))
        private readonly candleSync: CandleSyncService,
        private readonly questDbQueryService: QuestDBQueryService,
        // private readonly alpacaService: AlpacaService,
        // private readonly tinkoffService: TinkoffService,
        // private readonly testnetBinanceFuturesService: TestnetBinanceFuturesService,
    ) { }

    // =========================================================================
    // 🔹 SUBSCRIBE
    // =========================================================================

    async subscribeCollection(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbols: Symbol[],
        intervals: TimeFrame[],
        pipelineMeta?: SymbolPipelineBalanceMeta,
    ): Promise<any> {
        console.log('subscribeCollection');
        const sanitized = this.sanitizeSymbolsAtPipelineEntry(
            connectorType,
            marketType,
            symbols,
            pipelineMeta,
        );

        switch (connectorType) {
            case ConnectorType.binance:
                await this.binanceService.subscribe(
                    marketType,
                    sanitized,
                    intervals,
                );
                break;

            case ConnectorType.alpaca:
                break;

            case ConnectorType.tinkoff:
                break;

            // case ConnectorType.testnetBinanceFutures:
            //     return await this.testnetBinanceFuturesService.subscribe(marketType, symbols, intervals);
            //     break;
        }
    }

    // =========================================================================
    // 🔹 UNSUBSCRIBE
    // =========================================================================

    async unsubscribeCollection(
        connectorType: ConnectorType,
    ): Promise<any> {
        switch (connectorType) {
            case ConnectorType.binance:
                await this.binanceService.unsubscribe();
                break;

            case ConnectorType.alpaca:
                break;

            case ConnectorType.tinkoff:
                break;

            // case ConnectorType.testnetBinanceFutures:
            //     return await this.testnetBinanceFuturesService.unsubscribe();
            //     break;
        }
    }

    // =========================================================================
    // 🔹 UPDATE SUBSCRIPTIONS
    // =========================================================================

    async updateSubscribeCollection(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbols: Symbol[],
        intervals?: TimeFrame[],
        pipelineMeta?: SymbolPipelineBalanceMeta,
    ): Promise<void> {
        const sanitizedSymbols = this.sanitizeSymbolsAtPipelineEntry(
            connectorType,
            marketType,
            symbols,
            pipelineMeta,
        );
        const payload = {
            connectorType,
            marketType,
            symbols: sanitizedSymbols,
            intervals: intervals ?? [],
        };
        this.logger.log(
            `Emitting CANDLE_SUBSCRIPTIONS_UPDATED ${connectorType}:${marketType} symbols=${payload.symbols.length} intervals=${(payload.intervals ?? []).length}`,
        );
        this.eventEmitter.emit(CANDLE_SUBSCRIPTIONS_UPDATED, payload);
        this.candleSync.onSubscriptionsUpdated(payload).catch((err) => {
            this.logger.error(`Candle warmup failed ${connectorType}:${marketType}`, err);
        });

        await this.candleSync.waitForWarmupCompletion();
        await this.questDbQueryService.waitForWalDrain('candles');

        switch (connectorType) {
            case ConnectorType.binance:
                await this.binanceService.updateSubscribeCollection(
                    marketType,
                    sanitizedSymbols,
                    intervals,
                );
                break;

            case ConnectorType.alpaca:
                break;

            case ConnectorType.tinkoff:
                break;
        }
    }

    private sanitizeSymbolsAtPipelineEntry(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbols: Symbol[],
        pipelineMeta?: SymbolPipelineBalanceMeta,
    ): Symbol[] {
        const inputSymbols = symbols
            .map((s) => normalizeTradingSymbol(s?.name))
            .filter(Boolean);
        const { validSymbols, removedSymbols } =
            connectorType === ConnectorType.binance
                ? this.binanceService.validateBinanceSymbolObjects(
                    marketType,
                    symbols,
                )
                : sanitizeTradingSymbolObjects(symbols);

        if (validSymbols.length > ConnectorSubscriptionService.MAX_SYMBOLS) {
            this.logger.warn(
                `[SymbolPipelineProtection] symbol_count_exceeds_limit symbols=${validSymbols.length} limit=${ConnectorSubscriptionService.MAX_SYMBOLS}`,
            );
        }

        this.logSymbolPipeline(
            connectorType,
            marketType,
            inputSymbols,
            validSymbols,
            removedSymbols,
            pipelineMeta,
        );
        return validSymbols;
    }

    private logSymbolPipeline(
        connectorType: ConnectorType,
        marketType: MarketType,
        inputSymbols: string[],
        validSymbols: Symbol[],
        removedSymbols: string[],
        pipelineMeta?: SymbolPipelineBalanceMeta,
    ): void {
        const key = `${connectorType}:${marketType}`;
        const now = Date.now();
        const last = this.lastSymbolPipelineLogAt.get(key) ?? 0;
        if (now - last < this.symbolPipelineLogThrottleMs) return;
        this.lastSymbolPipelineLogAt.set(key, now);

        const rawAssetsCount = pipelineMeta?.rawAssetsCount ?? inputSymbols.length;
        const activeAssetsCount = pipelineMeta?.activeAssetsCount ?? inputSymbols.length;
        this.logger.log(
            `[SymbolPipeline] connector=${connectorType} market=${marketType} `
            + `raw_assets=${rawAssetsCount} `
            + `active_assets=${activeAssetsCount} `
            + `input_symbols=${inputSymbols.join(',') || 'none'} `
            + `valid_symbols=${validSymbols.map((s) => normalizeTradingSymbol(s?.name)).join(',') || 'none'} `
            + `removed_symbols=${removedSymbols.join(',') || 'none'}`,
        );
    }
}
