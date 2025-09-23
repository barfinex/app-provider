import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {  ConnectorType, MarketType, Symbol, TimeFrame, Detector } from '@barfinex/types';
import { ConnectorService, } from './connector.service';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Connectors')
@Controller('connectors')
export class ConnectorController {

    constructor(
        private connectorService: ConnectorService,
    ) { }

    @Get(':connectorType/:marketType')
    async get(@Param('connectorType') connectorType: ConnectorType, @Param('marketType') marketType: MarketType) {
        return this.connectorService.get({ connectorType, marketType })
    }


    @Get()
    async getAll(@Query() query: any): Promise<any> {
        return this.connectorService.getConnectorsList()
    }

    @Get('availability')
    async availability(): Promise<{
        endpoint: boolean,
        detectors: Detector[]
    }> {
        return {
            endpoint: true,
            detectors: await this.connectorService.getAllDetectors()
        }
    }

    @Post()
    async createMessage(@Body('content') content: string) {
        const newMessage = await this.connectorService.createMessage(content)
        return newMessage
    }

    @Post('subscribes/update')
    async updateSubscribes(@Body('content') content: { connectorType: ConnectorType, marketType: MarketType, symbols: Symbol[], intervals: TimeFrame[] }) {
        const { connectorType, marketType, symbols, intervals } = content
        await this.connectorService.updateSubscribeCollection(connectorType, marketType, symbols, intervals)
    }

}
