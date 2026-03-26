import { Injectable } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { ExchangeRedisService } from '../connector/datasource/exchange/core/exchange-redis.service';
import { BinanceWsManager } from '@barfinex/exchange-binance';
import { QuestDBWriteService } from '../questdb/questdb-write.service';
import { QuestDBDDLService } from '../questdb/questdb-ddl.service';
import { ProviderMarketdataMetricsService } from './provider-marketdata-metrics.service';

type McpSupervisorState =
  | 'starting'
  | 'running'
  | 'restarting'
  | 'cooldown'
  | 'stopping'
  | 'unknown';

@Injectable()
export class ProviderRuntimeHealthService {
  private readonly bootedAtMs = Date.now();
  private readonly mcpSupervisorStatusFile =
    process.env.PROVIDER_MCP_SUPERVISOR_STATUS_FILE ||
    resolve(process.cwd(), '.runtime/provider-mcp-supervisor.json');
  private readonly mcpSupervisorStaleMs = Math.max(
    1000,
    Number(process.env.PROVIDER_MCP_SUPERVISOR_STALE_MS || 15_000),
  );
  private readonly lagWarnMs = Math.max(
    100,
    Number(process.env.PROVIDER_ALERT_MARKETDATA_LAG_MS_WARN || 10_000),
  );
  private readonly redisQueueWarnSize = Math.max(
    1,
    Number(process.env.PROVIDER_ALERT_REDIS_EMIT_QUEUE_SIZE_WARN || 1_000),
  );
  private readonly questdbBufferWarnSize = Math.max(
    1,
    Number(process.env.PROVIDER_ALERT_QUESTDB_BUFFER_SIZE_WARN || 10_000),
  );
  private readonly redisDroppedEventsWarn = Math.max(
    0,
    Number(process.env.PROVIDER_ALERT_REDIS_DROPPED_EVENTS_WARN || 1),
  );
  private readonly questdbDroppedRowsWarn = Math.max(
    0,
    Number(process.env.PROVIDER_ALERT_QUESTDB_DROPPED_ROWS_WARN || 1),
  );
  private readonly wsReconnectAttemptsWarn = Math.max(
    1,
    Number(process.env.PROVIDER_ALERT_WS_RECONNECT_ATTEMPTS_WARN || 25),
  );
  private readonly walReadinessStrict =
    String(
      process.env.QUESTDB_STOP_ON_WAL_SUSPENDED ||
        (String(process.env.NODE_ENV || '').toLowerCase() === 'production'
          ? 'true'
          : 'false'),
    ).toLowerCase() === 'true';

  constructor(
    private readonly redis: ExchangeRedisService,
    private readonly questdbWriter: QuestDBWriteService,
    private readonly questdbDdl: QuestDBDDLService,
    private readonly wsManager: BinanceWsManager,
    private readonly marketdataMetrics: ProviderMarketdataMetricsService,
  ) {}

