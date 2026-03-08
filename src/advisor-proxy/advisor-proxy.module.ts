import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AdvisorProxyController } from './advisor-proxy.controller';
import { AdvisorProxyService } from './advisor-proxy.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 5000,
      maxRedirects: 3,
    }),
  ],
  controllers: [AdvisorProxyController],
  providers: [AdvisorProxyService],
  exports: [AdvisorProxyService],
})
export class AdvisorProxyModule {}
