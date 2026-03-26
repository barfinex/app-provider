import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import {
  ConnectorType,
  MarketType,
  Instrument,
  TimeFrame,
  ExchangeConnectorStatus,
} from '@barfinex/types';

import { ExchangeDataService } from './datasource/exchange/exchange-data.service';
import { CandleSyncService } from '../candle/sync/candle-sync.service';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import { ExchangeManagerService } from './exchange-manager/exchange-manager.service';
import {
  normalizeInstrumentName,
  sanitizeInstruments,
} from './utils/instrument-sanitizer';

interface SymbolPipelineBalanceMeta {
  rawAssetsCount?: number;
  activeAssetsCount?: number;
}

@Injectable()
export class ConnectorSubscriptionService {
  private readonly logger = new Logger(ConnectorSubscriptionService.name);
  private static readonly MAX_INSTRUMENTS = 100;
  private readonly symbolPipelineLogThrottleMs = Math.max(
    1_000,
    Number(process.env.SYMBOL_PIPELINE_LOG_THROTTLE_MS || 5_000),
  );
  private readonly lastSymbolPipelineLogAt = new Map<string, number>();

  constructor(
    private readonly exchangeDataService: ExchangeDataService,
    @Inject(forwardRef(() => CandleSyncService))
    private readonly candleSync: CandleSyncService,
    private readonly questDbQueryService: QuestDBQueryService,
    private readonly exchangeManager: ExchangeManagerService,
  ) {}

  // =========================================================================
  // 🔹 SUBSCRIBE
  // =========================================================================

  async subscribeCollection(
    connectorType: ConnectorType,
    marketType: MarketType,
    instruments: Instrument[],
    intervals: TimeFrame[],
    pipelineMeta?: SymbolPipelineBalanceMeta,
  ): Promise<any> {
    console.log('subscribeCollection');
    const sanitized = this.sanitizeSymbolsAtPipelineEntry(
      connectorType,
      marketType,
      instruments,
      pipelineMeta,
    );

    const status = this.exchangeManager.getStatus(connectorType, marketType);
    if (
      status === ExchangeConnectorStatus.ACTIVE ||
      status === ExchangeConnectorStatus.CONNECTING
    ) {
      await this.exchangeDataService.subscribe(marketType, sanitized, intervals);
      this.exchangeManager.updateCounts(connectorType, marketType, {
        instrumentCount: sanitized.length,
        subscriptionCount: intervals.length,
      });
    } else {
      this.logger.warn(
        `Skipping subscribe for ${connectorType}:${marketType} — status=${status}`,
      );
    }
  }

  // =========================================================================
  // 🔹 UNSUBSCRIBE
  // =========================================================================

  async unsubscribeCollection(connectorType: ConnectorType): Promise<any> {
    await this.exchangeDataService.unsubscribe();
  }

  // =========================================================================
  // 🔹 UPDATE SUBSCRIPTIONS
  // =========================================================================

  async updateSubscribeCollection(
    connectorType: ConnectorType,
    marketType: MarketType,
    instruments: Instrument[],
    intervals?: TimeFrame[],
    pipelineMeta?: SymbolPipelineBalanceMeta,
  ): Promise<void> {
    const sanitizedSymbols = this.sanitizeSymbolsAtPipelineEntry(
      connectorType,
      marketType,
      instruments,
      pipelineMeta,
    );
    const payload = {
      connectorType,
      marketType,
      instruments: sanitizedSymbols,
      intervals: intervals ?? [],
    };
    this.logger.log(
      `Emitting CANDLE_SUBSCRIPTIONS_UPDATED ${connectorType}:${marketType} instruments=${
        payload.instruments.length
      } intervals=${(payload.intervals ?? []).length}`,
    );
    await this.candleSync.onSubscriptionsUpdated(payload);

    await this.candleSync.waitForWarmupCompletion();
    await this.questDbQueryService.waitForWalDrain('candles');

    const status = this.exchangeManager.getStatus(connectorType, marketType);
    if (
      status === ExchangeConnectorStatus.ACTIVE ||
      status === ExchangeConnectorStatus.CONNECTING
    ) {
      await this.exchangeDataService.updateSubscribeCollection(
        marketType,
        sanitizedSymbols,
        intervals,
      );
      this.exchangeManager.updateCounts(connectorType, marketType, {
        instrumentCount: sanitizedSymbols.length,
      });
    } else {
      this.logger.warn(
        `Skipping updateSubscribe for ${connectorType}:${marketType} — status=${status}`,
      );
    }
  }

  private sanitizeSymbolsAtPipelineEntry(
    connectorType: ConnectorType,
    marketType: MarketType,
    instruments: Instrument[],
    pipelineMeta?: SymbolPipelineBalanceMeta,
  ): Instrument[] {
    const inputSymbols = instruments
      .map((s) => normalizeInstrumentName(s?.symbol))
      .filter(Boolean);

    // For connectors that support real-time validation, use exchange validation;
    // otherwise fall back to generic sanitization
    const { validInstruments, removedInstruments } =
      this.exchangeManager.isActive(connectorType, marketType)
        ? this.exchangeDataService.validateSymbolObjects(marketType, instruments)
        : sanitizeInstruments(instruments);

    if (validInstruments.length > ConnectorSubscriptionService.MAX_INSTRUMENTS) {
      this.logger.warn(
        `[InstrumentPipelineProtection] instrument_count_exceeds_limit symbols=${validInstruments.length} limit=${ConnectorSubscriptionService.MAX_INSTRUMENTS}`,
      );
    }

    this.logSymbolPipeline(
      connectorType,
      marketType,
      inputSymbols,
      validInstruments,
      removedInstruments,
      pipelineMeta,
    );
    return validInstruments;
  }

  private logSymbolPipeline(
    connectorType: ConnectorType,
    marketType: MarketType,
    inputSymbols: string[],
    validInstruments: Instrument[],
    removedInstruments: string[],
    pipelineMeta?: SymbolPipelineBalanceMeta,
  ): void {
    const key = `${connectorType}:${marketType}`;
    const now = Date.now();
    const last = this.lastSymbolPipelineLogAt.get(key) ?? 0;
    if (now - last < this.symbolPipelineLogThrottleMs) return;
    this.lastSymbolPipelineLogAt.set(key, now);

    const rawAssetsCount = pipelineMeta?.rawAssetsCount ?? inputSymbols.length;
    const activeAssetsCount =
      pipelineMeta?.activeAssetsCount ?? inputSymbols.length;
    this.logger.log(
      `[SymbolPipeline] connector=${connectorType} market=${marketType} ` +
        `raw_assets=${rawAssetsCount} ` +
        `active_assets=${activeAssetsCount} ` +
        `input_symbols=${inputSymbols.join(',') || 'none'} ` +
        `valid_symbols=${
          validInstruments.map((s) => normalizeInstrumentName(s?.symbol)).join(',') ||
          'none'
        } ` +
        `removed_instruments=${removedInstruments.join(',') || 'none'}`,
    );
  }
}
