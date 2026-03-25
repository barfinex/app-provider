// src/inspector/inspector.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiOkResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';

import { InspectorService } from './inspector.service';
import { Inspector } from '@barfinex/types';

@ApiTags('Inspectors')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('inspectors')
export class InspectorController {
  constructor(private readonly inspectorService: InspectorService) {}

  @Get()
  @ApiOperation({
    summary: 'List all inspectors',
    description: 'Returns all inspectors registered with this Provider.',
  })
  @ApiOkResponse({ description: 'Array of Inspector list items' })
  async getAll() {
    return this.inspectorService.getAll();
  }

  @Get(':sysname')
  @ApiOperation({
    summary: 'Get inspector by sysname',
    description: 'Returns a single inspector by system name.',
  })
  @ApiParam({ name: 'sysname', description: 'Inspector system name' })
  @ApiOkResponse({ description: 'Inspector object' })
  async get(@Param('sysname') sysname: string) {
    return this.inspectorService.get(sysname);
  }

  @Post()
  @ApiOperation({
    summary: 'Create inspector',
    description:
      'Registers a new inspector. Body: sysname, options (Inspector).',
  })
  @ApiBody({ description: 'sysname (string), options (Inspector config)' })
  @ApiOkResponse({ description: 'Created inspector options' })
  async registration(
    @Body('sysname') sysname: string,
    @Body('options') options: Inspector,
  ) {
    const entity = await this.inspectorService.create(sysname, options);
    return entity.options;
  }

  @Put(':sysname')
  @ApiOperation({
    summary: 'Update inspector',
    description:
      'Updates inspector config by sysname. Body: options (Inspector).',
  })
  @ApiParam({ name: 'sysname', description: 'Inspector system name' })
  @ApiBody({ description: 'options (Inspector config)' })
  @ApiOkResponse({ description: 'Updated inspector' })
  async update(
    @Param('sysname') sysname: string,
    @Body('options') options: Inspector,
  ) {
    return this.inspectorService.update(sysname, options);
  }

  @Delete(':sysname')
  @ApiOperation({
    summary: 'Delete inspector',
    description: 'Deletes inspector by sysname.',
  })
  @ApiParam({ name: 'sysname', description: 'Inspector system name' })
  @ApiOkResponse({ description: 'Delete result' })
  async delete(@Param('sysname') sysname: string) {
    return this.inspectorService.delete(sysname);
  }
}
