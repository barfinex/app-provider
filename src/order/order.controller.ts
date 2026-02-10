import {
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

import { Order, OrderSourceType, Symbol } from '@barfinex/types';

@ApiTags('Orders')
@Controller('orders')
export class OrderController {
    constructor(
        private readonly orderService: OrderService,

        @Inject(forwardRef(() => DetectorService))
        private readonly detectorService: DetectorService,
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
}
