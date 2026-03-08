import { All, Body, Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { createHash } from 'crypto';
import { DetectorProxyService } from './detector-proxy.service';

@ApiTags('DetectorProxy')
@Controller('detector-proxy')
export class DetectorProxyController {
  private readonly logger = new Logger(DetectorProxyController.name);
  private readonly allowedRiskReadEndpoints = new Set([
    'risk/health',
    'risk/status',
    'risk/limits',
  ]);

  constructor(private readonly detectorProxyService: DetectorProxyService) {}

  @Get('health')
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

  @All('detector/*')
  async proxyDetectorEndpoint(
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

  @All('risk/*')
  async proxyRiskEndpoint(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown>,
  ) {
    const wildcardPath = (req.params?.[0] as string | undefined) || '';
    const endpoint = `risk/${wildcardPath.replace(/^\/+/, '')}`.replace(/\/+$/, '');
    const method = String(req.method || 'GET').toUpperCase();
    if (!this.isAllowedRiskProxy(method, endpoint)) {
      this.logDeniedRiskMutation(req, endpoint, method);
      return res.status(403).json({
        error: 'risk endpoint mutation not allowed via proxy',
      });
    }
    const result = await this.detectorProxyService.request(
      method,
      endpoint,
      query,
      body,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  @All('metrics')
  async proxyMetricsRoot(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown>,
  ) {
    return this.proxyMetrics('metrics', req, res, query, body);
  }

  @All('metrics/*')
  async proxyMetricsWithPath(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown>,
  ) {
    const wildcardPath = (req.params?.[0] as string | undefined) || '';
    const endpoint = `metrics/${wildcardPath.replace(/^\/+/, '')}`;
    return this.proxyMetrics(endpoint, req, res, query, body);
  }

  private async proxyMetrics(
    endpoint: string,
    req: Request,
    res: Response,
    query: Record<string, unknown>,
    body: Record<string, unknown>,
  ) {
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

  private isAllowedRiskProxy(method: string, endpoint: string): boolean {
    if (method !== 'GET') {
      return false;
    }
    return this.allowedRiskReadEndpoints.has(endpoint.toLowerCase());
  }

  private logDeniedRiskMutation(req: Request, endpoint: string, method: string): void {
    const tokenHash = this.extractTokenHash(req.headers as Record<string, unknown>);
    this.logger.warn(
      `[risk-proxy-denied] method=${method} path=${endpoint} ip=${this.resolveIp(req)} tokenHash=${tokenHash ?? 'n/a'}`,
    );
  }

  private extractTokenHash(headers: Record<string, unknown>): string | undefined {
    const auth = headers.authorization;
    const bearer = Array.isArray(auth) ? auth[0] : auth;
    const bearerToken = typeof bearer === 'string'
      ? bearer.replace(/^Bearer\s+/i, '').trim()
      : '';
    const apiTokenRaw = headers['x-api-token'];
    const apiToken = Array.isArray(apiTokenRaw) ? String(apiTokenRaw[0] ?? '') : String(apiTokenRaw ?? '');
    const token = bearerToken || apiToken.trim();
    if (!token) {
      return undefined;
    }
    return createHash('sha256').update(token).digest('hex');
  }

  private resolveIp(req: Request): string {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim().length > 0) {
      return xff.split(',')[0].trim();
    }
    if (Array.isArray(xff) && xff.length > 0 && String(xff[0]).trim().length > 0) {
      return String(xff[0]).split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }
}
