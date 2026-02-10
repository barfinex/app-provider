import {
    BadRequestException,
    Inject,
    Injectable,
} from '@nestjs/common';
import {
    Order,
    ConnectorType,
    MarketType,
    Symbol,
    SubscriptionType,
    SubscriptionValue,
    OrderSource,
} from '@barfinex/types';
import { ClientProxy } from '@nestjs/microservices';

// import {

//     AlpacaService,
//     TinkoffService,
//     TestnetBinanceFuturesService,
// } from './datasource';

import { ConnectorRegistry } from './connector.registry';
import { BinanceService } from './datasource/binance/binance.service';

@Injectable()
export class ConnectorTradeService {
    private readonly isEmitToRedisEnabled = true;

    constructor(
        private readonly binanceService: BinanceService,
        // private readonly alpacaService: AlpacaService,
        // private readonly tinkoffService: TinkoffService,
        // private readonly testnetBinanceFuturesService: TestnetBinanceFuturesService,

        @Inject('PROVIDER_SERVICE')
        private readonly client: ClientProxy,
    ) { }

    // =========================================================================
    // 🔹 LEVERAGE
    // =========================================================================

    async changeLeverage(
        connectorType: ConnectorType,
        symbol: Symbol,
        newLeverage: number,
    ): Promise<Symbol> {
        switch (connectorType) {
            case ConnectorType.binance:
                return await this.binanceService.changeLeverage(symbol, newLeverage);

            // case ConnectorType.testnetBinanceFutures:
            //     return await this.testnetBinanceFuturesService.changeLeverage(symbol, newLeverage);

            default:
                throw new Error(
                    `[ConnectorTradeService] Unsupported connector type: ${connectorType}`,
                );
        }
    }

    // =========================================================================
    // 🔹 OPEN ORDER
    // =========================================================================

    async openOrder(order: Order): Promise<Order> {
        const subscriptionType = SubscriptionType.PROVIDER_ORDER_CREATE;

        const subscriptionValue: SubscriptionValue = {
            value: order,
            options: {
                connectorType: order.connectorType,
                marketType: order.marketType,
                key: ConnectorRegistry.key,
                updateMoment: Date.now(),
            },
        };

        let result: Order;

        switch (order.connectorType) {
            case ConnectorType.binance:
                result = await this.binanceService.openOrder(order);
                break;

            // case ConnectorType.alpaca:
            //     result = await this.alpacaService.openOrder(order);
            //     break;

            // case ConnectorType.tinkoff:
            //     result = await this.tinkoffService.openOrder(order);
            //     break;

            // case ConnectorType.testnetBinanceFutures:
            //     result = await this.testnetBinanceFuturesService.openOrder(order);
            //     break;

            default:
                throw new BadRequestException(
                    `Unsupported connector type: ${order.connectorType}`,
                );
        }

        if (this.isEmitToRedisEnabled) {
            this.client.emit(subscriptionType, subscriptionValue);
        }

        return result;
    }

    // =========================================================================
    // 🔹 GET OPEN ORDERS
    // =========================================================================

    async getOpenOrders(options: {
        symbol: Symbol;
        source: OrderSource;
        connectorType: ConnectorType;
        marketType: MarketType;
    }): Promise<Order[]> {
        const { symbol, connectorType, marketType } = options;

        switch (connectorType) {
            case ConnectorType.binance:
                return await this.binanceService.getOpenOrders({
                    symbol,
                    marketType,
                });

            case ConnectorType.alpaca:
                return [];

            case ConnectorType.tinkoff:
                return [];

            case ConnectorType.testnetBinanceFutures:
                return [];

            default:
                throw new BadRequestException(
                    `Unsupported connector type: ${connectorType}`,
                );
        }
    }

    async getAllOpenOrders(options: {
        connectorType: ConnectorType;
        marketType: MarketType;
    }): Promise<Order[]> {
        switch (options.connectorType) {
            case ConnectorType.binance:
                return await this.binanceService.getOpenOrders({
                    marketType: options.marketType,
                });

            // case ConnectorType.testnetBinanceFutures:
            //     return await this.testnetBinanceFuturesService.getOpenOrders({ marketType: options.marketType });

            default:
                throw new BadRequestException(
                    `Unsupported connector type: ${options.connectorType}`,
                );
        }
    }

    // =========================================================================
    // 🔹 CLOSE ORDER
    // =========================================================================

    async closeOrder(order: Order): Promise<Order> {
        const { externalId, symbol, connectorType, marketType, source } = order;

        if (!externalId) {
            throw new BadRequestException(
                'Order.externalId is required to close order',
            );
        }

        if (!symbol) {
            throw new BadRequestException(
                'Order.symbol is required to close order',
            );
        }

        let result: Order = {
            useSandbox: false,
            connectorType,
            marketType,
            source,
            closeTime: null,
        };

        switch (connectorType) {
            case ConnectorType.binance:
                result = await this.binanceService.closeOrder({
                    id: externalId,
                    symbol,
                    marketType,
                });
                break;

            // case ConnectorType.testnetBinanceFutures:
            //     result = await this.testnetBinanceFuturesService.closeOrder({
            //         id: externalId,
            //         symbol,
            //         marketType,
            //     });
            //     break;

            case ConnectorType.alpaca:
            case ConnectorType.tinkoff:
                throw new BadRequestException(
                    `closeOrder not supported for ${connectorType}`,
                );

            default:
                throw new BadRequestException(
                    `Unsupported connector type: ${connectorType}`,
                );
        }

        const subscriptionValue: SubscriptionValue = {
            value: result,
            options: {
                connectorType: result.connectorType,
                marketType: result.marketType,
                key: ConnectorRegistry.key,
                updateMoment: Date.now(),
            },
        };

        if (this.isEmitToRedisEnabled) {
            this.client.emit(
                SubscriptionType.PROVIDER_ORDER_CLOSE,
                subscriptionValue,
            );
        }

        return result;
    }

    // =========================================================================
    // 🔹 CLOSE ALL
    // =========================================================================

    async closeAllOrders(options: {
        symbol: Symbol;
        connectorType: ConnectorType;
        marketType: MarketType;
    }): Promise<void> {
        const { symbol, connectorType, marketType } = options;

        switch (connectorType) {
            case ConnectorType.binance:
                return await this.binanceService.closeAllOrders({
                    symbol,
                    marketType,
                });

            case ConnectorType.alpaca:
                return;

            case ConnectorType.tinkoff:
                return;

            // case ConnectorType.testnetBinanceFutures:
            //     return await this.testnetBinanceFuturesService.closeAllOrders({ symbol, marketType });
        }
    }
}
