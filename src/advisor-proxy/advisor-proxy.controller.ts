import { All, Body, Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdvisorProxyService } from './advisor-proxy.service';

@ApiTags('AdvisorProxy')
@Controller('advisor-proxy')
export class AdvisorProxyController {
  constructor(private readonly advisorProxyService: AdvisorProxyService) {}

  @Get('analytics/summary')
  async analyticsSummary(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.respondProxy('analytics/summary', query, res, req.headers);
  }

  @Get('analytics/recent')
  async analyticsRecent(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.respondProxy('analytics/recent', query, res, req.headers);
  }

  @Get('telemetry/decisions')
  async telemetryDecisions(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.respondProxy('telemetry/decisions', query, res, req.headers);
  }

  @Get('conviction/last')
  async convictionLast(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.respondProxy('conviction/last', query, res, req.headers);
  }

  @Get('market-state/health')
  async marketStateHealth(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.respondProxy('market-state/health', query, res, req.headers);
  }

  @Get('throttle/state')
  async throttleState(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.respondProxy('throttle/state', query, res, req.headers);
  }

  @Get('decision/cache')
  async decisionCache(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.respondProxy('decision/cache', query, res, req.headers);
  }

  @Get('health')
  async health(@Req() req: Request, @Res() res: Response) {
    const result = await this.advisorProxyService.get(
      'market-state/health',
      undefined,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).json({
      advisorReachable: result.status === 200,
    });
  }

  @All('advisor/*')
  async proxyAdvisorEndpoint(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown>,
  ) {
    const wildcardPath = (req.params?.[0] as string | undefined) || '';
    const endpoint = wildcardPath.replace(/^\/+/, '');
    const method = String(req.method || 'GET').toUpperCase();
    const result = await this.advisorProxyService.request(
      method,
      endpoint,
      query,
      body,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  private async respondProxy(
    endpoint: string,
    query: Record<string, unknown>,
    res: Response,
    headers?: Request['headers'],
  ) {
    const result = await this.advisorProxyService.get(
      endpoint,
      query,
      headers as Record<string, unknown> | undefined,
    );
    return res.status(result.status).send(result.data);
  }
}
