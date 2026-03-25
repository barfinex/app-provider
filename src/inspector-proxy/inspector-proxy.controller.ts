import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
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
import { InspectorProxyService } from './inspector-proxy.service';
import {
  InspectorOptionsDto,
  SystemStanddownDto,
} from '../advisor-proxy/advisor-proxy.dto';

/**
 * InspectorProxy — explicit routes for ALL Inspector endpoints.
 *
 * Every route is declared with full OpenAPI metadata so that
 * the Provider Swagger spec exposes inspector capabilities to Studio and MCP.
 */
@ApiTags('InspectorProxy')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('inspector-proxy')
export class InspectorProxyController {
  constructor(private readonly svc: InspectorProxyService) {}

  // ────────────────────── Health ──────────────────────

  @Get('health')
  @ApiOperation({
    summary: 'Inspector reachability check',
    description:
      'Probes the Inspector service. Returns { inspectorReachable: true } if Inspector responds with 200.',
  })
  @ApiOkResponse({ description: '{ inspectorReachable: boolean }' })
  async health(@Req() req: Request, @Res() res: Response) {
    const result = await this.svc.get('health', undefined, this.h(req));
    return res
      .status(result.status)
      .json({ inspectorReachable: result.status === 200 });
  }

  @Get('inspector/health')
  @ApiOperation({
    summary: 'Inspector health status',
    description:
      'Returns health snapshot: ok, ready, degraded flags, startup reasons, ' +
      'connector count, timestamp.',
  })
  @ApiOkResponse({
    description:
      '{ ok, ready, degraded, startupReasons, hasOptions, connectors, timestamp }',
  })
  async inspectorHealth(@Req() req: Request, @Res() res: Response) {
    return this.f('health', req, res);
  }

  @Get('inspector/health/nodes')
  @ApiOperation({
    summary: 'Health node states',
    description:
      'Returns per-node health: each node has state (OK | BLOCKED | DEGRADED) and reason.',
  })
  @ApiOkResponse({ description: '{ nodes: [{ node, state, reason }] }' })
  async inspectorHealthNodes(@Req() req: Request, @Res() res: Response) {
    return this.f('health/nodes', req, res);
  }

  // ────────────────────── Options / Config ──────────────────────

  @Get('inspector/options')
  @ApiOperation({
    summary: 'Get Inspector options',
    description: 'Returns current Inspector configuration options.',
  })
  async inspectorOptions(@Req() req: Request, @Res() res: Response) {
    return this.f('options', req, res);
  }

  @Put('inspector/options')
  @ApiOperation({
    summary: 'Update Inspector options',
    description: 'Updates Inspector configuration options.',
  })
  @ApiBody({ type: InspectorOptionsDto })
  async inspectorOptionsUpdate(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fm('PUT', 'options', undefined, body, req, res);
  }

  @Get('inspector/config/runtime')
  @ApiOperation({
    summary: 'Runtime config snapshot',
    description: 'Returns the current runtime configuration snapshot.',
  })
  async configRuntime(@Req() req: Request, @Res() res: Response) {
    return this.f('config/runtime', req, res);
  }

  // ────────────────────── Events / Audit ──────────────────────

  @Get('inspector/events')
  @ApiOperation({
    summary: 'Recent audit events',
    description:
      'Returns recent audit log entries from the Inspector event store.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max entries (default 200)',
  })
  async events(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('events', query, res, req);
  }

  @Get('inspector/events/:traceId')
  @ApiOperation({
    summary: 'Events by trace ID',
    description:
      'Returns all audit events for a specific trace ID. Used for end-to-end request tracing.',
  })
  @ApiParam({ name: 'traceId', type: String, description: 'Trace identifier' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max entries (default 500)',
  })
  @ApiOkResponse({ description: '{ traceId, count, data: [...events] }' })
  async eventsByTraceId(
    @Param('traceId') traceId: string,
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq(`events/${traceId}`, query, res, req);
  }

  // ────────────────────── Risk Dashboard ──────────────────────

  @Get('inspector/risk/dashboard')
  @ApiOperation({
    summary: 'Risk dashboard',
    description:
      'Returns the risk dashboard data: positions, exposure, limits, governor state.',
  })
  async riskDashboard(@Req() req: Request, @Res() res: Response) {
    return this.f('risk/dashboard', req, res);
  }

