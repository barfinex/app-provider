import {
  Body,
  Controller,
  Get,
  Param,
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
  ApiParam,
  ApiBody,
  ApiOkResponse,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdvisorProxyService } from './advisor-proxy.service';
import {
  ManualOverrideRequestDto,
  ClearManualOverrideRequestDto,
  StrategySynthesisRequestDto,
} from './advisor-proxy.dto';

/**
 * AdvisorProxy — strategy synthesis + governance.
 */
@ApiTags('AdvisorProxy – Strategies')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('advisor-proxy/advisor/strategies')
export class AdvisorProxyStrategiesController {
  constructor(private readonly svc: AdvisorProxyService) {}

  // ────────────────────── Strategy Synthesis ──────────────────────

  @Post('synthesize')
  @ApiOperation({
    summary: 'Synthesize new strategy',
    description:
      'Triggers LLM-based strategy synthesis. Generates a new trading strategy candidate ' +
      'with DNA, entry/exit rules, and risk parameters.',
  })
  @ApiBody({ type: StrategySynthesisRequestDto })
  async synthesize(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fp('strategies/synthesize', undefined, body, res, req);
  }

  @Get()
  @ApiOperation({
    summary: 'List all strategies',
    description:
      'Returns all strategies with their current state (active, suppressed, archived, experiment).',
  })
  @ApiOkResponse({ description: 'Array of StrategySynthesisCandidate objects' })
  async list(@Req() req: Request, @Res() res: Response) {
    return this.f('strategies', req, res);
  }

  @Get('experiments')
  @ApiOperation({
    summary: 'List experiment candidates',
    description: 'Returns strategies currently in experiment state.',
  })
  async experiments(@Req() req: Request, @Res() res: Response) {
    return this.f('strategies/experiments', req, res);
  }

  @Get('budget')
  @ApiOperation({
    summary: 'Experiment budget',
    description:
      'Returns the current experiment budget: max concurrent experiments, used slots, available slots.',
  })
  async budget(@Req() req: Request, @Res() res: Response) {
    return this.f('strategies/budget', req, res);
  }

  @Get(':strategyId')
  @ApiOperation({
    summary: 'Get strategy by ID',
    description: 'Returns a specific strategy by its ID.',
  })
  @ApiParam({
    name: 'strategyId',
    type: String,
    description: 'Strategy identifier',
  })
  async getById(
    @Param('strategyId') strategyId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.f(`strategies/${strategyId}`, req, res);
  }

  @Post(':strategyId/promote')
  @ApiOperation({
    summary: 'Promote strategy to active',
    description: 'Promotes an experiment strategy to active production state.',
  })
  @ApiParam({ name: 'strategyId', type: String })
  async promote(
    @Param('strategyId') strategyId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.fp(
      `strategies/${strategyId}/promote`,
      undefined,
      undefined,
      res,
      req,
    );
  }

  @Post(':strategyId/suppress')
  @ApiOperation({
    summary: 'Suppress strategy',
    description: 'Suppresses a strategy so it will not be used in decisions.',
  })
  @ApiParam({ name: 'strategyId', type: String })
  async suppress(
    @Param('strategyId') strategyId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.fp(
      `strategies/${strategyId}/suppress`,
      undefined,
      undefined,
      res,
      req,
    );
  }

  @Post(':strategyId/archive')
  @ApiOperation({
    summary: 'Archive strategy',
    description:
      'Archives a strategy. Archived strategies are not used in decisions and are hidden from the default list.',
  })
  @ApiParam({ name: 'strategyId', type: String })
  async archive(
    @Param('strategyId') strategyId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.fp(
      `strategies/${strategyId}/archive`,
      undefined,
      undefined,
      res,
      req,
    );
  }

  // ────────────────────── Strategy Governance ──────────────────────

  @Get('governance')
  @ApiOperation({
    summary: 'Governance snapshot',
    description:
      'Returns governance state for all strategies: weight allocation, manual overrides, auto-governance decisions.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({ name: 'experimentTag', required: false, type: String })
  async governance(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('strategies/governance', query, res, req);
  }

  @Get('governance/effective')
  @ApiOperation({
    summary: 'Effective governance for strategy',
    description:
      'Returns the effective governance state for a specific strategy after all overrides applied.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({ name: 'experimentTag', required: false, type: String })
  @ApiQuery({ name: 'strategyId', required: false, type: String })
  async governanceEffective(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('strategies/governance/effective', query, res, req);
  }

  @Get('governance/history')
  @ApiOperation({
    summary: 'Governance transition history',
    description:
      'Returns the history of governance state transitions for a strategy.',
  })
  @ApiQuery({ name: 'strategyId', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async governanceHistory(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('strategies/governance/history', query, res, req);
  }

  @Post('governance/override')
  @ApiOperation({
    summary: 'Apply manual governance override',
    description:
      'Applies a manual governance override (promote, suppress, archive, restore) to a strategy.',
  })
  @ApiBody({ type: ManualOverrideRequestDto })
  async governanceOverride(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fp('strategies/governance/override', undefined, body, res, req);
  }

  @Post('governance/override/clear')
  @ApiOperation({
    summary: 'Clear manual governance override',
    description:
      'Clears a previously applied manual override, restoring auto-governance for the strategy.',
  })
  @ApiBody({ type: ClearManualOverrideRequestDto })
  async governanceOverrideClear(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fp(
      'strategies/governance/override/clear',
      undefined,
      body,
      res,
      req,
    );
  }

  @Get('active')
  @ApiOperation({
    summary: 'Active strategies',
    description:
      'Returns currently active strategies that participate in decision-making.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({ name: 'experimentTag', required: false, type: String })
  async active(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('strategies/active', query, res, req);
  }

  @Get('suppressed')
  @ApiOperation({
    summary: 'Suppressed strategies',
    description:
      'Returns strategies that have been suppressed (manually or by auto-governance).',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({ name: 'experimentTag', required: false, type: String })
  async suppressed(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('strategies/suppressed', query, res, req);
  }

  @Get('ranking')
  @ApiOperation({
    summary: 'Strategy ranking',
    description:
      'Returns strategies ranked by fitness score (win rate, PnL, sample size weighted).',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({ name: 'experimentTag', required: false, type: String })
  async ranking(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('strategies/ranking', query, res, req);
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

  private async fp(
    endpoint: string,
    query: Record<string, unknown> | undefined,
    body: Record<string, unknown> | undefined,
    res: Response,
    req: Request,
  ) {
    const result = await this.svc.post(
      endpoint,
      body,
      query,
      req.headers as Record<string, unknown>,
    );
    return res.status(result.status).send(result.data);
  }
}
