import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { WsEventsCatalogService } from './ws-events.catalog.service';

@ApiTags('WebSocket')
@Controller('ws/events')
export class WsEventsController {
  constructor(private readonly catalog: WsEventsCatalogService) {}

  @Get('catalog')
  getCatalog() {
    return this.catalog.getCatalog();
  }
}
