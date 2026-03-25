import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { register } from 'prom-client';
import { ProviderRuntimeHealthService } from './provider-runtime-health.service';
import { ProviderBootstrapService } from './provider-bootstrap.service';

@ApiTags('Runtime')
@Controller()
export class ProviderRuntimeHealthController {
  constructor(
    private readonly runtimeHealth: ProviderRuntimeHealthService,
    private readonly bootstrap: ProviderBootstrapService,
  ) {}

  @Get('health/live')
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Kubernetes-style liveness. No auth. Returns simple snapshot; use for readiness to receive traffic.',
  })
  @ApiOkResponse({ description: 'Liveness snapshot' })
  live() {
    return this.runtimeHealth.getLivenessSnapshot();
  }

  @Get('health/ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Kubernetes-style readiness. No auth. Returns snapshot plus ready/status; indicates if Provider has completed bootstrap (Redis, QuestDB, Connector).',
  })
  @ApiOkResponse({ description: 'Readiness snapshot with ready and status' })
  async ready() {
    const snapshot = await this.runtimeHealth.getReadinessSnapshot();
    const bootstrapReady = this.bootstrap.isReady();
    return {
      ...snapshot,
      ready: bootstrapReady,
      status: bootstrapReady ? 'ready' : 'not_ready',
    };
  }

  @Get('health/runtime')
  @ApiOperation({
    summary: 'Runtime bootstrap state',
    description:
      'No auth. Returns bootstrap state (e.g. HTTP started, modules initialized).',
  })
  @ApiOkResponse({ description: 'Bootstrap state' })
  runtime() {
    return this.bootstrap.getState();
  }

  @Get('health')
  @ApiOperation({
    summary: 'Health snapshot',
    description:
      'No auth. Returns combined health snapshot for the Provider process.',
  })
  @ApiOkResponse({ description: 'Health snapshot' })
  async health() {
    return this.runtimeHealth.getHealthSnapshot();
  }

  @Get('metrics')
  @ApiOperation({
    summary: 'Prometheus metrics',
    description:
      'No auth. Returns Prometheus text format metrics (content-type from prom-client).',
  })
  @Header('Content-Type', register.contentType)
  @ApiOkResponse({ description: 'Prometheus exposition format' })
  async metrics(): Promise<string> {
    return register.metrics();
  }

  @Get('provider/runtime/ws')
  @ApiOperation({
    summary: 'WebSocket endpoint info',
    description:
      'No auth. Returns the WebSocket (Socket.IO) endpoint URL for this Provider. Clients should connect to this URL (path /ws).',
  })
  @ApiOkResponse({ description: 'WebSocket availability and endpoint URL' })
  wsEndpoint() {
    const port = Number(process.env.PROVIDER_API_PORT || 8081);
    const scheme = process.env.SSL_CERT ? 'wss' : 'ws';
    const endpoint = `${scheme}://localhost:${port}/ws`;
    return {
      websocket: 'available',
      endpoint,
      path: '/ws',
    };
  }
}
