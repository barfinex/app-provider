import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { OrderService } from './order.service';
import { Order, OrderSourceType, Symbol } from '@barfinex/types';
import { ApiTags } from '@nestjs/swagger';
import { DetectorService } from '../detector/detector.service';

@ApiTags('Orders')
@Controller('orders')
export class OrderController {

    constructor(
        private orderService: OrderService,
        private detectorService: DetectorService,
    ) {

    }


    @Post()
    async create(
        @Body('order') order: Order
    ) {

        // console.log("postCreate");
        // console.log("order:", order);
        return await this.orderService.openOrder(order)
    }


    @Get(':orderId')
    async get(@Param('orderId') id: string) {
        return await this.orderService.get(id)
    }

    @Put('close')
    async closeOrder(
        @Body('order') order: Order
    ) {
        return await this.orderService.closeOrder(order)
    }

    @Put(':orderId')
    async update(
        @Param('orderId') id: string,
        @Body('order') order: Order
    ) {
        return await this.orderService.updateOrder({ id, order })
    }

    @Get('detector/:sysname')
    async allByDetector(@Param('sysname') sysname: string, @Query() query: any) {
        let result: Array<{ id: string; order: Order }> = [];

        const detector = await this.detectorService.getDetector({ sysname });

        for (const provider of detector.providers) {
            if (provider.connectors)
                for (const connector of provider.connectors) {
                    for (const market of connector.markets) {

                        // Fetch open orders for the current market
                        // const openOrders = await this.orderService.getOpenOrders({
                        //     connectorType: connector.connectorType,
                        //     marketType: market.marketType,
                        //     useSandbox: detector.useSandbox,
                        //     source: {
                        //         key: sysname,
                        //         type: OrderSourceType.detector,
                        //         restApiUrl: null,
                        //     },
                        //     symbols: market.symbols,
                        //     query,
                        // })
                    }
                }
        }

        return result;
    }



    @Get('detector/:sysname/count')
    async allCountByDetector(@Param('sysname') sysname: string, @Query() query: any) {
        let result: Array<{ symbol: Symbol; ordersCount: number }> = [];

        const detector = await this.detectorService.getDetector({ sysname });

        for (const provider of detector.providers) {
            if (provider.connectors)
                for (const connector of provider.connectors) {
                    for (const market of connector.markets) {
                        // Fetch open orders count for the current market
                        const openOrdersCount = await this.orderService.getOpenOrdersCount({
                            sourceSysname: sysname,
                            sourceType: OrderSourceType.detector,
                            symbols: market.symbols,
                        })
                    }
                }
        }

        return result
    }



    @Get('detector/:sysname/symbol/:symbol')
    async allByDetectorBySymbol(
        @Param('sysname') sysname: string,
        @Param('symbol') symbol: Symbol,
        @Query() query: any
    ) {
        let result: Array<{ id: number; order: Order }> = [];

        const detector = await this.detectorService.getDetector({ sysname });

        for (const provider of detector.providers) {
            if (provider.connectors)
                for (const connector of provider.connectors) {
                    for (const market of connector.markets) {

                        // Fetch open orders for the current market and symbol
                        const openOrders = await this.orderService.getOpenOrders({
                            connectorType: connector.connectorType,
                            marketType: market.marketType,
                            symbol,
                            useSandbox: detector.useSandbox,
                            source: {
                                key: sysname,
                                type: OrderSourceType.detector,
                                restApiUrl: null,
                            },
                            symbols: market.symbols,
                            query,
                        });

                        // Append fetched orders to the result array
                        result.push(...openOrders);

                    }
                }
        }

        return result
    }



    @Delete('detector/:sysname')
    async deleteAllByDetector(
        @Param('sysname') sysname: string,
        @Param('symbol') symbol: Symbol
    ) {
        let result = false;

        const detector = await this.detectorService.getDetector({ sysname });

        for (const provider of detector.providers) {
            if (provider.connectors)
                for (const connector of provider.connectors) {
                    for (const market of connector.markets) {

                        await this.orderService.deleteAll({
                            connectorType: connector.connectorType,
                            marketType: market.marketType,
                        });

                        // Set result to true if any orders were deleted
                        result = true;
                    }
                }
        }

        return result;
    }





    @Delete('detector/:sysname/symbol/:symbol')
    async deleteAllByDetectorBySymbol(
        @Param('sysname') sysname: string,
        @Param('symbol') symbol: Symbol
    ) {
        let result = false;

        const detector = await this.detectorService.getDetector({ sysname });

        for (const provider of detector.providers) {
            if (provider.connectors)
                for (const connector of provider.connectors) {
                    for (const market of connector.markets) {

                        // Delete all orders for the current market and symbol
                        await this.orderService.deleteAll({
                            connectorType: connector.connectorType,
                            marketType: market.marketType,
                            symbols: market.symbols,
                        });

                        // Set result to true if any orders were deleted
                        result = true;
                    }
                }
        }

        return result;
    }






















}
