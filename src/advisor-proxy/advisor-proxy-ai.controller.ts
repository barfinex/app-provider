import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiSecurity,
  ApiQuery,
  ApiOkResponse,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdvisorProxyService } from './advisor-proxy.service';

/**
 * AdvisorProxy — AI usage tracking and profitability analysis.
 */
@ApiTags('AdvisorProxy – AI Usage')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('advisor-proxy/advisor/ai')
export class AdvisorProxyAiController {
  constructor(private readonly svc: AdvisorProxyService) {}

  // ────────────────────── Usage ──────────────────────

  @Get('usage')
  @ApiOperation({
    summary: 'AI usage summary',
    description:
      'Returns aggregated AI usage: total tokens, cost, request count, average latency, error rate. ' +
      'Supports time-range filtering.',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description: 'Start ISO timestamp',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description: 'End ISO timestamp',
  })
  @ApiQuery({
    name: 'windowHours',
    required: false,
    type: Number,
    description: 'Lookback window in hours (alternative to from/to)',
  })
  @ApiOkResponse({
    description:
      'AIUsageSummary: { totalTokens, totalCost, totalRequests, avgLatencyMs, errorRate }',
  })
  async usage(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('ai/usage', query, res, req);
  }

  @Get('usage/models')
  @ApiOperation({
    summary: 'AI usage by model',
    description:
      'Returns per-model breakdown of AI usage (tokens, cost, requests).',
  })
  @ApiOkResponse({ description: 'Array of AIUsageByModel objects' })
  async usageModels(@Req() req: Request, @Res() res: Response) {
    return this.f('ai/usage/models', req, res);
  }

  @Get('usage/daily')
  @ApiOperation({
    summary: 'Daily AI usage aggregates',
    description: 'Returns daily aggregated AI usage rows.',
  })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: 'Number of days (alternative to from/to)',
  })
  @ApiOkResponse({ description: 'Array of AIUsageDailyRow objects' })
  async usageDaily(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('ai/usage/daily', query, res, req);
  }

  @Get('usage/latency')
  @ApiOperation({
    summary: 'AI latency distribution',
    description: 'Returns latency distribution buckets for AI requests.',
  })
  @ApiOkResponse({ description: 'Array of AIUsageLatencyBucket objects' })
  async usageLatency(@Req() req: Request, @Res() res: Response) {
    return this.f('ai/usage/latency', req, res);
  }

  @Get('usage/errors')
  @ApiOperation({
    summary: 'AI error samples',
    description: 'Returns recent AI request error samples for debugging.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max error samples (default 20)',
  })
  @ApiOkResponse({ description: 'Array of AIUsageErrorSample objects' })
  async usageErrors(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('ai/usage/errors', query, res, req);
  }

  @Get('usage/events')
  @ApiOperation({
    summary: 'Raw AI usage events (debug)',
    description:
      'Returns raw AI usage events for debugging. Not intended for production dashboards.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async usageEvents(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('ai/usage/events', query, res, req);
  }

  // ────────────────────── Profitability ──────────────────────

  @Get('profitability/decisions')
  @ApiOperation({
    summary: 'AI cost per decision',
    description: 'Returns AI cost aggregated per trading decision.',
  })
  @ApiOkResponse({ description: 'Array of AICostPerDecision objects' })
  async profitabilityDecisions(@Req() req: Request, @Res() res: Response) {
    return this.f('ai/profitability/decisions', req, res);
  }

  @Get('profitability/decisions/roi')
  @ApiOperation({
    summary: 'Decision-level ROI',
    description: 'Returns ROI analysis: AI cost vs trade PnL per decision.',
  })
  @ApiOkResponse({ description: 'Array of AIDecisionProfitability objects' })
  async profitabilityDecisionsRoi(@Req() req: Request, @Res() res: Response) {
    return this.f('ai/profitability/decisions/roi', req, res);
  }

  @Get('profitability/strategies')
  @ApiOperation({
    summary: 'AI cost per strategy',
    description: 'Returns AI cost breakdown by strategy.',
  })
  @ApiOkResponse({ description: 'Array of AICostPerStrategy objects' })
  async profitabilityStrategies(@Req() req: Request, @Res() res: Response) {
    return this.f('ai/profitability/strategies', req, res);
  }

  @Get('profitability/symbols')
  @ApiOperation({
    summary: 'AI cost per symbol',
    description: 'Returns AI cost breakdown by trading symbol.',
  })
  @ApiOkResponse({ description: 'Array of AICostPerSymbol objects' })
  async profitabilitySymbols(@Req() req: Request, @Res() res: Response) {
    return this.f('ai/profitability/symbols', req, res);
  }

  @Get('profitability/roi')
  @ApiOperation({
    summary: 'Overall AI ROI summary',
    description:
      'Returns overall AI ROI: total AI spend, total PnL, ROI ratio, break-even analysis.',
  })
  @ApiOkResponse({ description: 'AIProfitabilityRoiSummary object' })
  async profitabilityRoi(@Req() req: Request, @Res() res: Response) {
    return this.f('ai/profitability/roi', req, res);
  }

  // ──────────────── helpers ────────────────

  private async f(endpoint: string, req: Request, res: Response) {
    const result = await this.svc.get(
      endpoint,
      undefined,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }

  private async fq(
    endpoint: string,
    query: Record<string, unknown>,
    res: Response,
    req: Request,
  ) {
    const result = await this.svc.get(
      endpoint,
      query,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }
}
