import { Module } from '@nestjs/common';
import { WsEventsController } from './ws-events.controller';
import { WsEventsCatalogService } from './ws-events.catalog.service';

@Module({
  controllers: [WsEventsController],
  providers: [WsEventsCatalogService],
  exports: [WsEventsCatalogService],
})
export class WsEventsModule {}
