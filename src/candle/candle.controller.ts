import {
  Body,
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiBody,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';

import { ConnectorType, MarketType, TimeFrame } from '@barfinex/types';

import { CandleDto, CandleRepairRequestDto } from '../dto';
import { CandleQueryService } from './candle-query.service';
import { CandleService } from './candle.service';
import { toDomainInterval } from './time/time.utils';
import { CandleRepairRunner } from './repair/candle-repair.runner';
import { CandleRepairRequest } from './repair/candle-repair.types';
import { CandleIntegrityService } from './debug/candle-integrity.service';
import { CandleRepairJobOrchestrator } from './debug/candle-repair-job.orchestrator';
import { CandleDebugJobStore } from './debug/candle-debug-job.store';
import { CandleDebugDashboardService } from './debug/candle-debug-dashboard.service';
import { CandleVerifyJobOrchestrator } from './debug/candle-verify-job.orchestrator';
import { CandleDebugWatchdogService } from './debug/candle-debug-watchdog.service';
import { CandleIngestionHealthService } from './debug/candle-ingestion-health.service';
import { CandleIntegrityIncidentStore } from './debug/candle-integrity-incident.store';
import { CandleIntegrityEventStore } from './debug/candle-integrity-event.store';
import { CandleSelfHealingOrchestratorService } from './debug/candle-self-healing-orchestrator.service';
import { CandleDebugTimelineService } from './debug/candle-debug-timeline.service';
import type {
  CandleIntegrityIncidentStatus,
  CandleIntegrityIncidentSeverity,
  CandleIntegrityIncidentCategory,
  CandleIntegrityIncidentType,
  CandleIntegrityEventType,
  CandleIntegrityEventLevel,
} from './debug/candle-integrity-incident.types';

@ApiTags('Candles')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('candles')
export class CandleController {
  constructor(
    private readonly query: CandleQueryService,
    private readonly candleService: CandleService,
    private readonly repairRunner: CandleRepairRunner,
    private readonly integrityService: CandleIntegrityService,
    private readonly repairJobOrchestrator: CandleRepairJobOrchestrator,
    private readonly verifyJobOrchestrator: CandleVerifyJobOrchestrator,
    private readonly debugJobStore: CandleDebugJobStore,
    private readonly dashboardService: CandleDebugDashboardService,
    private readonly watchdogService: CandleDebugWatchdogService,
    private readonly ingestionHealthService: CandleIngestionHealthService,
    private readonly incidentStore: CandleIntegrityIncidentStore,
    private readonly eventStore: CandleIntegrityEventStore,
    private readonly selfHealingOrchestrator: CandleSelfHealingOrchestratorService,
    private readonly timelineService: CandleDebugTimelineService,
  ) {}

  @Get('debug/dashboard')
  @ApiOperation({
    summary: 'Candle debug dashboard',
    description:
      'Returns the candle integrity debug dashboard: high-level stats, recent incidents, and ingestion health. ' +
      'Used for dataset integrity diagnostics and monitoring the self-healing pipeline.',
  })
  @ApiOkResponse({
    description: 'Dashboard payload with stats, incidents, jobs',
  })
  async getDebugDashboard() {
    return this.dashboardService.getDashboard();
  }

  @Get('debug/incidents')
  @ApiOperation({
    summary: 'List candle integrity incidents',
    description:
      'Returns paginated list of candle integrity incidents (duplicates, gaps, seam, stale, etc.). Filter by status, severity, category, type, symbol, connectorType, marketType, interval.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [
      'OPEN',
      'AUTO_REPAIR_RUNNING',
      'AUTO_REPAIR_FAILED',
      'RESOLVED',
      'ESCALATED',
      'IGNORED',
    ],
  })
  @ApiQuery({
    name: 'severity',
    required: false,
    enum: ['INFO', 'WARN', 'CRITICAL'],
  })
  @ApiQuery({
    name: 'category',
    required: false,
    enum: ['STRUCTURAL', 'OPERATIONAL', 'INGESTION'],
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: [
      'DUPLICATES',
      'SEAM_ISSUE',
      'OUT_OF_ORDER',
      'GAPS',
      'STALE_SERIES',
      'CONNECTOR_STALL',
      'MIXED',
    ],
  })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'connectorType', required: false })
  @ApiQuery({ name: 'marketType', required: false })
  @ApiQuery({ name: 'interval', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiOkResponse({ description: 'Paginated list of incidents' })
  getDebugIncidents(
    @Query('status') status?: CandleIntegrityIncidentStatus,
    @Query('severity') severity?: CandleIntegrityIncidentSeverity,
    @Query('category') category?: CandleIntegrityIncidentCategory,
    @Query('type') type?: CandleIntegrityIncidentType,
    @Query('symbol') symbol?: string,
    @Query('connectorType') connectorType?: string,
    @Query('marketType') marketType?: string,
    @Query('interval') interval?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
  ) {
    const limit = limitStr != null ? parseInt(limitStr, 10) : 50;
    const offset = offsetStr != null ? parseInt(offsetStr, 10) : 0;
    return this.incidentStore.list({
      status,
      severity,
      category,
      type,
      symbol: symbol ?? undefined,
      connectorType: connectorType ?? undefined,
      marketType: marketType ?? undefined,
      interval: interval ?? undefined,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
  }

  @Get('debug/incidents/:incidentId')
  @ApiOperation({
    summary: 'Get incident by ID',
    description:
      'Returns a single candle integrity incident by ID. 404 if not found.',
  })
  @ApiParam({ name: 'incidentId', description: 'Incident ID' })
  @ApiOkResponse({ description: 'Incident object' })
  @ApiNotFoundResponse({ description: 'Incident not found' })
  getDebugIncident(@Param('incidentId') incidentId: string) {
    const incident = this.incidentStore.get(incidentId);
    if (!incident) {
      throw new NotFoundException(`Incident ${incidentId} not found`);
    }
    return incident;
  }

  @Post('debug/incidents/:incidentId/retry')
  @ApiOperation({
    summary: 'Retry incident repair',
    description:
      'Triggers a retry of auto-repair for the incident. Returns started/error.',
  })
  @ApiParam({ name: 'incidentId', description: 'Incident ID' })
  @ApiOkResponse({ description: '{ started, error? }' })
  @ApiBadRequestResponse({ description: 'Retry failed (e.g. invalid state)' })
  async retryIncident(@Param('incidentId') incidentId: string) {
    const result = await this.selfHealingOrchestrator.retryIncident(incidentId);
    if (!result.started && result.error) {
      throw new BadRequestException(result.error);
    }
    return result;
  }

  @Post('debug/incidents/:incidentId/escalate')
  @ApiOperation({
    summary: 'Escalate incident',
    description:
      'Marks the incident as escalated. Optional body.reason for audit.',
  })
  @ApiParam({ name: 'incidentId', description: 'Incident ID' })
  @ApiBody({
    required: false,
    schema: { type: 'object', properties: { reason: { type: 'string' } } },
  })
  @ApiOkResponse({ description: '{ incidentId, status: ESCALATED }' })
  @ApiNotFoundResponse({ description: 'Incident not found' })
  escalateIncident(
    @Param('incidentId') incidentId: string,
    @Body() body?: { reason?: string },
  ) {
    const incident = this.incidentStore.get(incidentId);
    if (!incident) {
      throw new NotFoundException(`Incident ${incidentId} not found`);
    }
    this.selfHealingOrchestrator.escalateIncident(incidentId, body?.reason);
    return { incidentId, status: 'ESCALATED' };
  }

  @Post('debug/incidents/:incidentId/ignore')
  @ApiOperation({
    summary: 'Ignore incident',
    description:
      'Marks the incident as ignored. No further auto-repair will run.',
  })
  @ApiParam({ name: 'incidentId', description: 'Incident ID' })
  @ApiOkResponse({ description: '{ incidentId, status: IGNORED }' })
  @ApiNotFoundResponse({ description: 'Incident not found' })
  ignoreIncident(@Param('incidentId') incidentId: string) {
    const incident = this.incidentStore.get(incidentId);
    if (!incident) {
      throw new NotFoundException(`Incident ${incidentId} not found`);
    }
    this.selfHealingOrchestrator.ignoreIncident(incidentId);
    return { incidentId, status: 'IGNORED' };
  }

  @Get('debug/events')
  @ApiOperation({
    summary: 'List candle integrity events',
    description:
      'Returns integrity events (log entries) for debugging. Filter by incidentId, eventType, level, from, to. Paginated via limit/offset.',
  })
  @ApiQuery({ name: 'incidentId', required: false })
  @ApiQuery({ name: 'eventType', required: false })
  @ApiQuery({ name: 'level', required: false, enum: ['INFO', 'WARN', 'ERROR'] })
  @ApiQuery({ name: 'from', required: false, description: 'ISO timestamp' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO timestamp' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiOkResponse({ description: 'Paginated list of events' })
  getDebugEvents(
    @Query('incidentId') incidentId?: string,
    @Query('eventType') eventType?: CandleIntegrityEventType,
    @Query('level') level?: CandleIntegrityEventLevel,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
  ) {
    const limit = limitStr != null ? parseInt(limitStr, 10) : 100;
    const offset = offsetStr != null ? parseInt(offsetStr, 10) : 0;
    return this.eventStore.listReverseChrono({
      incidentId: incidentId ?? undefined,
      eventType,
      level,
      from: from ?? undefined,
      to: to ?? undefined,
      limit: Number.isFinite(limit) ? limit : 100,
      offset: Number.isFinite(offset) ? offset : 0,
    });
  }

  @Get('debug/events/:eventId')
  @ApiOperation({
    summary: 'Get event by ID',
    description: 'Returns a single integrity event by ID. 404 if not found.',
  })
  @ApiParam({ name: 'eventId', description: 'Event ID' })
  @ApiOkResponse({ description: 'Event object' })
  @ApiNotFoundResponse({ description: 'Event not found' })
  getDebugEvent(@Param('eventId') eventId: string) {
    const event = this.eventStore.get(eventId);
    if (!event) {
      throw new NotFoundException(`Event ${eventId} not found`);
    }
    return event;
  }

  @Get('debug/timeline')
  @ApiOperation({
    summary: 'Candle integrity timeline',
    description:
      'Returns a combined timeline of incidents and events for debugging. Filter by from, to, limit, incidentId, eventType, severity.',
  })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'incidentId', required: false })
  @ApiQuery({ name: 'eventType', required: false })
  @ApiQuery({ name: 'severity', required: false })
  @ApiOkResponse({ description: 'Timeline entries (incidents + events)' })
  getDebugTimeline(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limitStr?: string,
    @Query('incidentId') incidentId?: string,
    @Query('eventType') eventType?: string,
    @Query('severity') severity?: string,
  ) {
    const limit = limitStr != null ? parseInt(limitStr, 10) : 100;
    return this.timelineService.getTimeline({
      from: from ?? undefined,
      to: to ?? undefined,
      limit: Number.isFinite(limit) ? limit : 100,
      incidentId: incidentId ?? undefined,
      eventType: eventType ?? undefined,
      severity: severity ?? undefined,
    });
  }

  @Get('debug/watchdog')
  @ApiOperation({
    summary: 'Candle watchdog state',
    description:
      'Returns the candle integrity watchdog state (last run, next run, enabled). Used for monitoring the self-healing pipeline.',
  })
  @ApiOkResponse({ description: 'Watchdog state object' })
  async getDebugWatchdog() {
    return this.watchdogService.getWatchdog();
  }

  @Get('debug/ingestion')
  @ApiOperation({
    summary: 'Candle ingestion health',
    description:
      'Returns ingestion health per connector: last candle ts, lag, status. Used for monitoring candle pipeline health.',
  })
  @ApiOkResponse({ description: '{ connectors: [...] }' })
  async getDebugIngestion() {
    const data = await this.ingestionHealthService.getIngestionHealth();
    return {
      connectors: Array.isArray(data?.connectors) ? data.connectors : [],
    };
  }

  @Get('debug/stats')
  @ApiOperation({
    summary: 'Candle integrity stats',
    description:
      'Returns high-level integrity diagnostics (series list with duplicate/gap/out-of-order counts). Optional symbol filter.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    description: 'Filter by symbol',
  })
  @ApiOkResponse({ description: 'Diagnostics with series[]' })
  async getDebugStats(@Query('symbol') symbol?: string) {
    const diagnostics = await this.integrityService.scanDiagnostics();
    const series = diagnostics.series ?? [];
    if (symbol != null && symbol !== '') {
      const filtered = series.filter((s) => s.key.symbol === symbol);
      return {
        ...diagnostics,
        series: filtered,
        seriesCount: filtered.length,
      };
    }
    return { ...diagnostics, series };
  }

  @Get('debug/duplicates')
  @ApiOperation({
    summary: 'List duplicate candle rows',
    description:
      'Diagnoses duplicate timestamps in candle series. Returns rows that appear more than once for the same (connector, market, symbol, interval). ' +
      'Use this endpoint when investigating dataset integrity issues.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    description: 'Filter by symbol',
  })
  @ApiOkResponse({ description: 'List of duplicate candle entries' })
  async getDebugDuplicates(@Query('symbol') symbol?: string) {
    const list = await this.integrityService.getDuplicates(symbol ?? undefined);
    return Array.isArray(list) ? list : [];
  }

  @Get('debug/gaps')
  @ApiOperation({
    summary: 'List gap ranges in candle series',
    description:
      'Diagnoses missing candle intervals (gaps) in time series. Returns contiguous ranges where candles are missing. ' +
      'Used for dataset integrity diagnostics and planning backfill.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    description: 'Filter by symbol',
  })
  @ApiQuery({
    name: 'maxRanges',
    required: false,
    type: Number,
    description: 'Max gap ranges to return',
  })
  @ApiOkResponse({ description: 'List of gap ranges { from, to }' })
  async getDebugGaps(
    @Query('symbol') symbol?: string,
    @Query('maxRanges') maxRanges?: string,
  ) {
    const max = maxRanges ? Math.max(1, parseInt(maxRanges, 10) || 500) : 500;
    const list = await this.integrityService.getGaps(symbol ?? undefined, max);
    return Array.isArray(list) ? list : [];
  }

  @Get('debug/out-of-order')
  @ApiOperation({
    summary: 'List out-of-order candle rows',
    description:
      'Diagnoses candles that are not in ascending timestamp order. Used for dataset integrity diagnostics.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    description: 'Filter by symbol',
  })
  @ApiOkResponse({ description: 'List of out-of-order candle entries' })
  async getDebugOutOfOrder(@Query('symbol') symbol?: string) {
    const list = await this.integrityService.getOutOfOrder(symbol ?? undefined);
    return Array.isArray(list) ? list : [];
  }

  @Get('debug/series')
  @ApiOperation({
    summary: 'List candle series (with optional pagination)',
    description:
      'Returns list of candle series with integrity status. Filter by symbol, status (healthy/degraded), connectorType, interval. Use limit/offset for pagination.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    description: 'Filter by symbol',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['healthy', 'degraded'],
    description: 'Filter by status',
  })
  @ApiQuery({
    name: 'connectorType',
    required: false,
    description: 'Filter by connector',
  })
  @ApiQuery({
    name: 'interval',
    required: false,
    description: 'Filter by interval',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size (enables pagination)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Page offset',
  })
  async getDebugSeries(
    @Query('symbol') symbol?: string,
    @Query('status') status?: string,
    @Query('connectorType') connectorType?: string,
    @Query('interval') interval?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
  ) {
    const limit = limitStr != null ? parseInt(limitStr, 10) : undefined;
    const offset = offsetStr != null ? parseInt(offsetStr, 10) : undefined;
    const usePagination = limit != null && Number.isFinite(limit) && limit > 0;
    if (usePagination) {
      const result = await this.integrityService.getSeriesPaginated({
        symbol: symbol ?? undefined,
        status:
          status === 'healthy' || status === 'degraded' ? status : undefined,
        connectorType: connectorType ?? undefined,
        interval: interval ?? undefined,
        limit,
        offset: offset != null && Number.isFinite(offset) ? offset : 0,
      });
      return result;
    }
    const list = await this.integrityService.getSeries(symbol ?? undefined);
    return Array.isArray(list) ? list : [];
  }

  @Get('debug/seam')
  @ApiOperation({
    summary: 'Seam diagnostics',
    description:
      'Returns seam diagnostics (boundary between chunks) for candle series. Used to detect gaps or duplicates at segment boundaries.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    description: 'Filter by symbol',
  })
  @ApiOkResponse({ description: 'List of seam diagnostic entries' })
  async getDebugSeam(@Query('symbol') symbol?: string) {
    const list = await this.integrityService.getSeamDiagnostics(
      symbol ?? undefined,
    );
    return Array.isArray(list) ? list : [];
  }

  @Get('debug/symbol/:symbol')
  @ApiOperation({
    summary: 'Integrity diagnostics for symbol',
    description:
      'Returns integrity diagnostics (duplicates, gaps, out-of-order, seam) for all series of the given symbol.',
  })
  @ApiParam({ name: 'symbol', description: 'Trading symbol (e.g. BTCUSDT)' })
  @ApiOkResponse({ description: 'Diagnostics for the symbol' })
  async getDebugSymbol(@Param('symbol') symbol: string) {
    return this.integrityService.getDiagnosticsForSymbol(symbol);
  }

  @Get('debug/staleness')
  @ApiOperation({
    summary: 'Series staleness',
    description:
      'Returns which series are stale (no recent candle). Optional warningSeconds and criticalSeconds thresholds (defaults from config).',
  })
  @ApiQuery({
    name: 'warningSeconds',
    required: false,
    type: Number,
    description: 'Warning threshold in seconds',
  })
  @ApiQuery({
    name: 'criticalSeconds',
    required: false,
    type: Number,
    description: 'Critical threshold in seconds',
  })
  @ApiOkResponse({
    description: '{ series: [{ symbol, interval, status, lastTs, ... }] }',
  })
  async getDebugStaleness(
    @Query('warningSeconds') warningSeconds?: string,
    @Query('criticalSeconds') criticalSeconds?: string,
  ) {
    const options: { warningSeconds?: number; criticalSeconds?: number } = {};
    if (warningSeconds != null) {
      const n = parseInt(warningSeconds, 10);
      if (Number.isFinite(n)) options.warningSeconds = n;
    }
    if (criticalSeconds != null) {
      const n = parseInt(criticalSeconds, 10);
      if (Number.isFinite(n)) options.criticalSeconds = n;
    }
    return this.integrityService.getStaleness(options);
  }

  @Get('debug/series/detail')
  @ApiOperation({
    summary: 'Series detail',
    description:
      'Returns detailed integrity info for a single series: connectorType, marketType, symbol, interval. All four query params are required.',
  })
  @ApiQuery({
    name: 'connectorType',
    required: true,
    description: 'Connector type (e.g. BINANCE)',
  })
  @ApiQuery({
    name: 'marketType',
    required: true,
    description: 'Market type (e.g. SPOT, FUTURES)',
  })
  @ApiQuery({ name: 'symbol', required: true, description: 'Trading symbol' })
  @ApiQuery({
    name: 'interval',
    required: true,
    description: 'Candle interval (e.g. 1m, h1)',
  })
  @ApiOkResponse({ description: 'Series detail object' })
  @ApiNotFoundResponse({ description: 'Series not found' })
  async getDebugSeriesDetail(
    @Query('connectorType') connectorType: string,
    @Query('marketType') marketType: string,
    @Query('symbol') symbol: string,
    @Query('interval') intervalRaw: string,
  ) {
    if (!connectorType || !marketType || !symbol || !intervalRaw) {
      throw new BadRequestException(
        'Query params connectorType, marketType, symbol, interval are required.',
      );
    }
    const interval = toDomainInterval(intervalRaw) as TimeFrame;
    const detail = await this.integrityService.getSeriesDetail({
      connectorType,
      marketType,
      symbol,
      interval,
    });
    if (detail == null) {
      throw new NotFoundException(
        `Series not found: ${connectorType}/${marketType}/${symbol}/${intervalRaw}`,
      );
    }
    return detail;
  }

  @Get('debug/issues/summary')
  @ApiOperation({
    summary: 'Issues summary counts',
    description:
      'Returns aggregate counts of integrity issues: duplicateRowsTotal, gapCountTotal, outOfOrderCountTotal, seamIssueCount, staleSeriesCount, laggingSeriesCount. Optional symbol filter.',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    description: 'Filter by symbol',
  })
  @ApiOkResponse({ description: 'Object with issue counts' })
  async getDebugIssuesSummary(@Query('symbol') symbol?: string) {
    const [diagnostics, seam, staleness] = await Promise.all([
      this.integrityService.scanDiagnostics(),
      this.integrityService.getSeamDiagnostics(symbol ?? undefined),
      this.integrityService.getStaleness(),
    ]);
    let series = diagnostics.series;
    if (symbol != null && symbol !== '') {
      series = series.filter((s) => s.key.symbol === symbol);
    }
    const duplicateRowsTotal = series.reduce((s, x) => s + x.duplicateRows, 0);
    const gapCountTotal = series.reduce((s, x) => s + x.gapCount, 0);
    const outOfOrderCountTotal = series.reduce(
      (s, x) => s + x.outOfOrderCount,
      0,
    );
    const seamRows =
      symbol != null ? seam.filter((r) => r.symbol === symbol) : seam;
    const seamIssueCount = seamRows.filter(
      (r) => r.gapAtSeam || (r.rowsAtLastTs != null && r.rowsAtLastTs !== 1),
    ).length;
    const staleSeries = staleness.series.filter(
      (r) => r.status !== 'ok' && (symbol == null || r.symbol === symbol),
    );
    const staleCount = staleSeries.filter((r) => r.status === 'warning').length;
    const laggingCount = staleSeries.filter(
      (r) => r.status === 'critical',
    ).length;
    return {
      duplicateRowsTotal,
      gapCountTotal,
      outOfOrderCountTotal,
      seamIssueCount,
      staleSeriesCount: staleCount,
      laggingSeriesCount: laggingCount,
    };
  }

  @Get('debug/issues/duplicates')
  @ApiOperation({
    summary: 'Duplicate issues list',
    description:
      'Returns list of duplicate candle rows (filtered by symbol, connectorType, marketType, interval, limit). Used for integrity drill-down.',
  })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'connectorType', required: false })
  @ApiQuery({ name: 'marketType', required: false })
  @ApiQuery({ name: 'interval', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ description: 'Filtered list of duplicate entries' })
  async getDebugIssuesDuplicates(
    @Query('symbol') symbol?: string,
    @Query('connectorType') connectorType?: string,
    @Query('marketType') marketType?: string,
    @Query('interval') interval?: string,
    @Query('limit') limitStr?: string,
  ) {
    const list = await this.integrityService.getDuplicates(symbol ?? undefined);
    const filtered = this.filterIssueList(
      list,
      connectorType,
      marketType,
      interval,
      limitStr,
      (e) => ({
        connectorType: e.connectorType,
        marketType: e.marketType,
        interval: e.interval,
      }),
    );
    return filtered;
  }

  @Get('debug/issues/gaps')
  @ApiOperation({
    summary: 'Gap issues list',
    description:
      'Returns list of gap ranges (missing intervals) in candle series. Filter by symbol, connectorType, marketType, interval, limit. maxRanges caps gap ranges per series.',
  })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'connectorType', required: false })
  @ApiQuery({ name: 'marketType', required: false })
  @ApiQuery({ name: 'interval', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({
    name: 'maxRanges',
    required: false,
    type: Number,
    description: 'Max gap ranges to return per series',
  })
  @ApiOkResponse({ description: 'Filtered list of gap ranges' })
  async getDebugIssuesGaps(
    @Query('symbol') symbol?: string,
    @Query('connectorType') connectorType?: string,
    @Query('marketType') marketType?: string,
    @Query('interval') interval?: string,
    @Query('limit') limitStr?: string,
    @Query('maxRanges') maxRangesStr?: string,
  ) {
    const maxRanges = maxRangesStr
      ? Math.min(2000, Math.max(1, parseInt(maxRangesStr, 10) || 500))
      : 500;
    const list = await this.integrityService.getGaps(
      symbol ?? undefined,
      maxRanges,
    );
    const filtered = this.filterIssueList(
      list,
      connectorType,
      marketType,
      interval,
      limitStr,
      (e) => ({
        connectorType: e.connectorType,
        marketType: e.marketType,
        interval: e.interval,
      }),
    );
    return filtered;
  }

  @Get('debug/issues/out-of-order')
  @ApiOperation({
    summary: 'Out-of-order issues list',
    description:
      'Returns list of out-of-order candle rows. Filter by symbol, connectorType, marketType, interval, limit.',
  })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'connectorType', required: false })
  @ApiQuery({ name: 'marketType', required: false })
  @ApiQuery({ name: 'interval', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ description: 'Filtered list of out-of-order entries' })
  async getDebugIssuesOutOfOrder(
    @Query('symbol') symbol?: string,
    @Query('connectorType') connectorType?: string,
    @Query('marketType') marketType?: string,
    @Query('interval') interval?: string,
    @Query('limit') limitStr?: string,
  ) {
    const list = await this.integrityService.getOutOfOrder(symbol ?? undefined);
    const filtered = this.filterIssueList(
      list,
      connectorType,
      marketType,
      interval,
      limitStr,
      (e) => ({
        connectorType: e.connectorType,
        marketType: e.marketType,
        interval: e.interval,
      }),
    );
    return filtered;
  }

  @Get('debug/issues/seam')
  @ApiOperation({
    summary: 'Seam issues list',
    description:
      'Returns list of series with seam issues (gap or duplicate at boundary). Filter by symbol, connectorType, marketType, interval, limit.',
  })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'connectorType', required: false })
  @ApiQuery({ name: 'marketType', required: false })
  @ApiQuery({ name: 'interval', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ description: 'Filtered list of seam issue entries' })
  async getDebugIssuesSeam(
    @Query('symbol') symbol?: string,
    @Query('connectorType') connectorType?: string,
    @Query('marketType') marketType?: string,
    @Query('interval') interval?: string,
    @Query('limit') limitStr?: string,
  ) {
    const list = await this.integrityService.getSeamDiagnostics(
      symbol ?? undefined,
    );
    const withIssues = list.filter(
      (r) => r.gapAtSeam || (r.rowsAtLastTs != null && r.rowsAtLastTs !== 1),
    );
    const filtered = this.filterIssueList(
      withIssues,
      connectorType,
      marketType,
      interval,
      limitStr,
      (e) => ({
        connectorType: e.connectorType,
        marketType: e.marketType,
        interval: e.interval,
      }),
    );
    return filtered;
  }

  @Get('debug/issues/stale')
  @ApiOperation({
    summary: 'Stale series list',
    description:
      'Returns list of series that are stale (no recent candle). Filter by symbol, connectorType, marketType, interval, limit.',
  })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'connectorType', required: false })
  @ApiQuery({ name: 'marketType', required: false })
  @ApiQuery({ name: 'interval', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ description: 'Filtered list of stale series' })
  async getDebugIssuesStale(
    @Query('symbol') symbol?: string,
    @Query('connectorType') connectorType?: string,
    @Query('marketType') marketType?: string,
    @Query('interval') interval?: string,
    @Query('limit') limitStr?: string,
  ) {
    const { series } = await this.integrityService.getStaleness();
    const withIssues = series.filter((r) => r.status !== 'ok');
    const filtered = this.filterIssueList(
      withIssues,
      connectorType,
      marketType,
      interval,
      limitStr,
      (e) => ({
        connectorType: e.connectorType,
        marketType: e.marketType,
        interval: e.interval,
      }),
    );
    return filtered;
  }

  @Get('debug/integrity-report')
  @ApiOperation({
    summary: 'Candle integrity report',
    description:
      'Returns integrity report (duplicates, gaps, out-of-order) for all series or a single series when connectorType, marketType, symbol, interval are provided. ' +
      'Used for dataset integrity diagnostics.',
  })
  @ApiQuery({ name: 'connectorType', required: false })
  @ApiQuery({ name: 'marketType', required: false })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'interval', required: false })
  @ApiOkResponse({ description: 'Integrity report(s)' })
  @ApiBadRequestResponse({
    description: 'When filtering, all four params are required',
  })
  async getIntegrityReport(
    @Query('connectorType') connectorType?: string,
    @Query('marketType') marketType?: string,
    @Query('symbol') symbol?: string,
    @Query('interval') intervalRaw?: string,
  ) {
    const hasSelector =
      connectorType != null ||
      marketType != null ||
      symbol != null ||
      intervalRaw != null;
    if (!hasSelector) {
      return this.repairRunner.loadIntegrityReport();
    }
    if (!connectorType || !marketType || !symbol || !intervalRaw) {
      throw new BadRequestException(
        'When filtering integrity report, connectorType, marketType, symbol, and interval are all required.',
      );
    }
    return this.repairRunner.loadIntegrityReport({
      connectorType,
      marketType,
      symbol,
      interval: toDomainInterval(intervalRaw) as TimeFrame,
    });
  }

  @Get('debug/repair/preview')
  @ApiOperation({
    summary: 'Repair job preview',
    description:
      'Returns estimated repair scope: affectedSeries, estimatedRowsToBackfill, estimatedDurationMs, seriesCount. Optionally restrict to one series via connectorType, marketType, symbol, interval (all four required when filtering).',
  })
  @ApiQuery({ name: 'connectorType', required: false })
  @ApiQuery({ name: 'marketType', required: false })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'interval', required: false })
  @ApiOkResponse({
    description:
      '{ affectedSeries, estimatedRowsToBackfill, estimatedDurationMs, expectedRepairScope, seriesCount, estimationBasis }',
  })
  async getRepairPreview(
    @Query('connectorType') connectorType?: string,
    @Query('marketType') marketType?: string,
    @Query('symbol') symbol?: string,
    @Query('interval') intervalRaw?: string,
  ) {
    const series =
      connectorType && marketType && symbol && intervalRaw
        ? {
            connectorType,
            marketType,
            symbol,
            interval: toDomainInterval(
              intervalRaw,
            ) as import('@barfinex/types').TimeFrame,
          }
        : undefined;
    const reports = await this.repairRunner.loadIntegrityReport(series);
    const affectedSeries = reports.map((r) => ({
      connectorType: r.connectorType,
      marketType: r.marketType,
      symbol: r.symbol,
      interval: r.interval,
      duplicateRows: r.duplicateRows,
      gapCount: r.gapCount,
      outOfOrderCount: r.outOfOrderCount,
      missingRangesCount: r.missingRanges?.length ?? 0,
    }));
    let estimatedRowsToBackfill = 0;
    const intervalMsMap: Record<string, number> = {
      min1: 60_000,
      min5: 300_000,
      min15: 900_000,
      min30: 1_800_000,
      h1: 3_600_000,
      h4: 14_400_000,
      day: 86_400_000,
    };
    for (const r of reports) {
      const intervalMs = intervalMsMap[String(r.interval)] ?? 60_000;
      for (const range of r.missingRanges ?? []) {
        estimatedRowsToBackfill += Math.ceil(
          (range.to - range.from) / intervalMs,
        );
      }
    }
    const seriesCount = reports.length;
    const heuristicDurationMs = Math.min(
      3600_000,
      estimatedRowsToBackfill * 2 + seriesCount * 500,
    );
    const { estimatedDurationMs, estimationBasis } =
      this.estimateRepairDuration(
        seriesCount,
        estimatedRowsToBackfill,
        heuristicDurationMs,
      );
    return {
      affectedSeries,
      estimatedRowsToBackfill,
      estimatedDurationMs,
      expectedRepairScope: series ? 'targeted' : 'full',
      seriesCount,
      estimationBasis,
    };
  }

  /**
   * Use recent completed repair jobs to calibrate duration estimate when possible.
   * HEURISTIC: 2 ms/row + 500 ms/series (cap 1h). HISTORICAL: from completed jobs. HYBRID: blend.
   */
  private estimateRepairDuration(
    seriesCount: number,
    estimatedRowsToBackfill: number,
    heuristicMs: number,
  ): {
    estimatedDurationMs: number;
    estimationBasis: 'HEURISTIC' | 'HISTORICAL' | 'HYBRID';
  } {
    const repairJobs = this.debugJobStore
      .list('repair')
      .filter((j) => j.status === 'completed')
      .slice(-20);
    const samples: { durationMs: number; series: number; rows: number }[] = [];
    for (const j of repairJobs) {
      const job = this.debugJobStore.get(j.jobId);
      if (!job?.result) continue;
      const durationMs = job.result.durationMs ?? 0;
      const totalSeries = job.totalSeries ?? 1;
      const rows =
        (job.result.gapsFixed ?? 0) + (job.result.duplicatesFixed ?? 0) || 1;
      if (durationMs > 0)
        samples.push({ durationMs, series: totalSeries, rows });
    }
    if (samples.length < 2) {
      return { estimatedDurationMs: heuristicMs, estimationBasis: 'HEURISTIC' };
    }
    const avgMsPerSeries =
      samples.reduce((a, s) => a + s.durationMs / s.series, 0) / samples.length;
    const rowSamples = samples.filter((s) => s.rows > 0);
    const avgMsPerRow =
      rowSamples.length > 0
        ? rowSamples.reduce((a, s) => a + s.durationMs / s.rows, 0) /
          rowSamples.length
        : 2;
    const historicalMs = Math.min(
      3600_000,
      seriesCount * avgMsPerSeries + estimatedRowsToBackfill * avgMsPerRow,
    );
    if (samples.length >= 5) {
      return {
        estimatedDurationMs: Math.round(historicalMs),
        estimationBasis: 'HISTORICAL',
      };
    }
    const blend = 0.5 * heuristicMs + 0.5 * historicalMs;
    return {
      estimatedDurationMs: Math.round(Math.min(3600_000, blend)),
      estimationBasis: 'HYBRID',
    };
  }

  @Post('debug/repair')
  @ApiOperation({
    summary: 'Start candle repair job',
    description:
      'Starts a repair job to fix duplicates, fill gaps, and reorder out-of-order rows. ' +
      'Mode: dry-run (report only) or apply (perform changes). Optionally restrict to one series via body.series.',
  })
  @ApiBody({ type: CandleRepairRequestDto })
  @ApiOkResponse({ description: 'Job started: jobId, status' })
  @ApiBadRequestResponse({
    description:
      'Invalid mode or missing series fields when series is provided',
  })
  async repairDataset(@Body() body: CandleRepairRequest) {
    if (!body || (body.mode !== 'dry-run' && body.mode !== 'apply')) {
      throw new BadRequestException(
        'Field "mode" must be "dry-run" or "apply".',
      );
    }
    const series = body.series
      ? {
          connectorType: String(body.series.connectorType ?? ''),
          marketType: String(body.series.marketType ?? ''),
          symbol: String(body.series.symbol ?? ''),
          interval: toDomainInterval(String(body.series.interval ?? '')),
        }
      : undefined;

    if (series) {
      if (!series.connectorType || !series.marketType || !series.symbol) {
        throw new BadRequestException(
          'Series filter requires connectorType, marketType, symbol, and interval.',
        );
      }
    }

    return this.repairJobOrchestrator.startRepairJob({
      mode: body.mode,
      series,
    });
  }

  @Get('debug/jobs/:jobId/result')
  @ApiOperation({
    summary: 'Get repair/verify job result',
    description:
      'Returns the result payload for a completed (or failed/cancelled) job. 400 if job has no result yet.',
  })
  @ApiParam({ name: 'jobId', description: 'Job ID' })
  @ApiOkResponse({ description: '{ status, ...result }' })
  @ApiNotFoundResponse({ description: 'Job not found' })
  @ApiBadRequestResponse({ description: 'Job has no result yet' })
  getDebugJobResult(@Param('jobId') jobId: string) {
    const job = this.debugJobStore.get(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    if (
      job.status !== 'completed' &&
      job.status !== 'failed' &&
      job.status !== 'cancelled'
    ) {
      throw new BadRequestException(
        `Job ${jobId} has no result yet (status: ${job.status})`,
      );
    }
    return {
      status: job.status,
      ...job.result,
    };
  }

  @Post('debug/jobs/:jobId/cancel')
  @ApiOperation({
    summary: 'Cancel debug job',
    description:
      'Requests cancellation of a repair or verify job. Returns jobId and cancelled flag.',
  })
  @ApiParam({ name: 'jobId', description: 'Job ID' })
  @ApiOkResponse({ description: '{ jobId, cancelled }' })
  @ApiNotFoundResponse({ description: 'Job not found' })
  cancelDebugJob(@Param('jobId') jobId: string) {
    const job = this.debugJobStore.get(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    const cancelled = this.debugJobStore.requestCancel(jobId);
    return { jobId, cancelled };
  }

  @Get('debug/jobs/:jobId')
  @ApiOperation({
    summary: 'Get job status',
    description:
      'Returns status for a repair or verify job (pending, running, completed, failed, cancelled).',
  })
  @ApiParam({ name: 'jobId', description: 'Job ID' })
  @ApiOkResponse({ description: 'Job status object' })
  @ApiNotFoundResponse({ description: 'Job not found' })
  getDebugJobStatus(@Param('jobId') jobId: string) {
    const status = this.debugJobStore.getStatus(jobId);
    if (!status) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    return status;
  }

  @Get('debug/jobs')
  @ApiOperation({
    summary: 'List debug jobs',
    description:
      'Returns list of all repair and verify jobs with their status. Used for monitoring running and completed jobs.',
  })
  @ApiOkResponse({ description: 'Array of job summaries' })
  listDebugJobs() {
    return this.debugJobStore.list();
  }

  @Post('debug/verify')
  @ApiOperation({
    summary: 'Start verify job',
    description:
      'Starts a verification job that scans candle series for integrity issues. Returns jobId and status.',
  })
  @ApiOkResponse({ description: '{ jobId, status }' })
  startVerifyJob() {
    return this.verifyJobOrchestrator.startVerifyJob();
  }

  @Get('debug/verify/jobs')
  @ApiOperation({
    summary: 'List verify jobs',
    description:
      'Returns list of verification jobs (type=verify) with their status.',
  })
  @ApiOkResponse({ description: 'Array of verify job summaries' })
  listVerifyJobs() {
    return this.debugJobStore.list('verify');
  }

  @Get('debug/verify/jobs/:jobId')
  @ApiOperation({
    summary: 'Get verify job status',
    description:
      'Returns status for a verification job. 404 if job not found or not a verify job.',
  })
  @ApiParam({ name: 'jobId', description: 'Verification job ID' })
  @ApiOkResponse({ description: 'Job status object' })
  @ApiNotFoundResponse({ description: 'Verify job not found' })
  getVerifyJobStatus(@Param('jobId') jobId: string) {
    const job = this.debugJobStore.get(jobId);
    if (!job || job.type !== 'verify') {
      throw new NotFoundException(`Verify job ${jobId} not found`);
    }
    const status = this.debugJobStore.getStatus(jobId);
    if (!status) throw new NotFoundException(`Job ${jobId} not found`);
    return status;
  }

  @Get('debug/verify/jobs/:jobId/result')
  @ApiOperation({
    summary: 'Get verify job result',
    description:
      'Returns the result payload for a completed (or failed/cancelled) verification job. 400 if job has no result yet.',
  })
  @ApiParam({ name: 'jobId', description: 'Verification job ID' })
  @ApiOkResponse({ description: '{ status, ...result }' })
  @ApiNotFoundResponse({ description: 'Verify job not found' })
  @ApiBadRequestResponse({ description: 'Job has no result yet' })
  getVerifyJobResult(@Param('jobId') jobId: string) {
    const job = this.debugJobStore.get(jobId);
    if (!job || job.type !== 'verify') {
      throw new NotFoundException(`Verify job ${jobId} not found`);
    }
    if (
      job.status !== 'completed' &&
      job.status !== 'failed' &&
      job.status !== 'cancelled'
    ) {
      throw new BadRequestException(
        `Verify job ${jobId} has no result yet (status: ${job.status})`,
      );
    }
    return {
      status: job.status,
      ...job.result,
    };
  }

  @Post('debug/verify/jobs/:jobId/cancel')
  @ApiOperation({
    summary: 'Cancel verify job',
    description:
      'Requests cancellation of a verification job. Returns jobId and cancelled flag.',
  })
  @ApiParam({ name: 'jobId', description: 'Verification job ID' })
  @ApiOkResponse({ description: '{ jobId, cancelled }' })
  @ApiNotFoundResponse({ description: 'Verify job not found' })
  cancelVerifyJob(@Param('jobId') jobId: string) {
    const job = this.debugJobStore.get(jobId);
    if (!job || job.type !== 'verify') {
      throw new NotFoundException(`Verify job ${jobId} not found`);
    }
    const cancelled = this.debugJobStore.requestCancel(jobId);
    return { jobId, cancelled };
  }

  @Get('debug/integrity/:connectorType/:marketType/:symbol/:interval')
  @ApiOperation({
    summary: 'Integrity audit for one series',
    description:
      'Returns integrity audit (duplicates, gaps, out-of-order) and last candle for the given series. Optional from/to/days for range.',
  })
  @ApiParam({ name: 'connectorType', example: 'BINANCE' })
  @ApiParam({ name: 'marketType', example: 'SPOT' })
  @ApiParam({ name: 'symbol', example: 'BTCUSDT' })
  @ApiParam({ name: 'interval', example: '1m' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'days', required: false })
  @ApiOkResponse({
    description: 'status (ok | degraded), integrity, lastCandle',
  })
  async getCandleIntegrity(
    @Param('connectorType') connectorType: ConnectorType,
    @Param('marketType') marketType: MarketType,
    @Param('symbol') symbol: string,
    @Param('interval') intervalRaw: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('days') days?: string,
  ) {
    const interval = toDomainInterval(intervalRaw) as TimeFrame;
    const toTs = this.parseTimestampQueryParam(to, 'to') ?? Date.now();
    const fromTsInput = this.parseTimestampQueryParam(from, 'from');
    const daysInput = this.parseDaysQueryParam(days);
    const fromTs =
      fromTsInput ??
      (daysInput != null
        ? toTs - daysInput * 24 * 60 * 60 * 1000
        : toTs - 3 * 24 * 60 * 60 * 1000);

    const [integrity, lastCandle] = await Promise.all([
      this.query.loadIntegrityAudit({
        symbol,
        connectorType: String(connectorType),
        marketType: String(marketType),
        interval,
        from: fromTs,
        to: toTs,
      }),
      this.query.loadLastCandle({
        symbol,
        connectorType: String(connectorType),
        marketType: String(marketType),
        interval,
      }),
    ]);

    return {
      status:
        integrity.duplicateRows === 0 &&
        integrity.gapCount === 0 &&
        integrity.outOfOrderCount === 0
          ? 'ok'
          : 'degraded',
      integrity,
      lastCandle,
    };
  }

  @Get('debug/last-candle/:connectorType/:marketType/:symbol/:interval')
  @ApiOperation({
    summary: 'Last candle for series',
    description:
      'Returns the most recent candle for the given connector, market, symbol, and interval.',
  })
  @ApiParam({ name: 'connectorType', example: 'BINANCE' })
  @ApiParam({ name: 'marketType', example: 'SPOT' })
  @ApiParam({ name: 'symbol', example: 'BTCUSDT' })
  @ApiParam({ name: 'interval', example: '1m' })
  @ApiOkResponse({ description: 'Single OHLCV candle', type: CandleDto })
  @ApiNotFoundResponse({ description: 'No candle found for the series' })
  async getLastCandle(
    @Param('connectorType') connectorType: ConnectorType,
    @Param('marketType') marketType: MarketType,
    @Param('symbol') symbol: string,
    @Param('interval') intervalRaw: string,
  ) {
    const interval = toDomainInterval(intervalRaw) as TimeFrame;
    const candle = await this.query.loadLastCandle({
      symbol,
      connectorType: String(connectorType),
      marketType: String(marketType),
      interval,
    });
    if (!candle) {
      throw new NotFoundException(
        `No last candle found for ${symbol} ${connectorType} ${marketType} ${interval}`,
      );
    }
    return candle;
  }

  // =========================================================================
  // 🔹 GET /candles/available-intervals/:connectorType/:marketType/:symbol
  // =========================================================================
  @Get('available-intervals/:connectorType/:marketType/:symbol')
  @ApiOperation({
    summary: 'List available candle intervals for symbol',
    description:
      'Returns intervals for which candle data exists in storage for the given connector, market, and symbol. ' +
      'Used by UI to show only real timeframes on the chart.',
  })
  @ApiParam({
    name: 'connectorType',
    example: 'binance',
    description: 'Connector type',
  })
  @ApiParam({
    name: 'marketType',
    example: 'futures',
    description: 'Market type',
  })
  @ApiParam({
    name: 'symbol',
    example: 'DOGSUSDT',
    description: 'Trading symbol',
  })
  @ApiOkResponse({
    description:
      '{ intervals: string[] } — domain intervals (min1, min5, h1, ...)',
  })
  async getAvailableIntervals(
    @Param('connectorType') connectorType: string,
    @Param('marketType') marketType: string,
    @Param('symbol') symbol: string,
  ): Promise<{ intervals: string[] }> {
    const list = await this.integrityService.getSeries(symbol ?? undefined);
    const normalizedConnector = String(connectorType ?? '').toLowerCase();
    const normalizedMarket = String(marketType ?? '').toLowerCase();
    const filtered = (Array.isArray(list) ? list : []).filter(
      (s) =>
        String(s.connectorType ?? '').toLowerCase() === normalizedConnector &&
        String(s.marketType ?? '').toLowerCase() === normalizedMarket,
    );
    const intervals = [
      ...new Set(
        filtered
          .map((s) => String(s.interval ?? '').toLowerCase())
          .filter(Boolean),
      ),
    ];
    return { intervals };
  }

  // =========================================================================
  // 🔹 GET /candles/:connectorType/:marketType/:symbol/:interval
  // =========================================================================
  @Get(':connectorType/:marketType/:symbol/:interval')
  @ApiOperation({
    summary: 'Get historical candles',
    description:
      'Returns OHLCV candlestick data for a symbol and interval. ' +
      'Used by: detectors, indicators, analytics, strategy engines. Data is retrieved from QuestDB time-series storage.',
  })
  @ApiParam({
    name: 'connectorType',
    example: 'BINANCE',
    description: 'Market data provider connector',
  })
  @ApiParam({
    name: 'marketType',
    example: 'SPOT',
    description: 'Market type such as SPOT or FUTURES',
  })
  @ApiParam({
    name: 'symbol',
    example: 'BTCUSDT',
    description: 'Trading symbol',
  })
  @ApiParam({
    name: 'interval',
    example: '1m',
    description: 'Candle interval (e.g. 1m, min5, h1, day)',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description:
      'Range start. Unix ms or ISO-8601 (e.g. 1771804800000 or 2026-02-23T00:00:00Z).',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description:
      'Range end / anchor. Unix ms or ISO-8601. If omitted, uses latest stored timestamp.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description:
      'Lookback window in days when "from" is not provided. Non-negative number.',
  })
  @ApiOkResponse({
    description: 'List of OHLCV candles',
    type: CandleDto,
    isArray: true,
  })
  @ApiNotFoundResponse({
    description: 'No candles found for the given selector',
  })
  @ApiBadRequestResponse({ description: 'Invalid from/to/days parameters' })
  async getCandles(
    @Param('connectorType') connectorType: ConnectorType,
    @Param('marketType') marketType: MarketType,
    @Param('symbol') symbol: string,
    @Param('interval') intervalRaw: string,

    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('days') days?: string,
  ) {
    // 🔐 ЕДИНСТВЕННАЯ точка нормализации таймфрейма
    const interval = toDomainInterval(intervalRaw) as TimeFrame;
    const fromTsInput = this.parseTimestampQueryParam(from, 'from');
    const toTsInput = this.parseTimestampQueryParam(to, 'to');
    const daysInput = this.parseDaysQueryParam(days);

    let anchorTs: number | null;

    // ---------------------------------------------------------------------
    // Anchor resolution (ЕДИНСТВЕННАЯ точка правды)
    // ---------------------------------------------------------------------

    // 1️⃣ Явно передан `to`
    if (toTsInput !== null) {
      anchorTs = toTsInput;
    }

    // 3️⃣ Initial load → last ts from DB
    else {
      anchorTs = await this.query.loadLastTimestamp({
        symbol,
        connectorType,
        marketType,
        interval,
      });
    }

    if (!anchorTs || !Number.isFinite(anchorTs)) {
      throw new NotFoundException(
        `No candles found for ${symbol} ${connectorType} ${marketType} ${interval}`,
      );
    }

    // ---------------------------------------------------------------------
    // Range resolution
    // ---------------------------------------------------------------------
    const { fromTs, toTs } = this.resolveRange(
      interval,
      anchorTs,
      fromTsInput,
      toTsInput,
      daysInput,
    );

    if (fromTs === null) {
      return [];
    }

    return this.query.loadRangeNormalized({
      connectorType,
      marketType,
      symbol,
      interval,
      from: fromTs,
      to: toTs,
    });
  }

  // =========================================================================
  // 🔹 GET /candles/detector/:detectorSysname/symbol/:symbol/:interval
  // =========================================================================
  @Get('/detector/:detectorSysname/symbol/:symbol/:interval')
  @ApiOperation({
    summary: 'Get candles by detector',
    description:
      'Returns candles for a detector sysname, symbol, and interval. Resolves connector/market from detector config.',
  })
  @ApiParam({ name: 'detectorSysname', description: 'Detector system name' })
  @ApiParam({ name: 'symbol', example: 'BTCUSDT' })
  @ApiParam({ name: 'interval', example: '1m' })
  @ApiOkResponse({
    description: 'List of OHLCV candles',
    type: CandleDto,
    isArray: true,
  })
  async getByDetector(
    @Param('detectorSysname') detectorSysname: string,
    @Param('symbol') symbol: string,
    @Param('interval') intervalRaw: string,
  ) {
    const interval = toDomainInterval(intervalRaw) as TimeFrame;

    return this.candleService.getByDetectorSysname(
      detectorSysname,
      symbol,
      interval,
    );
  }

  // =========================================================================
  // Helpers
  // =========================================================================
  private resolveRange(
    interval: TimeFrame,
    anchorTs: number,
    fromTsInput?: number | null,
    toTsInput?: number | null,
    daysInput?: number | null,
  ): { fromTs: number | null; toTs: number } {
    // ✅ ПРАВАЯ ГРАНИЦА ВСЕГДА = anchorTs (если явно не передали to)
    const toTs =
      toTsInput !== null && toTsInput !== undefined ? toTsInput : anchorTs;

    let fromTs: number;

    if (fromTsInput !== null && fromTsInput !== undefined) {
      fromTs = fromTsInput;
    } else if (daysInput !== null && daysInput !== undefined) {
      fromTs = toTs - daysInput * 24 * 60 * 60 * 1000;
    } else {
      // дефолтные окна
      fromTs =
        interval === TimeFrame.min1
          ? toTs - 6 * 60 * 60 * 1000 // 6 часов
          : toTs - 7 * 24 * 60 * 60 * 1000; // 7 дней
    }

    if (!Number.isFinite(toTs)) {
      throw new BadRequestException(
        'Invalid query parameter "to". Expected unix timestamp in milliseconds or ISO-8601 datetime.',
      );
    }

    if (fromTs > toTs) {
      throw new BadRequestException(
        'Invalid range: "from" must be less than or equal to "to".',
      );
    }

    if (!Number.isFinite(fromTs) || fromTs > toTs) {
      return { fromTs: null, toTs };
    }

    return { fromTs, toTs };
  }

  private parseTimestampQueryParam(
    value: string | undefined,
    paramName: 'from' | 'to',
  ): number | null {
    if (value == null || value.trim() === '') {
      return null;
    }

    const trimmed = value.trim();
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }

    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }

    throw new BadRequestException(
      `Invalid query parameter "${paramName}". Expected unix timestamp in milliseconds or ISO-8601 datetime.`,
    );
  }

  private parseDaysQueryParam(value: string | undefined): number | null {
    if (value == null || value.trim() === '') {
      return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new BadRequestException(
        'Invalid query parameter "days". Expected a non-negative number.',
      );
    }
    return parsed;
  }

  private filterIssueList<T>(
    list: T[],
    connectorType?: string,
    marketType?: string,
    interval?: string,
    limitStr?: string,
    getKey?: (e: T) => {
      connectorType: string;
      marketType: string;
      interval: string;
    },
  ): T[] {
    let out = list;
    if (
      getKey &&
      (connectorType != null || marketType != null || interval != null)
    ) {
      const normInterval =
        interval != null ? String(toDomainInterval(interval)) : null;
      out = list.filter((e) => {
        const k = getKey(e);
        if (connectorType != null && k.connectorType !== connectorType)
          return false;
        if (marketType != null && k.marketType !== marketType) return false;
        if (normInterval != null && String(k.interval) !== normInterval)
          return false;
        return true;
      });
    }
    const limit = limitStr != null ? parseInt(limitStr, 10) : NaN;
    if (Number.isFinite(limit) && limit > 0) {
      out = out.slice(0, limit);
    }
    return out;
  }
}
