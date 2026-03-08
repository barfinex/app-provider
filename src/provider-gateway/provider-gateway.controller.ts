import { All, Body, Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdvisorProxyService } from '../advisor-proxy/advisor-proxy.service';
import { DetectorProxyService } from '../detector-proxy/detector-proxy.service';
import { InspectorProxyService } from '../inspector-proxy/inspector-proxy.service';

@ApiTags('ProviderGateway')
@Controller('provider')
export class ProviderGatewayController {
  constructor(
    private readonly detectorProxyService: DetectorProxyService,
    private readonly inspectorProxyService: InspectorProxyService,
    private readonly advisorProxyService: AdvisorProxyService,
  ) {}

  @All('detector/*')
  async proxyDetector(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown>,
  ) {
    const wildcardPath = (req.params?.[0] as string | undefined) || '';
    const endpoint = wildcardPath.replace(/^\/+/, '');
    const method = String(req.method || 'GET').toUpperCase();
    const result = await this.detectorProxyService.request(
      method,
      endpoint,
      query,
      body,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  @All('inspector/*')
  async proxyInspector(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown>,
  ) {
    const wildcardPath = (req.params?.[0] as string | undefined) || '';
    const endpoint = wildcardPath.replace(/^\/+/, '');
    const method = String(req.method || 'GET').toUpperCase();
    const result = await this.inspectorProxyService.request(
      method,
      endpoint,
      query,
      body,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  @Get('system/health')
  async getSystemHealth() {
    const [detector, inspector, advisor] = await Promise.all([
      this.detectorProxyService.get('health').catch(() => ({ status: 503, data: null })),
      this.inspectorProxyService.get('health').catch(() => ({ status: 503, data: null })),
      this.advisorProxyService
        .get('market-state/health')
        .catch(() => ({ status: 503, data: null })),
    ]);

    const services = {
      detector: detector.status >= 200 && detector.status < 300 ? 'ok' : 'down',
      inspector: inspector.status >= 200 && inspector.status < 300 ? 'ok' : 'down',
      advisor: advisor.status >= 200 && advisor.status < 300 ? 'ok' : 'down',
      provider: 'ok',
    };
    const status = Object.values(services).every((value) => value === 'ok')
      ? 'ok'
      : 'degraded';

    return {
      status,
      services,
    };
  }
}
