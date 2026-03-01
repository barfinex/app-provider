import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Post,
    Put,
    Query,
    Inject,
    forwardRef,
} from '@nestjs/common';

import { ApiTags } from '@nestjs/swagger';

import { OrderService } from './order.service';
import { DetectorService } from '../detector/detector.service';
import { ConnectorService } from '../connector/connector.service';

import { ConnectorType, MarketType, Order, OrderSourceType, Symbol } from '@barfinex/types';

@ApiTags('Orders')
@Controller('orders')
export class OrderController {
    constructor(
        private readonly orderService: OrderService,

        @Inject(forwardRef(() => DetectorService))
        private readonly detectorService: DetectorService,

        @Inject(forwardRef(() => ConnectorService))
        private readonly connectorService: ConnectorService,
    ) { }

    // ========================================================
    // CREATE ORDER
    // ========================================================
    @Post()
    async create(@Body('order') order: Order) {
        return this.orderService.openOrder(order);
    }

    // ========================================================
    // GET ORDER BY ID
    // ========================================================
    @Get(':orderId')
    async get(@Param('orderId') id: string) {
        return this.orderService.get(id);
    }

    // ========================================================
    // CLOSE ORDER
    // ========================================================
    @Put('close')
    async closeOrder(@Body('order') order: Order) {
        return this.orderService.closeOrder(order);
    }

    // ========================================================
    // UPDATE ORDER
    // ========================================================
    @Put(':orderId')
    async update(
        @Param('orderId') id: string,
        @Body('order') order: Order,
    ) {
        return this.orderService.updateOrder({ id, order });
    }

    // ========================================================
    // GET OPEN ORDERS BY DETECTOR
    // ========================================================
    @Get(':connectorType/:marketType')
    async allByConnectorMarket(
        @Param('connectorType') connectorType: ConnectorType,
        @Param('marketType') marketType: MarketType,
        @Query() query: any,
    ) {
        const connector = await this.connectorService.get({ connectorType, marketType });
        const targetMarket = connector.markets?.find(m => m.marketType === marketType);
        const symbols = targetMarket?.symbols ?? [];

        if (!symbols.length) return [];

        const providerKey = this.connectorService.key || 'provider';
        const openOrders = await this.orderService.getOpenOrders({
            connectorType,
            marketType,
            symbols,
            source: {
                key: providerKey,
                type: OrderSourceType.provider,
                restApiUrl: null,
            },
            query,
        });

        return Array.isArray(openOrders) ? openOrders : openOrders.data;
    }

    // ========================================================
    // GET OPEN ORDERS BY DETECTOR
    // ========================================================
    @Get('detector/:sysname')
    async allByDetector(
        @Param('sysname') sysname: string,
        @Query() query: any,
    ) {
        const result: Array<{ id: string; order: Order }> = [];

        const detector = await this.detectorService.getDetector({ sysname });

        for (const provider of detector.providers) {
            for (const connector of provider.connectors ?? []) {
                for (const market of connector.markets) {
                    const openOrders = await this.orderService.getOpenOrders({
                        connectorType: connector.connectorType,
                        marketType: market.marketType,
                        useSandbox: detector.useSandbox,
                        source: {
                            key: sysname,
                            type: OrderSourceType.detector,
                            restApiUrl: null,
                        },
                        symbols: market.symbols,
                        query,
                    });

                    const rows = Array.isArray(openOrders)
                        ? openOrders
                        : openOrders.data;

                    result.push(...rows);
                }
            }
        }

        return result;
    }

    // ========================================================
    // GET ORDERS COUNT BY DETECTOR
    // ========================================================
    @Get('detector/:sysname/count')
    async allCountByDetector(@Param('sysname') sysname: string) {
        const result: Array<{ symbol: Symbol; ordersCount: number }> = [];

        const detector = await this.detectorService.getDetector({ sysname });

        for (const provider of detector.providers) {
            for (const connector of provider.connectors ?? []) {
                for (const market of connector.markets) {
                    const counts = await this.orderService.getOpenOrdersCount({
                        sourceSysname: sysname,
                        sourceType: OrderSourceType.detector,
                        symbols: market.symbols,
                    });

                    result.push(...counts);
                }
            }
        }

        return result;
    }

