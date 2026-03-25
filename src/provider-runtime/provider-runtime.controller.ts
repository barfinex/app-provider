import { Controller, Get, Req, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdvisorRuntimeProxyService } from './advisor-runtime-proxy.service';

@ApiTags('AdvisorProxy')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('provider/advisor')
export class ProviderRuntimeController {
  constructor(
    private readonly advisorRuntimeProxyService: AdvisorRuntimeProxyService,
  ) {}

  @Get('status')
  @ApiOperation({
    summary: 'Proxy Advisor runtime status',
    description:
      'This endpoint forwards the request to the Advisor service. Returns Advisor runtime status. ' +
      'Used for monitoring advisor runtime, debugging decision pipeline, and inspecting system health. Provider acts as gateway.',
  })
  @ApiOkResponse({ description: 'Advisor runtime snapshot' })
  async getAdvisorStatus(@Req() req: Request, @Res() res: Response) {
    const result = await this.advisorRuntimeProxyService.getStatus(
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  @Get('graph')
  @ApiOperation({
    summary: 'Proxy Advisor genome graph',
    description:
      'Forwards to Advisor service. Returns evolution/genome graph snapshot. Provider acts as gateway.',
  })
  @ApiOkResponse({ description: 'Evolution graph snapshot' })
  async getAdvisorGraph(@Req() req: Request, @Res() res: Response) {
    const result = await this.advisorRuntimeProxyService.getGraph(
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }
}
