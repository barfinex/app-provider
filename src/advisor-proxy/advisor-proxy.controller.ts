import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
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
 * AdvisorProxy — health, status, context, debug, runtime diagnostics.
 *
 * Every route is explicitly declared so that the Provider OpenAPI spec
 * exposes full meta-information to Studio and MCP consumers.
 */
@ApiTags('AdvisorProxy')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('advisor-proxy')
export class AdvisorProxyController {
  constructor(private readonly svc: AdvisorProxyService) {}

  // ────────────────────── Health / Status ──────────────────────

  @Get('health')
  @ApiOperation({
    summary: 'Advisor reachability check',
    description:
      'Probes the Advisor service. Returns { advisorReachable: true } if Advisor responds with 200.',
  })
  @ApiOkResponse({ description: '{ advisorReachable: boolean }' })
  async health(@Req() req: Request, @Res() res: Response) {
    const result = await this.svc.get(
      'market-state/health',
      undefined,
      this.h(req),
    );
    return res
      .status(result.status)
      .json({ advisorReachable: result.status === 200 });
  }

  @Get('advisor/health')
  @ApiOperation({
    summary: 'Advisor health overview',
    description:
      'Returns health snapshot: market-state symbol count, throttle state, decision cache size, ' +
      'telemetry table name, last decision timestamp, execution mode.',
  })
  @ApiOkResponse({ description: 'AdvisorHealthResponse object' })
  async advisorHealth(@Req() req: Request, @Res() res: Response) {
    return this.forward('health', req, res);
  }

  @Get('advisor/status')
  @ApiOperation({
    summary: 'Comprehensive advisor status',
    description:
      'Returns detailed status including health, context freshness, decision pipeline state.',
  })
  async advisorStatus(@Req() req: Request, @Res() res: Response) {
    return this.forward('status', req, res);
  }

  // ────────────────────── Context ──────────────────────

  @Get('advisor/context')
  @ApiOperation({
    summary: 'Market context for symbol',
    description:
      'Returns assembled market context used for LLM decision: candles, trades, orderbook, indicators.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    type: String,
    description: 'Trading pair symbol (e.g. BTCUSDT)',
  })
  @ApiQuery({
    name: 'refresh',
    required: false,
    type: Boolean,
    description: 'Force-refresh the context',
  })
  @ApiQuery({
    name: 'timeframeMs',
    required: false,
    type: Number,
    description: 'Lookback window in milliseconds',
  })
  async context(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('context', query, res, req);
  }

  @Post('advisor/context/refresh')
  @ApiOperation({
    summary: 'Force-refresh context for symbol',
    description:
      'Triggers context rebuild for the given symbol. Returns refreshed context.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    type: String,
    description: 'Trading pair symbol',
  })
  async contextRefresh(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardPost('context/refresh', query, undefined, res, req);
  }

  // ────────────────────── Data Quality ──────────────────────

  @Get('advisor/data-quality/readiness')
  @ApiOperation({
    summary: 'Decision readiness status',
    description:
      'Returns per-symbol readiness assessment: data maturity, quality issues, block reasons. ' +
      'Used by Studio to show whether the Advisor can make decisions.',
  })
  @ApiQuery({
    name: 'timeframeMs',
    required: false,
    type: Number,
    description: 'Lookback window in ms',
  })
  async dataQualityReadiness(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('data-quality/readiness', query, res, req);
  }

  @Get('advisor/market-quality')
  @ApiOperation({
    summary: 'Validate symbol market quality',
    description:
      'Checks whether the market for a given symbol has sufficient quality for trading decisions.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    type: String,
    description: 'Trading pair symbol',
  })
  async marketQuality(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('market-quality', query, res, req);
  }

  // ────────────────────── Debug ──────────────────────

