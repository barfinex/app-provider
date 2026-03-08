import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { DetectorProxyController } from './detector-proxy.controller';
import { DetectorProxyService } from './detector-proxy.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 5000,
      maxRedirects: 3,
    }),
  ],
  controllers: [DetectorProxyController],
  providers: [DetectorProxyService],
  exports: [DetectorProxyService],
})
export class DetectorProxyModule {}
