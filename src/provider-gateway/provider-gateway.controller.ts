import {
  All,
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiOkResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdvisorProxyService } from '../advisor-proxy/advisor-proxy.service';
import { DetectorProxyService } from '../detector-proxy/detector-proxy.service';
import { InspectorProxyService } from '../inspector-proxy/inspector-proxy.service';

@ApiTags('ProviderGateway')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('provider')
export class ProviderGatewayController {
  private readonly logger = new Logger(ProviderGatewayController.name);

  constructor(
    private readonly detectorProxyService: DetectorProxyService,
    private readonly inspectorProxyService: InspectorProxyService,
    private readonly advisorProxyService: AdvisorProxyService,
  ) {}

  @Post('strategies/synthesize')
  @ApiOperation({
    summary: 'Proxy Advisor strategies synthesize',
    description:
      'Forwards to Advisor service: POST strategies/synthesize. Used for strategy synthesis. Provider acts as gateway. Request body and query are forwarded to Advisor.',
  })
  @ApiBody({ description: 'Strategy synthesis payload (forwarded to Advisor)' })
  @ApiOkResponse({
    description: 'Advisor response (status and body forwarded)',
  })
  async synthesizeStrategy(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
  ) {
    return this.proxyAdvisorStrategiesPost(
      'strategies/synthesize',
      body,
      query,
      req,
      res,
    );
  }

  @Post('synthesis')
  @ApiOperation({
    summary: 'Legacy synthesis endpoint (deprecated)',
    description:
      'Deprecated. Use POST /provider/strategies/synthesize. Forwards to Advisor strategies/synthesize. Sets Deprecation and Sunset headers.',
  })
  @ApiBody({ description: 'Strategy synthesis payload' })
  @ApiOkResponse({ description: 'Advisor response' })
  async synthesizeStrategyLegacy(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
  ) {
    this.ensureLegacyCompatibilityEnabled();
    this.applyLegacyDeprecationHeaders(
      res,
      'POST /provider/strategies/synthesize',
    );
    return this.proxyAdvisorStrategiesPost(
      'strategies/synthesize',
      body,
      query,
      req,
      res,
    );
  }

  @Post('strategies/:strategyId/promote')
  @ApiOperation({
    summary: 'Promote strategy',
    description:
      'Forwards to Advisor: POST strategies/:strategyId/promote. Promotes a strategy. Provider acts as gateway.',
  })
  @ApiParam({ name: 'strategyId', description: 'Strategy ID' })
  @ApiBody({ description: 'Optional body (forwarded to Advisor)' })
  @ApiOkResponse({ description: 'Advisor response' })
  async promoteStrategy(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
  ) {
    const strategyId = String(req.params?.strategyId || '').trim();
    return this.proxyAdvisorStrategiesPost(
      `strategies/${strategyId}/promote`,
      body,
      query,
      req,
      res,
    );
  }

  @Post('synthesis/:strategyId/promote')
  @ApiOperation({
    summary: 'Legacy promote (deprecated)',
    description:
      'Deprecated. Use POST /provider/strategies/:strategyId/promote. Forwards to Advisor.',
  })
  @ApiParam({ name: 'strategyId', description: 'Strategy ID' })
  @ApiBody({ description: 'Optional body' })
  @ApiOkResponse({ description: 'Advisor response' })
  async promoteStrategyLegacy(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
  ) {
    this.ensureLegacyCompatibilityEnabled();
    const strategyId = String(req.params?.strategyId || '').trim();
    this.applyLegacyDeprecationHeaders(
      res,
      `POST /provider/strategies/${strategyId}/promote`,
    );
    return this.proxyAdvisorStrategiesPost(
      `strategies/${strategyId}/promote`,
      body,
      query,
      req,
      res,
    );
  }

  @Post('strategies/:strategyId/suppress')
  @ApiOperation({
    summary: 'Suppress strategy',
    description:
      'Forwards to Advisor: POST strategies/:strategyId/suppress. Suppresses a strategy. Provider acts as gateway.',
  })
  @ApiParam({ name: 'strategyId', description: 'Strategy ID' })
  @ApiBody({ description: 'Optional body (forwarded to Advisor)' })
  @ApiOkResponse({ description: 'Advisor response' })
  async suppressStrategy(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
  ) {
    const strategyId = String(req.params?.strategyId || '').trim();
    return this.proxyAdvisorStrategiesPost(
      `strategies/${strategyId}/suppress`,
      body,
      query,
      req,
      res,
    );
  }