  @Get('inspector/risk/kpi')
  @ApiOperation({
    summary: 'Risk KPI snapshot',
    description:
      'Returns daily risk KPIs: equity, drawdown, PnL, win/loss count, ' +
      'consecutive losses, stress mode flag.',
  })
  @ApiOkResponse({
    description:
      '{ day, dayStartEquityUsd, currentEquityUsd, equityPeakUsd, maxDrawdownPct, ' +
      'dailyPnlPct, closedTrades, wins, losses, consecutiveLosses, stressModeActive }',
  })
  async riskKpi(@Req() req: Request, @Res() res: Response) {
    return this.f('risk/kpi', req, res);
  }

  @Get('inspector/risk/runtime-positions')
  @ApiOperation({
    summary: 'Runtime positions',
    description:
      'Returns all tracked runtime positions with risk metadata: ' +
      'stop distance, risk budget, trailing state, breakeven status.',
  })
  @ApiOkResponse({ description: '{ count, data: PositionRuntimeState[] }' })
  async riskRuntimePositions(@Req() req: Request, @Res() res: Response) {
    return this.f('risk/runtime-positions', req, res);
  }

  @Get('inspector/risk/prices')
  @ApiOperation({
    summary: 'Latest prices',
    description: 'Returns the latest price snapshot used by the risk engine.',
  })
  async riskPrices(@Req() req: Request, @Res() res: Response) {
    return this.f('risk/prices', req, res);
  }

  @Get('inspector/risk/liquidity')
  @ApiOperation({
    summary: 'Latest liquidity',
    description:
      'Returns liquidity snapshot per symbol: bid/ask, spread, depth, imbalance.',
  })
  @ApiOkResponse({
    description:
      'Map of symbol → { symbol, connectorType, marketType, bestBid, bestAsk, spreadPct, topDepthUsd, imbalance, ts }',
  })
  async riskLiquidity(@Req() req: Request, @Res() res: Response) {
    return this.f('risk/liquidity', req, res);
  }

  @Get('inspector/risk/audit')
  @ApiOperation({
    summary: 'Risk audit tail',
    description:
      'Returns recent risk audit entries (risk governor decisions, blocks, allows).',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max entries (default 200)',
  })
  async riskAudit(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('risk/audit', query, res, req);
  }

  @Get('inspector/risk/audit/questdb')
  @ApiOperation({
    summary: 'Risk audit from QuestDB',
    description: 'Returns risk audit entries from QuestDB persistent storage.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max entries (default 200)',
  })
  async riskAuditQuestdb(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('risk/audit/questdb', query, res, req);
  }

  // ────────────────────── Governor / State ──────────────────────

  @Get('inspector/idempotency/stats')
  @ApiOperation({
    summary: 'Idempotency stats',
    description:
      'Returns order idempotency statistics: duplicate detection, dedup hits.',
  })
  async idempotencyStats(@Req() req: Request, @Res() res: Response) {
    return this.f('idempotency/stats', req, res);
  }

  @Get('inspector/idempotency')
  @ApiOperation({
    summary: 'Idempotency state + reservations',
    description: 'Returns combined idempotency stats and reservation data.',
  })
  async idempotency(@Req() req: Request, @Res() res: Response) {
    return this.f('idempotency', req, res);
  }

  @Get('inspector/reservations/stats')
  @ApiOperation({
    summary: 'Reservation stats',
    description: 'Returns quantity reservation statistics.',
  })
  async reservationsStats(@Req() req: Request, @Res() res: Response) {
    return this.f('reservations/stats', req, res);
  }

  @Get('inspector/governor/state')
  @ApiOperation({
    summary: 'Risk governor diagnostics',
    description:
      'Returns risk governor state: current action (ALLOW/BLOCK/THROTTLE/STAND_DOWN/CLOSE_ALL), ' +
      'reasons, circuit breaker status, cooldown timers.',
  })
  async governorState(@Req() req: Request, @Res() res: Response) {
    return this.f('governor/state', req, res);
  }

  // ────────────────────── Metrics ──────────────────────

  @Get('inspector/metrics')
  @ApiOperation({
    summary: 'Inspector Prometheus metrics',
    description:
      'Returns Prometheus-formatted metrics from the Inspector service.',
  })
  @ApiOkResponse({ description: 'Prometheus text/plain metrics' })
  async metrics(@Req() req: Request, @Res() res: Response) {
    return this.f('metrics', req, res);
  }

