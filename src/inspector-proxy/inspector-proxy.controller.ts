import { All, Body, Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { InspectorProxyService } from './inspector-proxy.service';

@ApiTags('InspectorProxy')
@Controller('inspector-proxy')
export class InspectorProxyController {
  constructor(private readonly inspectorProxyService: InspectorProxyService) {}

  @Get('health')
  async health(@Req() req: Request, @Res() res: Response) {
    const result = await this.inspectorProxyService.get(
      'health',
      undefined,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).json({
      inspectorReachable: result.status === 200,
    });
  }

  @All('inspector/*')
  async proxyInspectorEndpoint(
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
}