  @Post('synthesis/:strategyId/suppress')
  @ApiOperation({
    summary: 'Legacy suppress (deprecated)',
    description:
      'Deprecated. Use POST /provider/strategies/:strategyId/suppress. Forwards to Advisor.',
  })
  @ApiParam({ name: 'strategyId', description: 'Strategy ID' })
  @ApiBody({ description: 'Optional body' })
  @ApiOkResponse({ description: 'Advisor response' })
  async suppressStrategyLegacy(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
  ) {
    this.ensureLegacyCompatibilityEnabled();
    const strategyId = String(req.params?.strategyId || '').trim();
    this.applyLegacyDeprecationHeaders(
      res,
      `POST /provider/strategies/${strategyId}/suppress`,
    );
    return this.proxyAdvisorStrategiesPost(
      `strategies/${strategyId}/suppress`,
      body,
      query,
      req,
      res,
    );
  }

  @Post('strategies/:strategyId/archive')
  @ApiOperation({
    summary: 'Archive strategy',
    description:
      'Forwards to Advisor: POST strategies/:strategyId/archive. Archives a strategy. Provider acts as gateway.',
  })
  @ApiParam({ name: 'strategyId', description: 'Strategy ID' })
  @ApiBody({ description: 'Optional body (forwarded to Advisor)' })
  @ApiOkResponse({ description: 'Advisor response' })
  async archiveStrategy(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
  ) {
    const strategyId = String(req.params?.strategyId || '').trim();
    return this.proxyAdvisorStrategiesPost(
      `strategies/${strategyId}/archive`,
      body,
      query,
      req,
      res,
    );
  }

  @Post('synthesis/:strategyId/archive')
  @ApiOperation({
    summary: 'Legacy archive (deprecated)',
    description:
      'Deprecated. Use POST /provider/strategies/:strategyId/archive. Forwards to Advisor.',
  })
  @ApiParam({ name: 'strategyId', description: 'Strategy ID' })
  @ApiBody({ description: 'Optional body' })
  @ApiOkResponse({ description: 'Advisor response' })
  async archiveStrategyLegacy(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>,
  ) {
    this.ensureLegacyCompatibilityEnabled();
    const strategyId = String(req.params?.strategyId || '').trim();
    this.applyLegacyDeprecationHeaders(
      res,
      `POST /provider/strategies/${strategyId}/archive`,
    );
    return this.proxyAdvisorStrategiesPost(
      `strategies/${strategyId}/archive`,
      body,
      query,
      req,
      res,
    );
  }

  @Get('strategies')
  @ApiOperation({
    summary: 'Proxy list strategies',
    description:
      'Forwards to Advisor service: GET strategies. Returns list of strategies. Provider acts as gateway.',
  })
  async listStrategies(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    return this.proxyAdvisorStrategiesGet('strategies', query, req, res);
  }

  @Get('synthesis')
  @ApiOperation({
    summary: 'Legacy list strategies (deprecated)',
    description:
      'Deprecated. Use GET /provider/strategies. Forwards to Advisor. Returns list of strategies.',
  })
  @ApiOkResponse({ description: 'Advisor response (strategies list)' })
  async listStrategiesLegacy(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    this.ensureLegacyCompatibilityEnabled();
    this.applyLegacyDeprecationHeaders(res, 'GET /provider/strategies');
    return this.proxyAdvisorStrategiesGet('strategies', query, req, res);
  }

  @Get('strategies/experiments')
  @ApiOperation({
    summary: 'List experiment strategies',
    description:
      'Forwards to Advisor: GET strategies/experiments. Returns list of experiment strategies. Provider acts as gateway.',
  })
  @ApiOkResponse({ description: 'Advisor response (experiments list)' })
  async listExperimentStrategies(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    return this.proxyAdvisorStrategiesGet(
      'strategies/experiments',
      query,
      req,
      res,
    );
  }

  @Get('synthesis/experiments')
  @ApiOperation({
    summary: 'Legacy list experiments (deprecated)',
    description:
      'Deprecated. Use GET /provider/strategies/experiments. Forwards to Advisor.',
  })
  @ApiOkResponse({ description: 'Advisor response' })
  async listExperimentStrategiesLegacy(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    this.ensureLegacyCompatibilityEnabled();
    this.applyLegacyDeprecationHeaders(
      res,
      'GET /provider/strategies/experiments',
    );
    return this.proxyAdvisorStrategiesGet(
      'strategies/experiments',
      query,
      req,
      res,
    );
  }

  @Get('strategies/budget')
  @ApiOperation({
    summary: 'Get strategies budget',
    description:
      'Forwards to Advisor: GET strategies/budget. Returns budget info for strategies. Provider acts as gateway.',
  })
  @ApiOkResponse({ description: 'Advisor response (budget)' })
  async strategyBudget(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    return this.proxyAdvisorStrategiesGet('strategies/budget', query, req, res);
  }