  @Get('inspector/event-bus/latency')
  @ApiOperation({
    summary: 'Event-bus latency metrics',
    description: 'Returns event-bus latency samples for monitoring.',
  })
  @ApiOkResponse({
    description:
      '{ metric: "event_bus_latency_ms", samples: [{ labels, value }] }',
  })
  async eventBusLatency(@Req() req: Request, @Res() res: Response) {
    return this.f('event-bus/latency', req, res);
  }

  @Get('inspector/event-trace/latency')
  @ApiOperation({
    summary: 'Event-trace latency metrics',
    description: 'Returns event-trace latency samples for monitoring.',
  })
  @ApiOkResponse({
    description:
      '{ metric: "event_trace_latency_ms", samples: [{ labels, value }] }',
  })
  async eventTraceLatency(@Req() req: Request, @Res() res: Response) {
    return this.f('event-trace/latency', req, res);
  }

  // ────────────────────── WebSocket Recovery ──────────────────────

  @Get('inspector/ws-recovery')
  @ApiOperation({
    summary: 'WebSocket recovery state',
    description:
      'Returns WS recovery parameters: stale timeout, recovery grace periods, health node state.',
  })
  @ApiOkResponse({
    description:
      '{ ws: { staleMs, recoveryGraceMs, candleRecoveryGraceMs }, node, systemState }',
  })
  async wsRecovery(@Req() req: Request, @Res() res: Response) {
    return this.f('ws-recovery', req, res);
  }

  // ────────────────────── System ──────────────────────

  @Post('inspector/system/standdown')
  @ApiOperation({
    summary: 'Set system standdown',
    description:
      'Enables or disables system standdown mode. When enabled, the Inspector ' +
      'blocks all new order execution.',
  })
  @ApiBody({ type: SystemStanddownDto })
  async systemStanddown(
    @Req() req: Request,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fm('POST', 'system/standdown', undefined, body, req, res);
  }

  @Get('inspector/system/state')
  @ApiOperation({
    summary: 'System state snapshot',
    description: 'Returns the current system state snapshot.',
  })
  async systemState(@Req() req: Request, @Res() res: Response) {
    return this.f('system/state', req, res);
  }

  @Get('inspector/system')
  @ApiOperation({
    summary: 'System overview',
    description:
      'Returns combined system overview: health (state, degraded/blocked reasons), ' +
      'system state, and runtime config.',
  })
  @ApiOkResponse({
    description:
      '{ health: { state, degradedReasons, blockedReasons }, systemState, runtimeConfig }',
  })
  async system(@Req() req: Request, @Res() res: Response) {
    return this.f('system', req, res);
  }

  // ────────────────────── Plugins ──────────────────────

  @Get('inspector/plugins')
  @ApiOperation({
    summary: 'Plugin list',
    description: 'Returns all registered plugins (alias for /plugins/runtime).',
  })
  async plugins(@Req() req: Request, @Res() res: Response) {
    return this.f('plugins', req, res);
  }

  @Get('inspector/plugins/runtime')
  @ApiOperation({
    summary: 'Plugin runtime snapshot',
    description:
      'Returns plugin runtime snapshot: evaluation timestamp, detector plugins, ' +
      'health graph (state, degraded/blocked reasons).',
  })
  @ApiOkResponse({
    description:
      '{ evaluatedAt, detectors, healthGraph: { state, degradedReasons, blockedReasons, evaluatedAt } }',
  })
  async pluginsRuntime(@Req() req: Request, @Res() res: Response) {
    return this.f('plugins/runtime', req, res);
  }

  @Post('inspector/plugins/:detectorKey/:pluginId/disable')
  @ApiOperation({
    summary: 'Disable a plugin',
    description:
      'Disables a specific detector plugin by detector key and plugin ID.',
  })
  @ApiParam({
    name: 'detectorKey',
    type: String,
    description: 'Detector instance key',
  })
  @ApiParam({
    name: 'pluginId',
    type: String,
    description: 'Plugin identifier',
  })
  async pluginDisable(
    @Param('detectorKey') detectorKey: string,
    @Param('pluginId') pluginId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.fm(
      'POST',
      `plugins/${detectorKey}/${pluginId}/disable`,
      undefined,
      undefined,
      req,
      res,
    );
  }

  // ────────────────────── Reconciliation ──────────────────────

