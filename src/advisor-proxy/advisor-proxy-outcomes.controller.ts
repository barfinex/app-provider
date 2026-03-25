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
 * AdvisorProxy — decision outcomes, quality, performance.
 */
@ApiTags('AdvisorProxy – Outcomes')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('advisor-proxy/advisor')
export class AdvisorProxyOutcomesController {
  constructor(private readonly svc: AdvisorProxyService) {}

  // ────────────────────── Decision Outcomes ──────────────────────

  @Get('outcomes/summary')
  @ApiOperation({
    summary: 'Outcome summary',
    description:
      'Returns win rate, loss rate, average PnL, total decision count.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    type: String,
    description: 'Filter by symbol',
  })
  @ApiOkResponse({
    description: '{ winRate, lossRate, avgPnl, decisionCount }',
  })
  async outcomesSummary(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('outcomes/summary', query, res, req);
  }

  @Get('outcomes/calibration')
  @ApiOperation({
    summary: 'Outcome calibration buckets',
    description:
      'Returns calibration buckets: for each confidence range, the actual win rate, average PnL, and sample size.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiOkResponse({
    description:
      '{ buckets: [{ confidence_range, win_rate, avg_pnl, decision_count }] }',
  })
  async outcomesCalibration(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('outcomes/calibration', query, res, req);
  }

  @Get('outcomes/recent')
  @ApiOperation({
    summary: 'Recent outcomes',
    description: 'Returns recent decision outcomes ordered by time.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async outcomesRecent(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('outcomes/recent', query, res, req);
  }

  @Get('outcomes/history')
  @ApiOperation({
    summary: 'Outcome history',
    description: 'Returns full outcome history for analysis.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async outcomesHistory(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('outcomes/history', query, res, req);
  }

  @Get('outcomes/metrics')
  @ApiOperation({
    summary: 'Outcome Prometheus metrics',
    description: 'Returns Prometheus-formatted outcome metrics.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  async outcomesMetrics(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('outcomes/metrics', query, res, req);
  }

  @Get('outcomes/health')
  @ApiOperation({
    summary: 'Outcome health',
    description:
      'Returns outcome processing health: pending candidates, evaluated/failed counts in last hour.',
  })
  @ApiOkResponse({
    description:
      '{ nowTs, windowMs, pendingCandidates, evaluatedLastHour, failedLastHour }',
  })
  async outcomesHealth(@Req() req: Request, @Res() res: Response) {
    return this.f('outcomes/health', req, res);
  }

  @Get('outcomes/quality')
  @ApiOperation({
    summary: 'Decision quality',
    description:
      'Returns decision quality metrics: wins, losses, precision, hourly trend.',
  })
  @ApiOkResponse({
    description:
      '{ wins, losses, precision, trend: [{ hour, wins, losses, precision }] }',
  })
  async outcomesQuality(@Req() req: Request, @Res() res: Response) {
    return this.f('outcomes/quality', req, res);
  }

  @Get('outcomes/gate-accuracy')
  @ApiOperation({
    summary: 'Risk gate accuracy',
    description:
      'Returns accuracy of the risk gate: how many blocked trades would have been wins vs losses.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiOkResponse({
    description: '{ blockedTotal, blockedWins, blockedLosses, gateAccuracy }',
  })
  async outcomesGateAccuracy(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('outcomes/gate-accuracy', query, res, req);
  }

  @Get('outcomes/evaluations')
  @ApiOperation({
    summary: 'Decision evaluations',
    description:
      'Returns detailed per-decision evaluations with multi-dimensional quality scores ' +
      '(signal, timing, risk, regime fit, execution, outcome).',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({
    name: 'strategyId',
    required: false,
    type: String,
    description: 'Filter by strategy',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async outcomesEvaluations(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('outcomes/evaluations', query, res, req);
  }

  @Get('outcomes/strategies/stats')
  @ApiOperation({
    summary: 'Strategy quality stats',
    description:
      'Returns per-strategy quality statistics: win rate, sample size, avg PnL, confidence.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({ name: 'strategyId', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async outcomesStrategiesStats(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('outcomes/strategies/stats', query, res, req);
  }

  @Get('outcomes/strategies/experiments')
  @ApiOperation({
    summary: 'Strategy experiments',
    description: 'Returns active strategy experiments and their state.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({ name: 'experimentTag', required: false, type: String })
  async outcomesStrategiesExperiments(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('outcomes/strategies/experiments', query, res, req);
  }

  @Get('outcomes/strategies/catalog')
  @ApiOperation({
    summary: 'Strategy catalog',
    description:
      'Returns a catalog of all strategies with their current state and quality metrics.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({ name: 'experimentTag', required: false, type: String })
  async outcomesStrategiesCatalog(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('outcomes/strategies/catalog', query, res, req);
  }

  // ────────────────────── Performance ──────────────────────

  @Get('performance/strategies')
  @ApiOperation({
    summary: 'Strategy performance stats',
    description:
      'Returns per-strategy performance: PnL, trade count, win rate, Sharpe-like metrics.',
  })
  @ApiQuery({
    name: 'windowSize',
    required: false,
    type: String,
    description: 'Window for stats calculation',
  })
  async performanceStrategies(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('performance/strategies', query, res, req);
  }

  @Get('performance/strategy/:id')
  @ApiOperation({
    summary: 'Single strategy performance',
    description: 'Returns performance details for a specific strategy by ID.',
  })
  async performanceStrategyById(@Req() req: Request, @Res() res: Response) {
    const id = (req.params as Record<string, string>).id;
    return this.f(`performance/strategy/${id}`, req, res);
  }

  @Get('performance/summary')
  @ApiOperation({
    summary: 'Performance summary',
    description: 'Returns aggregate performance summary across all strategies.',
  })
  async performanceSummary(@Req() req: Request, @Res() res: Response) {
    return this.f('performance/summary', req, res);
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
