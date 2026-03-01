import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';
import { AppRegistryModule } from '../app-registry/app-registry.module';

@Module({
  imports: [
    AppRegistryModule,
    HttpModule.register({
      timeout: Number(process.env.PROVIDER_PROXY_TIMEOUT_MS || 15000),
      maxRedirects: 3,
    }),
  ],
  controllers: [ProxyController],
  providers: [ProxyService],
  exports: [ProxyService],
})
export class ProxyModule {}