  @Get('inspector/reconcile/state')
  @ApiOperation({
    summary: 'Reconciliation state',
    description: 'Returns current reconciliation state.',
  })
  async reconcileState(@Req() req: Request, @Res() res: Response) {
    return this.f('reconcile/state', req, res);
  }

  @Post('inspector/reconcile/runOnce')
  @ApiOperation({
    summary: 'Run reconciliation once',
    description:
      'Triggers a single reconciliation run. Requires INSPECTOR_RECONCILE_RUNONCE_ENABLED=true.',
  })
  @ApiOkResponse({ description: '{ executed: boolean, reason?: string }' })
  async reconcileRunOnce(@Req() req: Request, @Res() res: Response) {
    return this.fm('POST', 'reconcile/runOnce', undefined, undefined, req, res);
  }

  // ────────────────────── Post-Trade Audit ──────────────────────

  @Get('inspector/audit/recent')
  @ApiOperation({
    summary: 'Recent post-trade audit',
    description:
      'Returns recent post-trade audit entries. Filterable by account and symbol.',
  })
  @ApiQuery({
    name: 'accountId',
    required: false,
    type: String,
    description: 'Filter by account ID',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    type: String,
    description: 'Filter by symbol',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max entries (default 200)',
  })
  async auditRecent(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('audit/recent', query, res, req);
  }

  @Get('inspector/audit/anomalies')
  @ApiOperation({
    summary: 'Audit anomalies',
    description:
      'Returns detected post-trade anomalies within the given time window.',
  })
  @ApiQuery({
    name: 'windowMs',
    required: false,
    type: Number,
    description: 'Lookback window in ms',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max entries (default 200)',
  })
  async auditAnomalies(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('audit/anomalies', query, res, req);
  }

  @Post('inspector/audit/clear')
  @ApiOperation({
    summary: 'Clear post-trade audit',
    description:
      'Clears the post-trade audit store. Requires INSPECTOR_AUDIT_CLEAR_ENABLED=true.',
  })
  @ApiOkResponse({ description: '{ cleared: boolean, reason?: string }' })
  async auditClear(@Req() req: Request, @Res() res: Response) {
    return this.fm('POST', 'audit/clear', undefined, undefined, req, res);
  }

  // ────────────────────── Trade Journal / Analysis ──────────────────────

  @Get('inspector/trade-journal')
  @ApiOperation({
    summary: 'Trade journal status',
    description:
      'Returns trade journal summary: enabled flag, recent trade count, anomaly count, ' +
      'recent entries, and anomalies.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max entries (default 200)',
  })
  @ApiQuery({
    name: 'windowMs',
    required: false,
    type: Number,
    description: 'Lookback window in ms',
  })
  @ApiOkResponse({
    description: '{ enabled, recentCount, anomalyCount, recent, anomalies }',
  })
  async tradeJournal(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ) {
    return this.fq('trade-journal', query, res, req);
  }

  @Get('inspector/analysis/post-trade')
  @ApiOperation({
    summary: 'Post-trade analytics',
    description: 'Returns post-trade analytics from the TradeAnalyzer service.',
  })
  async analysisPostTrade(@Req() req: Request, @Res() res: Response) {
    return this.f('analysis/post-trade', req, res);
  }

  // ──────────────── helpers ────────────────

  private h(req: Request): Record<string, unknown> {
    return req.headers as Record<string, unknown>;
  }

  /** GET with no query → inspector/{endpoint} */
  private async f(endpoint: string, req: Request, res: Response) {
    const result = await this.svc.get(endpoint, undefined, this.h(req));
    return res.status(result.status).send(result.data);
  }

  /** GET with query → inspector/{endpoint} */
  private async fq(
    endpoint: string,
    query: Record<string, unknown>,
    res: Response,
    req: Request,
  ) {
    const result = await this.svc.get(endpoint, query, this.h(req));
    return res.status(result.status).send(result.data);
  }

  /** Any method with optional query + body → inspector/{endpoint} */
  private async fm(
    method: string,
    endpoint: string,
    query: Record<string, unknown> | undefined,
    body: Record<string, unknown> | undefined,
    req: Request,
    res: Response,
  ) {
    const result = await this.svc.request(
      method,
      endpoint,
      query,
      body,
      this.h(req),
    );
    return res.status(result.status).send(result.data);
  }
}
