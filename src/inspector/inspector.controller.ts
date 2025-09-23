import { Body, Controller, Delete, Get, Post, Put } from '@nestjs/common';
import { Param, Query } from '@nestjs/common/decorators/http/route-params.decorator';
import { InspectorService } from './inspector.service';
import { Inspector, TimeFrame } from '@barfinex/types';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Inspectors')
@Controller('inspectors')
export class InspectorController {

    constructor(
        private inspectorService: InspectorService,
    ) {

    }

    @Get()
    async getAll() {
        return this.inspectorService.getAll();
    }

    @Get(':sysname')
    async get(@Param('sysname') sysname: string) {
        return this.inspectorService.get(sysname)
    }

    @Post()
    async registration(
        @Body('sysname') sysname: string,
        @Body('options') options: Inspector
    ) {
        // const { connectorType, marketType, symbols, intervals, useScratch } = opt
        const inspectorEntity = await this.inspectorService.create(sysname, options)

        // if (useScratch) {
        //     await this.inspectorService.deleteAllOrders({ connectorType, marketType, symbols, sysname })
        // }
        // const activeSymbols = await this.inspectorService.getAllActiveSymbols()
        // await this.inspectorService.updateSubscribeCollectionInConnector({ connectorType, marketType, symbols: activeSymbols, intervals })

        return inspectorEntity.options;
    }

    @Put(':sysname')
    async update(
        @Param('sysname') sysname: string,
        @Body('options') options: Inspector
    ) {

        // const { connectorType, marketType, symbols } = inspectorOptions
        const inspectorEntity = await this.inspectorService.update(sysname, options)
        // const activeSymbols = await this.inspectorService.getAllActiveSymbols()
        // this.inspectorService.updateSubscribeCollectionInConnector({ connectorType, marketType, symbols: activeSymbols, intervals: null });

        return inspectorEntity
    }

    @Delete(':sysname')
    async delete(@Param('sysname') sysname: string) {

        let isDelete = false
        // let { connectorType, marketType, symbols } = await this.inspectorService.getOptions(sysname)

        // if (connectorType) {
        //     await this.inspectorService.deleteAllOrders({ connectorType, marketType, symbols, sysname })
        //     isDelete = await this.inspectorService.delete(sysname)
        //     const activeSymbols = await this.inspectorService.getAllActiveSymbols()
        //     this.inspectorService.updateSubscribeCollectionInConnector({ connectorType, marketType, symbols: activeSymbols, intervals: null })
        // }

        return isDelete
    }

}
