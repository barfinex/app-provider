import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AdvisorProxyController } from './advisor-proxy.controller';
import { AdvisorProxyOutcomesController } from './advisor-proxy-outcomes.controller';
import { AdvisorProxyStrategiesController } from './advisor-proxy-strategies.controller';
import { AdvisorProxyAiController } from './advisor-proxy-ai.controller';
import { AdvisorProxyMiscController } from './advisor-proxy-misc.controller';
import { AdvisorProxyService } from './advisor-proxy.service';

@Module({
  imports: [
    HttpModule.register({
      timeout: 5000,
      maxRedirects: 3,
    }),
  ],
  controllers: [
    AdvisorProxyController,
    AdvisorProxyOutcomesController,
    AdvisorProxyStrategiesController,
    AdvisorProxyAiController,
    AdvisorProxyMiscController,
  ],
  providers: [AdvisorProxyService],
  exports: [AdvisorProxyService],
})
export class AdvisorProxyModule {}
