import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import axios from 'axios';

import { ConnectorType, MarketType, Symbol } from '@barfinex/types';
import { ConfigService } from '@barfinex/config';

import { BinanceClientService } from '../core/binance.client';

@Injectable()
export class BinanceMarketApi {
    private readonly logger = new Logger(BinanceMarketApi.name);

    constructor(
        private readonly client: BinanceClientService,
        private readonly configService: ConfigService,
    ) { }

    /**
     * Retrieves information about tradable symbols for a specific connector and market type.
     * @param connectorType - The type of the connector (e.g., Binance).
     * @param marketType - Market type (spot, futures, or margin).
     * @returns An array of symbol details.
     */
    async getSymbolsInfo(
        connectorType: ConnectorType,
        marketType: MarketType,
    ): Promise<Symbol[]> {
        await this.client.ensureReady();

        const api = this.client.api;
        const result: Symbol[] = [];

        if (connectorType === ConnectorType.binance) {
            try {
                if (marketType === MarketType.spot) {
                    // Получение информации о спотовых рынках
                    const exchangeInfo = await api.exchangeInfo();
                    exchangeInfo.symbols.forEach((item) => {
                        result.push({
                            name: item.symbol,
                            baseAsset: item.baseAsset,
                            quoteAsset: item.quoteAsset,
                            status: item.status,
                            minPrice: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.minPrice,
                            maxPrice: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.maxPrice,
                            minQuantity: item.filters.find((filter) => filter.filterType === 'LOT_SIZE')?.minQty,
                            stepSize: item.filters.find((filter) => filter.filterType === 'LOT_SIZE')?.stepSize,
                            tickSize: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.tickSize,
                            isSpotTradingAllowed: item.isSpotTradingAllowed,
                            isMarginTradingAllowed: item.isMarginTradingAllowed,
                            connectorType: connectorType,
                            marketType: marketType,
                        });
                    });
                } else if (marketType === MarketType.futures) {
                    const exchangeInfo = await api.futuresExchangeInfo();
                    exchangeInfo.symbols.forEach((item) => {
                        result.push({
                            name: item.symbol, // <-- исправлено
                            baseAsset: item.baseAsset,
                            quoteAsset: item.quoteAsset,
                            status: item.status,
                            minPrice: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.minPrice,
                            maxPrice: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.maxPrice,
                            minQuantity: item.filters.find((filter) => filter.filterType === 'LOT_SIZE')?.minQty,
                            stepSize: item.filters.find((filter) => filter.filterType === 'LOT_SIZE')?.stepSize,
                            tickSize: item.filters.find((filter) => filter.filterType === 'PRICE_FILTER')?.tickSize,
                            isSpotTradingAllowed: false,
                            isMarginTradingAllowed: false,
                            connectorType: connectorType,
                            marketType: marketType,
                        });
                    });
                } else if (marketType === MarketType.margin) {
                    const config = this.configService.getConfig();
                    const connectors = config.provider?.connectors ?? [];

                    const securityConfig = connectors.find(
                        (q: { connectorType: any }) => q.connectorType === ConnectorType.binance,
                    );

                    if (!securityConfig) {
                        throw new InternalServerErrorException(
                            `Connector config not found for type: ${ConnectorType.binance}`,
                        );
                    }

                    const restApiUrl = 'https://api.binance.com/sapi/v1/margin/allPairs';
                    const response = await axios.get(restApiUrl, {
                        headers: {
                            'X-MBX-APIKEY': securityConfig.key,
                        },
                    });

                    response.data.forEach((item: any) => {
                        result.push({
                            name: `${item.baseAsset}${item.quoteAsset}`,
                            baseAsset: item.baseAsset,
                            quoteAsset: item.quoteAsset,
                            status: 'TRADING',
                            connectorType: connectorType,
                            marketType: marketType,
                        });
                    });
                }
            } catch (error: any) {
                this.logger.error(
                    `Error fetching symbols from Binance for connectorType: ${connectorType}, marketType: ${marketType}`,
                    error.stack,
                );

                throw new InternalServerErrorException(
                    'Failed to fetch symbols from Binance. Please try again later.',
                );
            }
        }

        return result;
    }
}
