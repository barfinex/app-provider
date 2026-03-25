import {
  All,
  Controller,
  Get,
  HttpException,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiOkResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { ProxyService } from './proxy.service';
import { ProxyAppType } from './proxy.types';

@ApiTags('Proxy')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller()
export class ProxyController {
  constructor(private readonly proxyService: ProxyService) {}

  @Get('proxy/targets')
  @ApiOperation({
    summary: 'List proxy targets',
    description:
      'Returns registered advisor, inspector, and detector targets (app keys and base URLs).',
  })
  @ApiOkResponse({ description: '{ advisors, inspectors, detectors }' })
  async listTargets() {
    return {
      advisors: await this.proxyService.getTargetsByType('advisor'),
      inspectors: await this.proxyService.getTargetsByType('inspector'),
      detectors: await this.proxyService.getTargetsByType('detector'),
    };
  }

  @All('advisors/:appKey/*')
  @ApiOperation({
    summary: 'Proxy to Advisor by app key',
    description:
      'Forwards request to the Advisor instance identified by appKey. Path after /advisors/:appKey/ is sent to that Advisor. Returns 502 on forward failure.',
  })
  @ApiParam({ name: 'appKey', description: 'Advisor app key from registry' })
  async proxyAdvisor(
    @Param('appKey') appKey: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    return this.handleProxy('advisor', appKey, req, res, query);
  }

  @All('inspectors/:appKey/*')
  @ApiOperation({
    summary: 'Proxy to Inspector by app key',
    description:
      'Forwards request to the Inspector instance identified by appKey. Path after /inspectors/:appKey/ is sent to that Inspector.',
  })
  @ApiParam({ name: 'appKey', description: 'Inspector app key from registry' })
  async proxyInspector(
    @Param('appKey') appKey: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    return this.handleProxy('inspector', appKey, req, res, query);
  }

  @All('detectors/:appKey/*')
  @ApiOperation({
    summary: 'Proxy to Detector by app key',
    description:
      'Forwards request to the Detector instance identified by appKey. Path after /detectors/:appKey/ is sent to that Detector.',
  })
  @ApiParam({ name: 'appKey', description: 'Detector app key from registry' })
  async proxyDetector(
    @Param('appKey') appKey: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: Record<string, unknown>,
  ) {
    return this.handleProxy('detector', appKey, req, res, query);
  }

  private async handleProxy(
    type: ProxyAppType,
    appKey: string,
    req: Request,
    res: Response,
    query: Record<string, unknown>,
  ) {
    try {
      const wildcardPath = (req.params?.[0] as string | undefined) ?? '';
      const subPath =
        wildcardPath || this.extractSubPath(req.path || req.url, type, appKey);
      const result = await this.proxyService.forward({
        type,
        appKey,
        method: req.method,
        path: subPath,
        query,
        body: req.body,
        headers: req.headers as Record<string, unknown>,
      });
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) {
          if (v !== undefined) res.setHeader(k, v as string | string[]);
        }
      }
      return res.status(result.status).send(result.data);
    } catch (error) {
      throw new HttpException(
        {
          ok: false,
          type,
          appKey,
          error:
            error instanceof Error ? error.message : 'Proxy forwarding failed',
        },
        502,
      );
    }
  }

  private extractSubPath(
    reqPath: string,
    type: ProxyAppType,
    appKey: string,
  ): string {
    const clean = reqPath.replace(/^\/api\//, '/');
    const prefix = `/${this.getRoot(type)}/${appKey}/`;
    if (!clean.startsWith(prefix)) {
      return '';
    }
    return clean.slice(prefix.length);
  }

  private getRoot(type: ProxyAppType): string {
    switch (type) {
      case 'advisor':
        return 'advisors';
      case 'inspector':
        return 'inspectors';
      case 'detector':
        return 'detectors';
      default:
        return type;
    }
  }
}
