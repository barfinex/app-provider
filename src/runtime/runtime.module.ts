import { Global, Module } from '@nestjs/common';
import { ProviderMetricsService } from './provider-metrics.service';
import { ProviderBootstrapService } from './provider-bootstrap.service';

@Global()
@Module({
  providers: [ProviderMetricsService, ProviderBootstrapService],
  exports: [ProviderMetricsService, ProviderBootstrapService],
})
export class RuntimeModule {}
