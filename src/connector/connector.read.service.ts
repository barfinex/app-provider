import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  Asset,
  Connector,
  Position,
  ConnectorType,
  MarketType,
  Instrument,
  ExchangeConnectorStatus,
} from '@barfinex/types';

import { ExchangeDataService } from './datasource/exchange/exchange-data.service';
import { InstrumentRepository } from '../instrument/instrument.repository';
import { ConnectorRegistry } from './connector.registry';
import { ExchangeManagerService } from './exchange-manager/exchange-manager.service';

@Injectable()
export class ConnectorReadService {
  private readonly logger = new Logger(ConnectorReadService.name);

  constructor(
    private readonly exchangeDataService: ExchangeDataService,
    private readonly instrumentRepository: InstrumentRepository,
    private readonly exchangeManager: ExchangeManagerService,
  ) {}

  // =========================================================================
  // 🔹 ASSETS / POSITIONS
  // =========================================================================
  async getAssetsInfo(
    connectorType: ConnectorType,
    marketType: MarketType,
  ): Promise<{ assets: Asset[]; positions: Position[] }> {
    this.assertConnectorActive(connectorType, marketType);
    // ExchangeDataService delegates to the correct exchange client
    // based on connectorType resolved from config
    return this.exchangeDataService.getAssetsInfo(marketType);
  }

  // =========================================================================
  // 🔹 SYMBOLS
  // =========================================================================
  async getInstrumentsInfo(
    connectorType: ConnectorType,
    marketType: MarketType,
  ): Promise<Instrument[]> {
    const entities = await this.instrumentRepository.getByConnector(
      connectorType,
      marketType,
    );

    return entities.map((e) => ({
      symbol: e.symbol,
      baseAsset: e.baseAsset,
      quoteAsset: e.quoteAsset,
      status: e.status,
      connectorType: e.connectorType as ConnectorType,
      marketType: e.marketType as MarketType,
    }));
  }

  // =========================================================================
  // 🔹 ACCOUNT
  // =========================================================================
  async getAccountInfo(
    connectorType: ConnectorType,
    marketType: MarketType,
  ): Promise<any> {
    const status = this.exchangeManager.getStatus(connectorType, marketType);
    if (status === ExchangeConnectorStatus.INACTIVE) {
      return {
        connectorType,
        marketType,
        assets: [],
        positions: [],
        orders: [],
        instruments: [],
        isActive: false,
      };
    }
    return this.exchangeDataService.getAccountInfo(marketType);
  }

  // =========================================================================
  // 🔹 PRICES
  // =========================================================================
  async getPrices(
    connectorType: ConnectorType,
    marketType: MarketType,
    instruments: Instrument[],
  ): Promise<{ [index: string]: { value: number; moment: number } }> {
    this.assertConnectorActive(connectorType, marketType);
    return this.exchangeDataService.getPrices(marketType, instruments as any);
  }

  // =========================================================================
  // 🔹 ALL CONNECTORS (READ-ONLY)
  // =========================================================================
  async all(): Promise<Connector[]> {
    return Object.values(ConnectorRegistry.connectors).map((connector) => ({
      ...connector,
      markets: connector.markets?.map((m) => ({ ...m })) ?? [],
      assets: connector.assets ?? [],
      positions: connector.positions ?? [],
      orders: connector.orders ?? [],
      subscriptions: connector.subscriptions ?? [],
      isActive: connector.isActive ?? false,
    }));
  }

  // =========================================================================
  // 🔹 SINGLE CONNECTOR (SAFE COPY)
  // =========================================================================
  async get(options: {
    connectorType: ConnectorType;
    marketType?: MarketType;
  }): Promise<Connector> {
    const { connectorType, marketType } = options;

    if (!marketType) {
      this.logger.error(
        `No marketType provided for connector ${connectorType}`,
      );
      throw new BadRequestException(
        `marketType is required for connector ${connectorType}`,
      );
    }

    const source = ConnectorRegistry.getConnector({
      connectorType,
      marketType,
    });

    if (!source) {
      throw new Error(`Connector not found for ${connectorType}:${marketType}`);
    }

    // 🔒 SAFE COPY — registry никогда не мутируем
    const connector: Connector = {
      ...source,
      markets: source.markets?.map((m) => ({ ...m })) ?? [],
      assets: source.assets ?? [],
      positions: source.positions ?? [],
      orders: source.orders ?? [],
      subscriptions: source.subscriptions ?? [],
      isActive: source.isActive ?? false,
    };

    return connector;
  }

  // =========================================================================
  // 🔹 PRIVATE
  // =========================================================================
  private assertConnectorActive(
    connectorType: ConnectorType,
    marketType: MarketType,
  ): void {
    const status = this.exchangeManager.getStatus(connectorType, marketType);
    if (
      status !== ExchangeConnectorStatus.ACTIVE &&
      status !== ExchangeConnectorStatus.CONNECTING &&
      status !== ExchangeConnectorStatus.RECONNECTING
    ) {
      throw new BadRequestException(
        `Connector ${connectorType}:${marketType} is not active (status: ${status})`,
      );
    }
  }
}
