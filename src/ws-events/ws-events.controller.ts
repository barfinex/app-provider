import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { WsEventsCatalogService } from './ws-events.catalog.service';

@ApiTags('WebSocket')
@Controller('ws/events')
export class WsEventsController {
  constructor(private readonly catalog: WsEventsCatalogService) {}

  @Get('catalog')
  @ApiOperation({
    summary: 'WebSocket events catalog',
    description:
      'Returns the catalog of WebSocket event types and channels available from this Provider. Used by clients to discover subscribable events.',
  })
  @ApiOkResponse({ description: 'Events catalog (event types, channels)' })
  getCatalog() {
    return this.catalog.getCatalog();
  }
}
