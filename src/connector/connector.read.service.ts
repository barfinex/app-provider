import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
    Asset,
    Connector,
    Position,
    ConnectorType,
    MarketType,
    Symbol,
} from '@barfinex/types';

import { BinanceService } from './datasource/binance/binance.service';
import { SymbolRepository } from '../symbol/symbol.repository';
import { ConnectorRegistry } from './connector.registry';

@Injectable()
export class ConnectorReadService {
    private readonly logger = new Logger(ConnectorReadService.name);

    constructor(
        private readonly binanceService: BinanceService,
        private readonly symbolRepository: SymbolRepository,
    ) { }

    // =========================================================================
    // 🔹 ASSETS / POSITIONS
    // =========================================================================
    async getAssetsInfo(
        connectorType: ConnectorType,
        marketType: MarketType,
    ): Promise<{ assets: Asset[]; positions: Position[] }> {
        switch (connectorType) {
            case ConnectorType.binance:
                return this.binanceService.getAssetsInfo(marketType);

            default:
                this.logger.error(
                    `[ConnectorReadService] Unsupported connector: ${connectorType}`,
                );
                throw new BadRequestException(
                    `Unsupported connector type: ${connectorType}`,
                );
        }
    }

    // =========================================================================
    // 🔹 SYMBOLS
    // =========================================================================
    async getSymbolsInfo(
        connectorType: ConnectorType,
        marketType: MarketType,
    ): Promise<Symbol[]> {
        const entities =
            await this.symbolRepository.getByConnector(
                connectorType,
                marketType,
            );

        return entities.map(e => ({
            name: e.symbol,
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
        switch (connectorType) {
            case ConnectorType.binance:
                return this.binanceService.getAccountInfo(marketType);

            default:
                return {
                    connectorType,
                    marketType,
                    assets: [],
                    positions: [],
                    orders: [],
                    symbols: [],
                    isActive: false,
                };
        }
    }

    // =========================================================================
    // 🔹 PRICES
    // =========================================================================
    async getPrices(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbols: Symbol[],
    ): Promise<{ [index: string]: { value: number; moment: number } }> {
        switch (connectorType) {
            case ConnectorType.binance:
                return this.binanceService.getPrices(marketType, symbols);

            default:
                this.logger.error(
                    `[ConnectorReadService] Unsupported connector: ${connectorType}`,
                );
                throw new BadRequestException(
                    `Unsupported connector type: ${connectorType}`,
                );
        }
    }

    // =========================================================================
    // 🔹 ALL CONNECTORS (READ-ONLY)
    // =========================================================================
    async all(): Promise<Connector[]> {
        return Object.values(ConnectorRegistry.connectors).map(connector => ({
            ...connector,
            markets: connector.markets?.map(m => ({ ...m })) ?? [],
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
            throw new Error(
                `Connector not found for ${connectorType}:${marketType}`,
            );
        }

        // 🔒 SAFE COPY — registry никогда не мутируем
        const connector: Connector = {
            ...source,
            markets: source.markets?.map(m => ({ ...m })) ?? [],
            assets: source.assets ?? [],
            positions: source.positions ?? [],
            orders: source.orders ?? [],
            subscriptions: source.subscriptions ?? [],
            isActive: source.isActive ?? false,
        };

        return connector;
    }

}
