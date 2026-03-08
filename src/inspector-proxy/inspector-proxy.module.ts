import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { InspectorProxyController } from './inspector-proxy.controller';
import { InspectorProxyService } from './inspector-proxy.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 5000,
      maxRedirects: 3,
    }),
  ],
  controllers: [InspectorProxyController],
  providers: [InspectorProxyService],
  exports: [InspectorProxyService],
})
export class InspectorProxyModule {}
