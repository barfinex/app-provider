import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { register } from 'prom-client';
import { ProviderRuntimeHealthService } from './provider-runtime-health.service';

@ApiTags('Runtime')
@Controller()
export class ProviderRuntimeHealthController {
  constructor(private readonly runtimeHealth: ProviderRuntimeHealthService) {}

  @Get('health/live')
  live() {
    return this.runtimeHealth.getLivenessSnapshot();
  }

  @Get('health/ready')
  async ready() {
    return this.runtimeHealth.getReadinessSnapshot();
  }

  @Get('health')
  async health() {
    return this.runtimeHealth.getHealthSnapshot();
  }

  @Get('metrics')
  @Header('Content-Type', register.contentType)
  async metrics(): Promise<string> {
    return register.metrics();
  }
}