  @Get('advisor/debug/market-context')
  @ApiOperation({
    summary: 'Debug market context',
    description:
      'Returns raw market context payload before LLM prompt assembly. For debugging only.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({ name: 'refresh', required: false, type: Boolean })
  @ApiQuery({ name: 'timeframeMs', required: false, type: Number })
  async debugMarketContext(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('debug/market-context', query, res, req);
  }

  @Get('advisor/debug/context')
  @ApiOperation({
    summary: 'Debug context details',
    description:
      'Returns detailed context internals (indicators, data-quality checks, freshness).',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({ name: 'refresh', required: false, type: Boolean })
  @ApiQuery({ name: 'timeframeMs', required: false, type: Number })
  async debugContext(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('debug/context', query, res, req);
  }

  @Get('advisor/debug/decision-snapshot')
  @ApiOperation({
    summary: 'Debug latest decision snapshot',
    description:
      'Returns the latest raw decision snapshot for the given symbol.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  async debugDecisionSnapshot(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('debug/decision-snapshot', query, res, req);
  }

  // ────────────────────── Decisions ──────────────────────

  @Get('advisor/decisions/recent')
  @ApiOperation({
    summary: 'Recent advisor decisions',
    description:
      'Returns a list of recent LLM decisions with confidence, direction, targets, and outcome.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    type: String,
    description: 'Filter by symbol',
  })
  @ApiQuery({
    name: 'timeframe',
    required: false,
    type: String,
    description: 'Time window filter',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max results (default 50)',
  })
  async decisionsRecent(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('decisions/recent', query, res, req);
  }

  @Post('advisor/decision/run')
  @ApiOperation({
    summary: 'Trigger a decision for symbol',
    description:
      'Manually triggers the Advisor decision pipeline for a symbol. Returns the decision result.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    type: String,
    description: 'Trading pair symbol',
  })
  async decisionRun(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardPost('decision/run', query, undefined, res, req);
  }

  // ────────────────────── Portfolio ──────────────────────

  @Get('advisor/portfolio/diagnostics')
  @ApiOperation({
    summary: 'Portfolio diagnostics',
    description:
      'Returns portfolio-level diagnostics: open positions, risk exposure, allocation.',
  })
  async portfolioDiagnostics(@Req() req: Request, @Res() res: Response) {
    return this.forward('portfolio/diagnostics', req, res);
  }

  // ────────────────────── Telemetry ──────────────────────

  @Get('advisor/telemetry')
  @ApiOperation({
    summary: 'Advisor telemetry',
    description:
      'Returns raw telemetry events (decision cycles, timing, errors).',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max entries (default 100)',
  })
  async telemetry(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('telemetry', query, res, req);
  }

  // ────────────────────── Runtime ──────────────────────

  @Get('advisor/runtime/locks')
  @ApiOperation({
    summary: 'Instrument locks',
    description:
      'Returns currently held symbol locks in the decision pipeline.',
  })
  async runtimeLocks(@Req() req: Request, @Res() res: Response) {
    return this.forward('runtime/locks', req, res);
  }

  @Get('advisor/runtime/signals/open')
  @ApiOperation({
    summary: 'Open signals',
    description:
      'Returns signals that are currently open (pending or partially filled).',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async runtimeSignalsOpen(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('runtime/signals/open', query, res, req);
  }

  @Get('advisor/runtime/setup/history')
  @ApiOperation({
    summary: 'Setup history',
    description: 'Returns historical setup snapshots for a symbol.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async runtimeSetupHistory(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('runtime/setup/history', query, res, req);
  }

  @Get('advisor/runtime/status')
  @ApiOperation({
    summary: 'Runtime status snapshot',
    description:
      'Returns runtime status: current regime, genome graph summary, evolution state, strategy counts.',
  })
  @ApiOkResponse({
    description:
      'Runtime status with regime, genomeGraph, evolution, strategies counts',
  })
  async runtimeStatus(@Req() req: Request, @Res() res: Response) {
    return this.forward('runtime/status', req, res);
  }

  @Get('advisor/runtime/graph')
  @ApiOperation({
    summary: 'Genome graph snapshot',
    description:
      'Returns the full genome graph: strategy families, branches, fitness data. ' +
      'Used for visualizing strategy evolution in Studio.',
  })
  @ApiOkResponse({
    description: 'Nested graph with families → branches → strategies → fitness',
  })
  async runtimeGraph(@Req() req: Request, @Res() res: Response) {
    return this.forward('runtime/graph', req, res);
  }

  // ────────────────────── Prompt ──────────────────────

  @Get('advisor/prompt/active')
  @ApiOperation({
    summary: 'Active prompt policy',
    description:
      'Returns the currently active LLM prompt policy (system prompt, parameters, constraints).',
  })
  async promptActive(@Req() req: Request, @Res() res: Response) {
    return this.forward('prompt/active', req, res);
  }

  @Get('advisor/prompt/history')
  @ApiOperation({
    summary: 'Prompt policy history',
    description: 'Returns the history of prompt policy changes.',
  })
  async promptHistory(@Req() req: Request, @Res() res: Response) {
    return this.forward('prompt/history', req, res);
  }

  // ────────────────────── Analytics ──────────────────────

  @Get('analytics/summary')
  @ApiOperation({
    summary: 'Advisor analytics summary',
    description:
      'Returns analytics summary: win/loss rates, PnL, decision counts. ' +
      'Cached for 2 seconds at Provider level.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    type: String,
    description: 'Filter by symbol',
  })
  async analyticsSummary(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('analytics/summary', query, res, req);
  }

  @Get('analytics/recent')
  @ApiOperation({
    summary: 'Recent analytics / battles',
    description:
      'Returns recent analytics entries. Cached for 2 seconds at Provider level.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max results',
  })
  async analyticsRecent(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('analytics/recent', query, res, req);
  }

  @Get('advisor/analytics/metrics')
  @ApiOperation({
    summary: 'Analytics Prometheus metrics',
    description: 'Returns Prometheus-formatted analytics metrics.',
  })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  async analyticsMetrics(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('analytics/metrics', query, res, req);
  }

  // ────────────────────── Telemetry (decisions) ──────────────────────

  @Get('telemetry/decisions')
  @ApiOperation({
    summary: 'Decision telemetry',
    description:
      'Returns decision-cycle telemetry events for debugging the decision pipeline.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async telemetryDecisions(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('telemetry/decisions', query, res, req);
  }

  // ────────────────────── Conviction ──────────────────────

  @Get('conviction/last')
  @ApiOperation({
    summary: 'Last conviction snapshot',
    description:
      'Returns the last conviction scoring breakdown: signal strength, regime fit, timing, risk assessment. ' +
      'Cached for 1 second at Provider level.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    type: String,
    description: 'Filter by symbol',
  })
  async convictionLast(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('conviction/last', query, res, req);
  }

  // ────────────────────── Market State ──────────────────────

  @Get('market-state/health')
  @ApiOperation({
    summary: 'Market-state health',
    description:
      'Returns market-state health: data freshness, subscription status, symbol coverage. ' +
      'Cached for 1 second at Provider level.',
  })
  @ApiQuery({
    name: 'timeframeMs',
    required: false,
    type: Number,
    description: 'Lookback window in ms',
  })
  async marketStateHealth(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('market-state/health', query, res, req);
  }

  @Get('advisor/market-state/metrics')
  @ApiOperation({
    summary: 'Market-state Prometheus metrics',
    description: 'Returns Prometheus-formatted market-state metrics.',
  })
  @ApiQuery({ name: 'timeframeMs', required: false, type: Number })
  async marketStateMetrics(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.forwardQuery('market-state/metrics', query, res, req);
  }

  // ────────────────────── Throttle ──────────────────────

  @Get('throttle/state')
  @ApiOperation({
    summary: 'Throttle state snapshot',
    description:
      'Returns per-symbol throttle state: last decision timestamp, input hash, cooldown.',
  })
  async throttleState(@Req() req: Request, @Res() res: Response) {
    return this.forward('throttle/state', req, res);
  }

  @Get('advisor/throttle/metrics')
  @ApiOperation({
    summary: 'Throttle Prometheus metrics',
    description: 'Returns Prometheus-formatted throttle metrics.',
  })
  async throttleMetrics(@Req() req: Request, @Res() res: Response) {
    return this.forward('throttle/metrics', req, res);
  }

  // ────────────────────── Decision consistency ──────────────────────

  @Get('decision/cache')
  @ApiOperation({
    summary: 'Decision cache (fingerprints)',
    description:
      'Returns cached decision fingerprints used for deduplication. ' +
      'Cached for 5 seconds at Provider level.',
  })
  async decisionCache(@Req() req: Request, @Res() res: Response) {
    return this.forward('decision/cache', req, res);
  }

  @Get('advisor/decision/metrics')
  @ApiOperation({
    summary: 'Decision consistency Prometheus metrics',
    description: 'Returns Prometheus-formatted decision consistency metrics.',
  })
  async decisionMetrics(@Req() req: Request, @Res() res: Response) {
    return this.forward('decision/metrics', req, res);
  }

  // ────────────────────── Calibration ──────────────────────

  @Get('advisor/calibration/map')
  @ApiOperation({
    summary: 'Calibration map snapshot',
    description:
      'Returns the full calibration map: confidence buckets, win rates, sample sizes per symbol.',
  })
  async calibrationMap(@Req() req: Request, @Res() res: Response) {
    return this.forward('calibration/map', req, res);
  }

  @Get('advisor/calibration/last')
  @ApiOperation({
    summary: 'Last calibration snapshot',
    description:
      'Returns summary of last calibration: updatedAt, bucketCount, symbolCount, usedTotal, fallbackTotal.',
  })
  async calibrationLast(@Req() req: Request, @Res() res: Response) {
    return this.forward('calibration/last', req, res);
  }

  @Get('advisor/calibration/metrics')
  @ApiOperation({
    summary: 'Calibration Prometheus metrics',
    description: 'Returns Prometheus-formatted calibration metrics.',
  })
  async calibrationMetrics(@Req() req: Request, @Res() res: Response) {
    return this.forward('calibration/metrics', req, res);
  }

  // ────────────────────── Autonomous agent health ──────────────────────

  @Get('advisor-agent/autonomous/health')
  @ApiOperation({
    summary: 'Autonomous agent runtime health',
    description: 'Returns autonomous signal-agent runtime health snapshot.',
  })
  async autonomousHealth(@Req() req: Request, @Res() res: Response) {
    return this.forwardRaw('advisor-agent/autonomous/health', req, res);
  }

  // ────────────────────── Orchestrator ──────────────────────

  @Post('advisor-agent/orchestrator/run-once')
  @ApiOperation({
    summary: 'Trigger one orchestrator decision cycle',
    description:
      'Manually triggers a single Advisor orchestrator run. ' +
      'Returns orchestrator state, metrics, and pipeline results.',
  })
  @ApiOkResponse({
    description: '{ ok: boolean, state, orchestrator, timestamp }',
  })
  async orchestratorRunOnce(@Req() req: Request, @Res() res: Response) {
    return this.forwardRawPost('advisor-agent/orchestrator/run-once', req, res);
  }

  // ──────────────── helpers ────────────────

  // ────────────────────── Intelligence Snapshots ──────────────────────

  @Get('advisor/intelligence/snapshots')
  @ApiOperation({
    summary: 'All market intelligence snapshots',
    description:
      'Returns the latest structured market snapshots with scores for all active symbols. ' +
      'Used by Studio intelligence dashboard for priority sorting and overview.',
  })
  @ApiOkResponse({
    description:
      '{ symbols: Record<string, StructuredMarketSnapshot>, count: number, timestamp: number }',
  })
  async intelligenceSnapshots(@Req() req: Request, @Res() res: Response) {
    return this.forwardRaw('advisor-agent/intelligence/snapshots', req, res);
  }

  @Get('advisor/intelligence/snapshot')
  @ApiOperation({
    summary: 'Market intelligence snapshot for one symbol',
    description:
      'Returns the latest structured market snapshot with scores for a specific symbol.',
  })
  @ApiQuery({ name: 'symbol', required: true, type: String })
  @ApiOkResponse({
    description:
      '{ symbol: string, structured: StructuredMarketSnapshot, timestamp: number }',
  })
  async intelligenceSnapshot(
    @Query() query: { symbol: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const result = await this.svc.requestRaw(
      'GET',
      `advisor-agent/intelligence/snapshot`,
      query,
      undefined,
      this.h(req),
    );
    return res.status(result.status).send(result.data);
  }

  private h(req: Request): Record<string, unknown> {
    return req.headers as Record<string, unknown>;
  }

  /** GET with no query params → advisor/{endpoint} */
  private async forward(endpoint: string, req: Request, res: Response) {
    const result = await this.svc.get(endpoint, undefined, this.h(req));
    return res.status(result.status).send(result.data);
  }

  /** GET with query params → advisor/{endpoint} */
  private async forwardQuery(
    endpoint: string,
    query: Record<string, unknown>,
    res: Response,
    req: Request,
  ) {
    const result = await this.svc.get(endpoint, query, this.h(req));
    return res.status(result.status).send(result.data);
  }

  /** POST with optional query + body → advisor/{endpoint} */
  private async forwardPost(
    endpoint: string,
    query: Record<string, unknown> | undefined,
    body: Record<string, unknown> | undefined,
    res: Response,
    req: Request,
  ) {
    const result = await this.svc.post(endpoint, body, query, this.h(req));
    return res.status(result.status).send(result.data);
  }

  /** Forward to a raw path (no advisor/ prefix) */
  private async forwardRaw(rawPath: string, req: Request, res: Response) {
    const result = await this.svc.requestRaw(
      'GET',
      rawPath,
      undefined,
      undefined,
      this.h(req),
    );
    return res.status(result.status).send(result.data);
  }

  /** POST to a raw path (no advisor/ prefix) */
  private async forwardRawPost(rawPath: string, req: Request, res: Response) {
    const result = await this.svc.requestRaw(
      'POST',
      rawPath,
      undefined,
      undefined,
      this.h(req),
    );
    return res.status(result.status).send(result.data);
  }
}
