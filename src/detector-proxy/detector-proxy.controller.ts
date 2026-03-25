import {
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiSecurity,
  ApiQuery,
  ApiBody,
  ApiOkResponse,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { createHash } from 'crypto';
import { DetectorProxyService } from './detector-proxy.service';
import { ClosePositionRequestDto } from '../advisor-proxy/advisor-proxy.dto';

/**
 * DetectorProxy — explicit routes for all Detector endpoints.
 *
 * Every route is declared with full OpenAPI metadata so that
 * the Provider Swagger spec exposes detector capabilities to Studio and MCP.
 */
@ApiTags('DetectorProxy')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('detector-proxy')
export class DetectorProxyController {
  private readonly logger = new Logger(DetectorProxyController.name);
  private readonly allowedRiskReadEndpoints = new Set([
    'risk/health',
    'risk/status',
    'risk/limits',
  ]);

  constructor(private readonly detectorProxyService: DetectorProxyService) {}

  // ────────────────────── Health ──────────────────────

  @Get('health')
  @ApiOperation({
    summary: 'Detector reachability check',
    description:
      'Probes the Detector service. Returns { detectorReachable: true } if Detector responds with 200.',
  })
  @ApiOkResponse({ description: '{ detectorReachable: boolean }' })
  async health(@Req() req: Request, @Res() res: Response) {
    const result = await this.detectorProxyService.get(
      'health',
      undefined,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).json({
      detectorReachable: result.status === 200,
    });
  }

  // ────────────────────── Risk ──────────────────────

  @Post('risk/close-position')
  @ApiOperation({
    summary: 'Close a position via Detector risk module',
    description:
      'Sends a close-position command to the Detector risk module. ' +
      'Requires symbol, connectorType, marketType, and reason. ' +
      'Side and quantity are optional (defaults to closing the full position). ' +
      'Returns 403 if Detector is in DETECTOR_READONLY mode.',
  })
  @ApiBody({ type: ClosePositionRequestDto })
  @ApiOkResponse({
    description:
      '{ success, message?, orderId?, symbol?, side?, closedQuantity? }',
  })
  async riskClosePosition(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const result = await this.detectorProxyService.request(
      'POST',
      'risk/close-position',
      undefined,
      body,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  @Get('risk/health')
  @ApiOperation({
    summary: 'Detector risk health (read-only)',
    description:
      'Returns risk module health status. Read-only access via proxy.',
  })
  async riskHealth(@Req() req: Request, @Res() res: Response) {
    const result = await this.detectorProxyService.request(
      'GET',
      'risk/health',
      undefined,
      undefined,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  @Get('risk/status')
  @ApiOperation({
    summary: 'Detector risk status (read-only)',
    description:
      'Returns current risk module status. Read-only access via proxy.',
  })
  async riskStatus(@Req() req: Request, @Res() res: Response) {
    const result = await this.detectorProxyService.request(
      'GET',
      'risk/status',
      undefined,
      undefined,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  @Get('risk/limits')
  @ApiOperation({
    summary: 'Detector risk limits (read-only)',
    description: 'Returns configured risk limits. Read-only access via proxy.',
  })
  async riskLimits(@Req() req: Request, @Res() res: Response) {
    const result = await this.detectorProxyService.request(
      'GET',
      'risk/limits',
      undefined,
      undefined,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  // ────────────────────── Metrics ──────────────────────

  @Get('metrics')
  @ApiOperation({
    summary: 'Detector Prometheus metrics',
    description:
      'Returns Prometheus-formatted metrics from the Detector service ' +
      '(event-bus latency, ingress backpressure).',
  })
  @ApiOkResponse({ description: 'Prometheus text/plain metrics' })
  async metricsRoot(@Req() req: Request, @Res() res: Response) {
    const result = await this.detectorProxyService.request(
      'GET',
      'metrics',
      undefined,
      undefined,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  @Get('metrics/prometheus')
  @ApiOperation({
    summary: 'Detector Prometheus metrics (legacy path)',
    description:
      'Legacy path for Prometheus metrics. Returns identical data to GET /metrics.',
  })
  async metricsPrometheus(@Req() req: Request, @Res() res: Response) {
    const result = await this.detectorProxyService.request(
      'GET',
      'metrics/prometheus',
      undefined,
      undefined,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  // ────────────────────── Detector runtime (via wildcard prefix) ──────────────────────
  // The Detector app currently has minimal HTTP surface.
  // These endpoints cover the detector/ prefix used by detector instance configs.

  @Get('detector/health')
  @ApiOperation({
    summary: 'Detector runtime health',
    description:
      'Returns Detector runtime health status (under detector/ prefix).',
  })
  async detectorHealth(@Req() req: Request, @Res() res: Response) {
    return this.forwardDetector(
      'GET',
      'health',
      undefined,
      undefined,
      req,
      res,
    );
  }

  @Get('detector/status')
  @ApiOperation({
    summary: 'Detector runtime status',
    description: 'Returns Detector runtime status snapshot.',
  })
  async detectorStatus(@Req() req: Request, @Res() res: Response) {
    return this.forwardDetector(
      'GET',
      'status',
      undefined,
      undefined,
      req,
      res,
    );
  }

  @Get('detector/config')
  @ApiOperation({
    summary: 'Detector runtime config',
    description: 'Returns current Detector runtime configuration.',
  })
  async detectorConfig(@Req() req: Request, @Res() res: Response) {
    return this.forwardDetector(
      'GET',
      'config',
      undefined,
      undefined,
      req,
      res,
    );
  }

  // ──────────────── helpers ────────────────

  private async forwardDetector(
    method: string,
    endpoint: string,
    query: Record<string, unknown> | undefined,
    body: Record<string, unknown> | undefined,
    req: Request,
    res: Response,
  ) {
    const result = await this.detectorProxyService.request(
      method,
      endpoint,
      query,
      body,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }
}
