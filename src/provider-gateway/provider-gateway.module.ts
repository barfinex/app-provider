import { Module } from '@nestjs/common';
import { AdvisorProxyModule } from '../advisor-proxy/advisor-proxy.module';
import { DetectorProxyModule } from '../detector-proxy/detector-proxy.module';
import { InspectorProxyModule } from '../inspector-proxy/inspector-proxy.module';
import { ProviderGatewayController } from './provider-gateway.controller';

@Module({
  imports: [AdvisorProxyModule, DetectorProxyModule, InspectorProxyModule],
  controllers: [ProviderGatewayController],
})
export class ProviderGatewayModule {}