    // ========================================================
    // GET OPEN ORDERS BY DETECTOR + SYMBOL
    // ========================================================
    @Get('detector/:sysname/symbol/:symbol')
    async allByDetectorBySymbol(
        @Param('sysname') sysname: string,
        @Param('symbol') symbolName: string,
        @Query() query: any,
    ) {
        const result: Array<{ id: string; order: Order }> = [];

        const symbolObj: Symbol = { name: symbolName };

        const detector = await this.detectorService.getDetector({ sysname });

        for (const provider of detector.providers) {
            for (const connector of provider.connectors ?? []) {
                for (const market of connector.markets) {
                    const openOrders = await this.orderService.getOpenOrders({
                        connectorType: connector.connectorType,
                        marketType: market.marketType,
                        symbol: symbolObj,
                        useSandbox: detector.useSandbox,
                        source: {
                            key: sysname,
                            type: OrderSourceType.detector,
                            restApiUrl: null,
                        },
                        symbols: market.symbols,
                        query,
                    });

                    const rows = Array.isArray(openOrders)
                        ? openOrders
                        : openOrders.data;

                    result.push(...rows);
                }
            }
        }

        return result;
    }

    // ========================================================
    // DELETE ALL ORDERS BY DETECTOR
    // ========================================================
    @Delete('detector/:sysname')
    async deleteAllByDetector(@Param('sysname') sysname: string) {
        let result = false;

        const detector = await this.detectorService.getDetector({ sysname });

        for (const provider of detector.providers) {
            for (const connector of provider.connectors ?? []) {
                for (const market of connector.markets) {
                    await this.orderService.deleteAll({
                        connectorType: connector.connectorType,
                        marketType: market.marketType,
                    });

                    result = true;
                }
            }
        }

        return result;
    }

    // ========================================================
    // DELETE ALL ORDERS BY DETECTOR + SYMBOL
    // ========================================================
    @Delete('detector/:sysname/symbol/:symbol')
    async deleteAllByDetectorBySymbol(
        @Param('sysname') sysname: string,
        @Param('symbol') symbolName: string,
    ) {
        let result = false;

        const detector = await this.detectorService.getDetector({ sysname });

        for (const provider of detector.providers) {
            for (const connector of provider.connectors ?? []) {
                for (const market of connector.markets) {
                    await this.orderService.deleteAll({
                        connectorType: connector.connectorType,
                        marketType: market.marketType,
                    });

                    result = true;
                }
            }
        }

        return result;
    }

    // ========================================================
    // DELETE ORDER BY ID + CONNECTOR + MARKET
    // ========================================================
    @Delete(':id/:connectorType/:marketType')
    async deleteByIdConnectorMarket(
        @Param('id') id: string,
        @Param('connectorType') connectorType: ConnectorType,
        @Param('marketType') marketType: MarketType,
    ) {
        const order = await this.orderService.get(id);

        if (
            order.connectorType !== connectorType ||
            order.marketType !== marketType
        ) {
            throw new BadRequestException(
                `Order ${id} does not belong to ${connectorType}/${marketType}`,
            );
        }

        await this.orderService.closeOrder(order);
        return true;
    }

    // ========================================================
    // DELETE ALL ORDERS BY CONNECTOR + MARKET
    // ========================================================
    @Delete('all/:connectorType/:marketType')
    async deleteAllByConnectorMarket(
        @Param('connectorType') connectorType: ConnectorType,
        @Param('marketType') marketType: MarketType,
    ) {
        return this.orderService.deleteAll({ connectorType, marketType });
    }
}
