import { Body, Controller, Delete, Get, Inject, Post, Put } from '@nestjs/common';
import { Param } from '@nestjs/common/decorators/http/route-params.decorator';
// import { ClientProxy } from '@nestjs/microservices';
import { CandleService } from './candle.service';
import { MarketType, ConnectorType, TimeFrame, Symbol } from '@barfinex/types';
import { ApiTags } from '@nestjs/swagger';
import { DetectorService } from '../detector/detector.service';

@ApiTags('Candles')
@Controller('candles')
export class CandleController {

    constructor(
        private candleService: CandleService
    ) { }


    @Post()
    async create(
        @Body('title') title: string,
        @Body('image') image: string
    ) {
        const candle = await this.candleService.create({ title, image })
        // this.client.emit('candle_created', candle)
        return candle
    }

    @Get(':connectorType/:marketType/:symbol/:interval')
    async get(
        @Param('connectorType') connectorType: ConnectorType,
        @Param('marketType') marketType: MarketType,
        @Param('symbol') symbol: Symbol,
        @Param('interval') interval: TimeFrame,
    ) {
        return this.candleService.get(connectorType, marketType, symbol, interval)
    }

    @Get('/detector/:detectorSysname/symbol/:symbol/:interval')
    async getByDetectorSysname(
        @Param('detectorSysname') detectorSysname: string,
        @Param('symbol') symbol: Symbol,
        @Param('interval') interval: TimeFrame,
    ) {
        return this.candleService.getByDetectorSysname(detectorSysname, symbol, interval)
    }

    @Put(':id')
    async update(
        @Param('id') id: number,
        @Body('title') title: string,
        @Body('image') image: string
    ) {
        // await this.candleSecvice.update(id, { title, image })

        // const candle = await this.candleSecvice.get(id)

        // this.client.emit('candle_updated', candle)

        //return candle
    }

    @Delete(':id')
    async delete(@Param('id') id: number) {

        //this.candleSecvice.delete(id)

        // this.client.emit('candle_deleted', id)
    }



}