  @Get('synthesis/budget')
  @ApiOperation({
    summary: 'Legacy strategy budget (deprecated)',
    description:
      'Deprecated. Use GET /provider/strategies/budget. Forwards to Advisor.',
  })
  @ApiOkResponse({ description: 'Advisor response' })
  async strategyBudgetLegacy(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    this.ensureLegacyCompatibilityEnabled();
    this.applyLegacyDeprecationHeaders(res, 'GET /provider/strategies/budget');
    return this.proxyAdvisorStrategiesGet('strategies/budget', query, req, res);
  }

  @Get('strategies/:strategyId')
  @ApiOperation({
    summary: 'Proxy get strategy by ID',
    description:
      'Forwards to Advisor: GET strategies/:strategyId. Provider acts as gateway.',
  })
  @ApiParam({ name: 'strategyId', description: 'Strategy ID' })
  async getStrategy(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    const strategyId = String(req.params?.strategyId || '').trim();
    return this.proxyAdvisorStrategiesGet(
      `strategies/${strategyId}`,
      query,
      req,
      res,
    );
  }

  @Get('synthesis/:strategyId')
  @ApiOperation({
    summary: 'Legacy get strategy by ID (deprecated)',
    description:
      'Deprecated. Use GET /provider/strategies/:strategyId. Forwards to Advisor.',
  })
  @ApiParam({ name: 'strategyId', description: 'Strategy ID' })
  @ApiOkResponse({ description: 'Advisor response (strategy)' })
  async getStrategyLegacy(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    this.ensureLegacyCompatibilityEnabled();
    const strategyId = String(req.params?.strategyId || '').trim();
    this.applyLegacyDeprecationHeaders(
      res,
      `GET /provider/strategies/${strategyId}`,
    );
    return this.proxyAdvisorStrategiesGet(
      `strategies/${strategyId}`,
      query,
      req,
      res,
    );
  }

  @All('detector/*')
  @ApiOperation({
    summary: 'Proxy Detector (gateway)',
    description:
      'Forwards request to Detector service. Path after /provider/detector/ is sent to Detector. Any HTTP method and path. Provider acts as gateway. Query and body forwarded.',
  })
  @ApiOkResponse({
    description: 'Detector response (status and body forwarded)',
  })
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
  @ApiOperation({
    summary: 'Proxy Inspector (gateway)',
    description:
      'Forwards request to Inspector service. Path after /provider/inspector/ is sent to Inspector. Any HTTP method and path. Provider acts as gateway. Query and body forwarded.',
  })
  @ApiOkResponse({
    description: 'Inspector response (status and body forwarded)',
  })
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
  @ApiOperation({
    summary: 'Aggregated system health',
    description:
      'Probes Detector, Inspector, and Advisor services. Returns status (ok | degraded) and per-service status. ' +
      'Used for monitoring the Barfinex stack behind the Provider.',
  })
  @ApiOkResponse({
    description:
      '{ status, services: { detector, inspector, advisor, provider } }',
  })
  async getSystemHealth() {
    const [detector, inspector, advisor] = await Promise.all([
      this.detectorProxyService
        .get('health')
        .catch(() => ({ status: 503, data: null })),
      this.inspectorProxyService
        .get('health')
        .catch(() => ({ status: 503, data: null })),
      this.advisorProxyService
        .get('market-state/health')
        .catch(() => ({ status: 503, data: null })),
    ]);

    const services = {
      detector: detector.status >= 200 && detector.status < 300 ? 'ok' : 'down',
      inspector:
        inspector.status >= 200 && inspector.status < 300 ? 'ok' : 'down',
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

  private async proxyAdvisorStrategiesGet(
    endpoint: string,
    query: Record<string, unknown>,
    req: Request,
    res: Response,
  ) {
    const result = await this.advisorProxyService.get(
      endpoint,
      query,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  private async proxyAdvisorStrategiesPost(
    endpoint: string,
    body: Record<string, unknown>,
    query: Record<string, unknown>,
    req: Request,
    res: Response,
  ) {
    const result = await this.advisorProxyService.post(
      endpoint,
      body,
      query,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  private ensureLegacyCompatibilityEnabled(): void {
    const enabled = String(
      process.env
        .ADVISOR_STRATEGY_CONTROL_PLANE_ENABLE_LEGACY_SYNTHESIS_COMPATIBILITY ??
        'true',
    )
      .trim()
      .toLowerCase();
    if (!['1', 'true', 'yes', 'on'].includes(enabled)) {
      throw new NotFoundException(
        'Legacy strategy synthesis compatibility mode is disabled',
      );
    }
  }

  private applyLegacyDeprecationHeaders(
    res: Response,
    replacement: string,
  ): void {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT');
    res.setHeader('Link', `</api${replacement}>; rel="successor-version"`);
    res.setHeader('X-Barfinex-Deprecated-Endpoint', replacement);
    this.logger.warn(
      `[strategy_legacy_endpoint_used] endpoint=provider/synthesis replacement="${replacement}"`,
    );
  }
}
