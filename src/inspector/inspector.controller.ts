// src/inspector/inspector.controller.ts
import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { InspectorService } from './inspector.service';
import { Inspector } from '@barfinex/types';

@ApiTags('Inspectors')
@Controller('inspectors')
export class InspectorController {
    constructor(private readonly inspectorService: InspectorService) { }

    @Get()
    async getAll() {
        return this.inspectorService.getAll();
    }

    @Get(':sysname')
    async get(@Param('sysname') sysname: string) {
        return this.inspectorService.get(sysname);
    }

    @Post()
    async registration(
        @Body('sysname') sysname: string,
        @Body('options') options: Inspector,
    ) {
        const entity = await this.inspectorService.create(sysname, options);
        return entity.options;
    }

    @Put(':sysname')
    async update(
        @Param('sysname') sysname: string,
        @Body('options') options: Inspector,
    ) {
        return this.inspectorService.update(sysname, options);
    }

    @Delete(':sysname')
    async delete(@Param('sysname') sysname: string) {
        return this.inspectorService.delete(sysname);
    }
}
