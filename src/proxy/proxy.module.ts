import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { AppRegistryModule } from '../app-registry/app-registry.module';
import { ConnectorModule } from '../connector/connector.module';
import { ProviderAdvisorsController } from './provider-advisors.controller';

@Module({
  imports: [
    AppRegistryModule,
    forwardRef(() => ConnectorModule),
    HttpModule.register({
      timeout: Number(process.env.PROVIDER_PROXY_TIMEOUT_MS || 15000),
      maxRedirects: 3,
    }),
  ],
  controllers: [ProxyController, ProviderAdvisorsController],
  providers: [ProxyService],
  exports: [ProxyService],
})
export class ProxyModule {}