  getLivenessSnapshot() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSec: Math.floor((Date.now() - this.bootedAtMs) / 1_000),
    };
  }

  async getReadinessSnapshot() {
    const redisMetrics = this.redis.getMetrics();
    const questdbMetrics = this.questdbWriter.getMetrics();
    const wsMetrics = this.wsManager.getStreamHealth();
    const mcpSupervisorState = await this.readMcpSupervisorState();
    const lagSummary = await this.marketdataMetrics.getLagSummary();
    const walStatus = this.questdbDdl.getWalSuspensionStatus();

    const reconnectAttempts = wsMetrics.streams.reduce(
      (total, stream) => total + stream.reconnectCount,
      0,
    );
    const hasWsStall = wsMetrics.streams.some(
      (stream) => stream.lastMessageAgeMs > stream.stallThresholdMs,
    );
    const degradedChecks: string[] = [];

    if (!questdbMetrics.questdb_writer_connected.total)
      degradedChecks.push('questdbDisconnected');
    if (walStatus.suspended) degradedChecks.push('questdbWalSuspended');
    if (mcpSupervisorState !== 'running')
      degradedChecks.push(`mcpSupervisorState:${mcpSupervisorState}`);
    if (hasWsStall) degradedChecks.push('streamStallDetected');
    if (lagSummary.maxLagMs >= this.lagWarnMs)
      degradedChecks.push('marketdataLagHigh');

    const readinessGreen =
      redisMetrics.connected === 1 &&
      (!this.walReadinessStrict || !walStatus.suspended);
    return {
      ready: readinessGreen,
      status: readinessGreen ? 'ready' : 'not_ready',
      degraded: degradedChecks.length > 0,
      degradedChecks,
      checks: {
        redisConnected: redisMetrics.connected === 1,
        questdbConnected: questdbMetrics.questdb_writer_connected.total === 1,
        questdbWalSuspended: walStatus.suspended,
        questdbWalSuspendedSince: walStatus.detectedAt,
        mcpSupervisorState,
        websocketStreamsConnected: wsMetrics.connected,
        websocketStreamsTotal: wsMetrics.total,
        websocketReconnectAttempts: reconnectAttempts,
      },
      timestamp: new Date().toISOString(),
    };
  }

  async getHealthSnapshot() {
    const redisMetrics = this.redis.getMetrics();
    const questdbMetrics = this.questdbWriter.getMetrics();
    const questdbWriterHealth = this.questdbWriter.getWriterHealth();
    const wsMetrics = this.wsManager.getStreamHealth();
    const mcpSupervisorState = await this.readMcpSupervisorState();
    const lagSummary = await this.marketdataMetrics.getLagSummary();
    const walStatus = this.questdbDdl.getWalSuspensionStatus();
    const reconnectAttempts = wsMetrics.streams.reduce(
      (total, stream) => total + stream.reconnectCount,
      0,
    );
    const droppedRows = questdbMetrics.questdb_writer_dropped_rows.total;
    const droppedEvents = redisMetrics.droppedQueuedEvents;

    return {
      redisConnected: redisMetrics.connected === 1,
      questdbConnected: questdbMetrics.questdb_writer_connected.total === 1,
      questdbWalSuspended: walStatus.suspended,
      questdbWalSuspendedSince: walStatus.detectedAt,
      mcpSupervisorState,
      websocketStreamsConnected: wsMetrics.connected,
      websocketStreamsTotal: wsMetrics.total,
      websocketReconnectAttempts: reconnectAttempts,
      websocketStreams: wsMetrics.streams,
      redisEmitQueueSize: redisMetrics.emitQueueSize,
      redisDroppedEvents: droppedEvents,
      redisReconnectAttempt: redisMetrics.reconnectAttempt,
      questdbBufferSize: questdbMetrics.questdb_writer_buffer_size.total,
      questdbDroppedRows: droppedRows,
      questdbReconnectAttempts:
        questdbMetrics.questdb_writer_reconnect_attempts.total,
      /** Writer health snapshot for diagnostics: queue, circuit, backpressure, batch. */
      questdbWriterHealth: {
        queueSize: questdbWriterHealth.queueSize,
        queueCapacity: questdbWriterHealth.queueCapacity,
        reconnectAttempts: questdbWriterHealth.reconnectAttempts,
        circuitState: questdbWriterHealth.circuitState,
        backpressureState: questdbWriterHealth.backpressureState,
        batchSizeCurrent: questdbWriterHealth.batchSizeCurrent,
      },
      provider_marketdata_lag_ms: lagSummary,
      thresholds: {
        provider_marketdata_lag_ms: this.lagWarnMs,
        redisEmitQueueSize: this.redisQueueWarnSize,
        questdbBufferSize: this.questdbBufferWarnSize,
        redisDroppedEvents: this.redisDroppedEventsWarn,
        questdbDroppedRows: this.questdbDroppedRowsWarn,
        websocketReconnectAttempts: this.wsReconnectAttemptsWarn,
      },
      alerts: {
        provider_marketdata_lag_ms: lagSummary.maxLagMs >= this.lagWarnMs,
        redisEmitQueueSize:
          redisMetrics.emitQueueSize >= this.redisQueueWarnSize,
        questdbBufferSize:
          questdbMetrics.questdb_writer_buffer_size.total >=
          this.questdbBufferWarnSize,
        redisDroppedEvents: droppedEvents >= this.redisDroppedEventsWarn,
        questdbDroppedRows: droppedRows >= this.questdbDroppedRowsWarn,
        websocketReconnectAttempts:
          reconnectAttempts >= this.wsReconnectAttemptsWarn,
      },
    };
  }

  private async readMcpSupervisorState(): Promise<McpSupervisorState> {
    try {
      const raw = await readFile(this.mcpSupervisorStatusFile, 'utf8');
      const parsed = JSON.parse(raw) as {
        state?: string;
        updatedAt?: string;
      };
      const updatedAt = Date.parse(parsed.updatedAt || '');
      if (
        !Number.isFinite(updatedAt) ||
        Date.now() - updatedAt > this.mcpSupervisorStaleMs
      ) {
        return 'unknown';
      }

      const state = parsed.state;
      if (
        state === 'starting' ||
        state === 'running' ||
        state === 'restarting' ||
        state === 'cooldown' ||
        state === 'stopping'
      ) {
        return state;
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
