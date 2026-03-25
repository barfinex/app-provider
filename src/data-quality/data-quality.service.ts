import { Injectable, Logger, Optional } from '@nestjs/common';
import { BinanceService } from '../connector/datasource/binance/binance.service';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import {
  MARKET_DATA_LAG_WARNING_MS,
  MARKET_DATA_STALE_MS,
  CANDLE_PRIMARY_INTERVAL_MS,
  CANDLE_LAG_OK_MULTIPLIER,
  CANDLE_LAG_WARNING_MULTIPLIER,
} from '../market-data/market-data-retention.service';
import { AdvisorProxyService } from '../advisor-proxy/advisor-proxy.service';
import {
  DataQualityLevel,
  DataMaturityLevel,
  DataQualityIssueCategory,
  type DataQualityIssue,
  type SymbolDataQualityStatus,
  type AdvisorDecisionReadinessStatus,
  type ProviderDataQualityOverviewResponse,
  type ProviderSymbolDataQualityResponse,
  type DataQualityDesktopPayload,
  type AdvisorStatusType,
} from '@barfinex/types';

function toDataQualityLevel(status: string): DataQualityLevel {
  if (status === 'OK') return 'OK' as DataQualityLevel;
  if (status === 'DEGRADED') return 'WARNING' as DataQualityLevel;
  return 'ERROR' as DataQualityLevel;
}

function toMaturityFromHealthScore(healthScore: number): DataMaturityLevel {
  if (healthScore >= 0.9) return 'OPTIMAL' as DataMaturityLevel;
  if (healthScore >= 0.7) return 'READY' as DataMaturityLevel;
  if (healthScore >= 0.4) return 'PARTIAL' as DataMaturityLevel;
  return 'INSUFFICIENT' as DataMaturityLevel;
}

@Injectable()
export class DataQualityService {
  private readonly logger = new Logger(DataQualityService.name);
  private readonly recentErrors: DataQualityIssue[] = [];
  private readonly recentWarnings: DataQualityIssue[] = [];
  private static readonly RECENT_CAP = 50;
  /** Issues older than this are dropped from recentErrors/recentWarnings. */
  private static readonly RECENT_ISSUES_TTL_MS = Math.max(
    60_000,
    Number(process.env.DATA_QUALITY_RECENT_ISSUES_TTL_MS ?? 10 * 60 * 1000),
  );

  constructor(
    private readonly binanceService: BinanceService,
    private readonly reader: QuestDBQueryService,
    @Optional() private readonly advisorProxy?: AdvisorProxyService,
  ) {}

  /**
   * Normalize QuestDB/pg timestamp to ms. Handles: Date, number (ms or µs), ISO string.
   * QuestDB pg wire can return timestamp as number in microseconds.
   */
  private toMs(v: unknown): number | null {
    if (v == null) return null;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return null;
      // QuestDB TIMESTAMP in pg wire may be returned in microseconds
      if (v > 1e15) return Math.round(v / 1000);
      return Math.round(v);
    }
    if (v instanceof Date) return v.getTime();
    const n = new Date(String(v)).getTime();
    return Number.isFinite(n) ? n : null;
  }

  private maxTs(a: number | null, b: number | null): number | null {
    if (a == null) return b ?? null;
    if (b == null) return a;
    return Math.max(a, b);
  }

  private tsSource(questdb: number | null, runtime: number | null): string {
    if (questdb != null && runtime != null) return 'both';
    if (questdb != null) return 'questdb';
    if (runtime != null) return 'runtime';
    return 'none';
  }

  /**
   * Last timestamps from runtime (BinanceService market quality snapshots).
   * Candles: prefer candleEventTimestamp (stream heartbeat) when present so lag = time since last kline event.
   */
  private getRuntimeStreamTimestamps(): {
    trades: number | null;
    orderbook: number | null;
    candles: number | null;
    candlesFromEventTs: boolean;
  } {
    const symbols = this.binanceService.getSymbolsWithMarketQualitySnapshots();
    let tradeTs: number | null = null;
    let obTs: number | null = null;
    let candleTs: number | null = null;
    let candlesFromEventTs = false;
    for (const symbol of symbols) {
      const snapshot = this.binanceService.getMarketQualitySnapshot(symbol);
      if (!snapshot?.timestamps) continue;
      const t = Number(snapshot.timestamps.tradeTimestamp ?? 0);
      const o = Number(snapshot.timestamps.orderbookTimestamp ?? 0);
      const eventTs = Number(snapshot.timestamps.candleEventTimestamp ?? 0);
      const c =
        Number.isFinite(eventTs) && eventTs > 0
          ? eventTs
          : Number(snapshot.timestamps.candleTimestamp ?? 0);
      if (Number.isFinite(eventTs) && eventTs > 0) candlesFromEventTs = true;
      if (Number.isFinite(t) && t > 0)
        tradeTs = tradeTs == null ? t : Math.max(tradeTs, t);
      if (Number.isFinite(o) && o > 0)
        obTs = obTs == null ? o : Math.max(obTs, o);
      if (Number.isFinite(c) && c > 0)
        candleTs = candleTs == null ? c : Math.max(candleTs, c);
    }
    return {
      trades: tradeTs,
      orderbook: obTs,
      candles: candleTs,
      candlesFromEventTs,
    };
  }

  /** Stream status for candles/trades/orderbook: QuestDB lags with runtime fallback. */
  async getStreamStatus(): Promise<{
    candles: {
      status: DataQualityLevel;
      message?: string;
      lagMs?: number | null;
    };
    trades: {
      status: DataQualityLevel;
      message?: string;
      lagMs?: number | null;
    };
    orderbook: {
      status: DataQualityLevel;
      message?: string;
      lagMs?: number | null;
    };
  }> {
    const now = Date.now();
    const [rawTradesLatest, obTopLatest, candleLatest] = await Promise.all([
      this.reader.queryValue(`SELECT max(ts) FROM raw_trades`).catch((e) => {
        this.logger.warn(
          `[STREAM_DEBUG] raw_trades max(ts) query failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return null;
      }),
      this.reader.queryValue(`SELECT max(ts) FROM orderbook_top`).catch((e) => {
        this.logger.warn(
          `[STREAM_DEBUG] orderbook_top max(ts) query failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return null;
      }),
      this.reader.queryValue(`SELECT max(ts) FROM candles`).catch((e) => {
        this.logger.warn(
          `[STREAM_DEBUG] candles max(ts) query failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return null;
      }),
    ]);
    const questdbTradeTs = this.toMs(rawTradesLatest);
    const questdbObTs = this.toMs(obTopLatest);
    const questdbCandleTs = this.toMs(candleLatest);

    const runtime = this.getRuntimeStreamTimestamps();
    const tradeTs = this.maxTs(questdbTradeTs, runtime.trades);
    const obTs = this.maxTs(questdbObTs, runtime.orderbook);
    const candleTs = this.maxTs(questdbCandleTs, runtime.candles);

    const tradeLag = tradeTs != null ? now - tradeTs : null;
    const obLag = obTs != null ? now - obTs : null;
    const candleLag = candleTs != null ? now - candleTs : null;

    const toStatus = (lagMs: number | null): DataQualityLevel => {
      if (lagMs == null) return 'ERROR' as DataQualityLevel;
      if (lagMs >= MARKET_DATA_STALE_MS) return 'ERROR' as DataQualityLevel;
      if (lagMs >= MARKET_DATA_LAG_WARNING_MS)
        return 'WARNING' as DataQualityLevel;
      return 'OK' as DataQualityLevel;
    };
    const toMessage = (
      lagMs: number | null,
      name: string,
    ): string | undefined => {
      if (lagMs == null) return `${name} stream has no data`;
      if (lagMs >= MARKET_DATA_STALE_MS)
        return `${name} stream stale (${Math.round(lagMs / 1000)}s)`;
      if (lagMs >= MARKET_DATA_LAG_WARNING_MS)
        return `${name} stream lagging (${Math.round(lagMs / 1000)}s)`;
      return undefined;
    };

    const okMs = CANDLE_PRIMARY_INTERVAL_MS * CANDLE_LAG_OK_MULTIPLIER;
    const warnMs = CANDLE_PRIMARY_INTERVAL_MS * CANDLE_LAG_WARNING_MULTIPLIER;
    const toCandleStatus = (lagMs: number | null): DataQualityLevel => {
      if (lagMs == null) return 'ERROR' as DataQualityLevel;
      if (lagMs > warnMs) return 'ERROR' as DataQualityLevel;
      if (lagMs > okMs) return 'WARNING' as DataQualityLevel;
      return 'OK' as DataQualityLevel;
    };
    const toCandleMessage = (lagMs: number | null): string | undefined => {
      if (lagMs == null) return 'Candles stream has no data';
      if (lagMs > warnMs)
        return `Candles stream stale (${Math.round(lagMs / 1000)}s)`;
      if (lagMs > okMs)
        return `Candles stream lagging (${Math.round(lagMs / 1000)}s)`;
      return undefined;
    };

    const candleStatus = toCandleStatus(candleLag);
    const candleMessage = toCandleMessage(candleLag);

    this.logger.debug({
      stream: 'getStreamStatus',
      candles: {
        lastTimestamp: candleTs,
        now,
        diffSeconds: candleLag != null ? Math.round(candleLag / 1000) : null,
        source: this.tsSource(questdbCandleTs, runtime.candles),
        fromEventTs: runtime.candlesFromEventTs,
      },
      trades: {
        lastTimestamp: tradeTs,
        now,
        diffSeconds: tradeLag != null ? Math.round(tradeLag / 1000) : null,
        source: this.tsSource(questdbTradeTs, runtime.trades),
      },
      orderbook: {
        lastTimestamp: obTs,
        now,
        diffSeconds: obLag != null ? Math.round(obLag / 1000) : null,
        source: this.tsSource(questdbObTs, runtime.orderbook),
      },
    });

    return {
      candles: {
        status: candleStatus,
        message: candleMessage,
        lagMs: candleLag,
      },
      trades: {
        status: toStatus(tradeLag),
        message: toMessage(tradeLag, 'Trades'),
        lagMs: tradeLag,
      },
      orderbook: {
        status: toStatus(obLag),
        message: toMessage(obLag, 'Orderbook'),
        lagMs: obLag,
      },
    };
  }

  async getSymbolDataQuality(
    symbol: string,
  ): Promise<SymbolDataQualityStatus | null> {
    const normalized = String(symbol || '')
      .trim()
      .toUpperCase();
    if (!normalized) return null;
    const snapshot = this.binanceService.getMarketQualitySnapshot(normalized);
    const report = snapshot
      ? this.binanceService.getMarketQualityReport(normalized, snapshot)
      : null;
    const now = Date.now();

    if (!report) {
      const suggestedAction = 'reload_candle_history';
      const status: SymbolDataQualityStatus = {
        symbol: normalized,
        level: 'ERROR' as DataQualityLevel,
        maturity: 'INSUFFICIENT' as DataMaturityLevel,
        issues: [
          {
            category: DataQualityIssueCategory.missing_data,
            message: 'No market data snapshot for symbol',
            severity: 'critical',
            symbol: normalized,
            evaluatedAt: now,
            remediationHint: suggestedAction,
          },
        ],
        warnings: [],
        evaluatedAt: now,
        advisorEligible: false,
      };
      this.pushRecent(status.issues, true);
      return status;
    }

    const issues: DataQualityIssue[] = report.issues.map((iss) => ({
      category: (iss.code ?? iss.component) as DataQualityIssueCategory,
      component: iss.component,
      code: iss.code,
      message: iss.message,
      severity: iss.severity,
      field: iss.field,
      value: iss.value,
      symbol: normalized,
      evaluatedAt: now,
      remediationHint: this.resolveSuggestedAction(iss.code ?? iss.message),
      suggestedAction: this.resolveSuggestedAction(iss.code ?? iss.message),
      blocking: iss.blocking,
    }));
    const blockingIssues = issues.filter((i) => i.blocking !== false);
    const criticalCount = blockingIssues.filter(
      (i) => i.severity === 'critical',
    ).length;
    const level: DataQualityLevel =
      criticalCount > 0
        ? 'ERROR'
        : blockingIssues.length > 0
        ? 'WARNING'
        : 'OK';
    const maturity = toMaturityFromHealthScore(report.healthScore);
    const advisorEligible = report.valid && !report.critical;

    if (blockingIssues.some((i) => i.severity === 'critical'))
      this.pushRecent(
        blockingIssues.filter((i) => i.severity === 'critical'),
        true,
      );
    if (blockingIssues.some((i) => i.severity === 'warning'))
      this.pushRecent(
        blockingIssues.filter((i) => i.severity === 'warning'),
        false,
      );

    this.logger.debug(
      `[data_quality] symbol=${normalized} level=${level} maturity=${maturity} advisorEligible=${advisorEligible} issueCount=${issues.length}`,
    );

    return {
      symbol: normalized,
      level,
      maturity,
      issues,
      warnings: report.reasons ?? [],
      lastDataTimestamp:
        Math.max(
          Number(snapshot?.timestamps?.orderbookTimestamp ?? 0),
          Number(snapshot?.timestamps?.tradeTimestamp ?? 0),
          Number(snapshot?.timestamps?.candleTimestamp ?? 0),
        ) || undefined,
      evaluatedAt: now,
      advisorEligible,
      candles: {
        status: toDataQualityLevel(report.candleStatus),
        message:
          report.reasons?.find((r) => r.startsWith('candles:')) ?? undefined,
        count:
          snapshot?.candlesCountH1 != null
            ? snapshot.candlesCountH1 +
              (snapshot.candlesCountH4 ?? 0) +
              (snapshot.candlesCountD1 ?? 0)
            : undefined,
      },
      trades: {
        status: toDataQualityLevel(report.tradeStatus),
        message:
          report.reasons?.find((r) => r.startsWith('trades:')) ?? undefined,
        lastTimestamp:
          Number(snapshot?.timestamps?.tradeTimestamp ?? 0) || undefined,
      },
      orderbook: {
        status: toDataQualityLevel(report.orderbookStatus),
        message:
          report.reasons?.find((r) => r.startsWith('orderbook:')) ?? undefined,
        lastTimestamp:
          Number(snapshot?.timestamps?.orderbookTimestamp ?? 0) || undefined,
      },
      indicators: {
        status: toDataQualityLevel(report.derivedMetricsStatus),
        message:
          report.reasons?.find(
            (r) => r.includes('derived') || r.includes('freshness'),
          ) ?? undefined,
      },
    };
  }

  async getOverview(): Promise<ProviderDataQualityOverviewResponse> {
    this.trimRecentByTtl();
    const now = Date.now();
    const streamStatus = await this.getStreamStatus();
    const symbols = this.binanceService.getSymbolsWithMarketQualitySnapshots();
    const symbolStatuses: SymbolDataQualityStatus[] = [];
    let blockedCount = 0;
    let warningCount = 0;
    for (const symbol of symbols.slice(0, 200)) {
      const s = await this.getSymbolDataQuality(symbol);
      if (s) {
        symbolStatuses.push(s);
        if (!s.advisorEligible) blockedCount += 1;
        if (s.level === 'WARNING') warningCount += 1;
      }
    }
    const advisorReadiness = await this.fetchAdvisorReadiness();
    const overallStatus: DataQualityLevel =
      streamStatus.trades.status === 'ERROR' ||
      streamStatus.orderbook.status === 'ERROR'
        ? 'ERROR'
        : streamStatus.trades.status === 'WARNING' ||
          streamStatus.orderbook.status === 'WARNING'
        ? 'WARNING'
        : 'OK';
    const advisorStatus: AdvisorStatusType =
      advisorReadiness === null
        ? 'UNKNOWN'
        : advisorReadiness.length === 0
        ? 'READY'
        : advisorReadiness.every((r: AdvisorDecisionReadinessStatus) => r.ready)
        ? 'READY'
        : 'NOT_READY';

    const recentErrorsFiltered = this.getRecentIssuesFiltered(
      this.recentErrors,
      20,
    );
    const recentWarningsFiltered = this.getRecentIssuesFiltered(
      this.recentWarnings,
      20,
    );
    const recentErrorsActive = this.filterActiveIssues(
      recentErrorsFiltered,
      symbolStatuses,
    );
    const recentWarningsActive = this.filterActiveIssues(
      recentWarningsFiltered,
      symbolStatuses,
    );

    return {
      systemSummary: {
        overallStatus,
        advisorStatus,
        blockedSymbolCount: blockedCount,
        warningCount,
        symbolCount: symbolStatuses.length,
        lastRefresh: now,
      },
      providerStreams: {
        candles: {
          status: streamStatus.candles.status,
          message: streamStatus.candles.message,
        },
        trades: {
          status: streamStatus.trades.status,
          message: streamStatus.trades.message,
        },
        orderbook: {
          status: streamStatus.orderbook.status,
          message: streamStatus.orderbook.message,
        },
      },
      symbols: symbolStatuses,
      advisorReadiness: Array.isArray(advisorReadiness)
        ? advisorReadiness
        : undefined,
      recentErrors: recentErrorsActive,
      recentWarnings: recentWarningsActive,
    };
  }

  async getSymbol(
    symbol: string,
  ): Promise<ProviderSymbolDataQualityResponse | null> {
    const status = await this.getSymbolDataQuality(symbol);
    if (!status) return null;
    const advisorReadiness = await this.fetchAdvisorReadinessForSymbol(symbol);
    return {
      ...status,
      advisorReadiness: advisorReadiness ?? null,
      issues: status.issues,
    };
  }

  async getIssues(): Promise<DataQualityIssue[]> {
    this.trimRecentByTtl();
    const symbols = this.binanceService.getSymbolsWithMarketQualitySnapshots();
    const all: DataQualityIssue[] = [
      ...this.recentErrors,
      ...this.recentWarnings,
    ];
    for (const symbol of symbols.slice(0, 100)) {
      const s = await this.getSymbolDataQuality(symbol);
      if (s?.issues?.length) all.push(...s.issues);
    }
    return all
      .filter(
        (a, i, arr) =>
          arr.findIndex(
            (b) => b.message === a.message && b.symbol === a.symbol,
          ) === i,
      )
      .sort((a, b) => (b.evaluatedAt ?? 0) - (a.evaluatedAt ?? 0))
      .slice(0, 100);
  }

  async getAdvisorReadiness(): Promise<
    AdvisorDecisionReadinessStatus[] | null
  > {
    return this.fetchAdvisorReadiness();
  }

  async getDesktop(): Promise<DataQualityDesktopPayload> {
    const overview = await this.getOverview();
    const advisorReadiness = overview.advisorReadiness ?? [];
    const blockedSymbols: DataQualityDesktopPayload['blockedSymbols'] = (
      overview.symbols ?? []
    )
      .filter((s) => !s.advisorEligible)
      .map((s) => ({
        symbol: s.symbol,
        primaryReason: s.issues?.[0]?.message ?? 'data_quality',
        reasons: s.issues?.map((i) => i.message) ?? s.warnings ?? [],
        missingFields: undefined as string[] | undefined,
        suggestedAction: this.resolveSuggestedAction(
          s.issues?.[0]?.code ?? s.issues?.[0]?.message ?? 'missing_data',
        ),
      }));
    const bySymbol = Array.isArray(advisorReadiness) ? advisorReadiness : [];
    for (const readiness of bySymbol.filter((item) => item.blocked)) {
      if (blockedSymbols.some((item) => item.symbol === readiness.symbol))
        continue;
      blockedSymbols.push({
        symbol: readiness.symbol,
        primaryReason:
          readiness.decisionBlockReason ??
          readiness.reasons?.[0] ??
          'decision_blocked',
        reasons: readiness.reasons ?? [],
        missingFields: readiness.missingFields,
        invalidValues: readiness.invalidValues,
        nanFields: readiness.nanFields,
        suggestedAction:
          readiness.suggestedAction ??
          this.resolveSuggestedAction(
            readiness.decisionBlockReason ?? readiness.reasons?.[0],
          ),
      });
    }
    const ready = bySymbol.filter((r) => r.ready).length;
    const blocked = bySymbol.filter((r) => r.blocked).length;
    const degraded = bySymbol.filter((r) => !r.ready && !r.blocked).length;

    const indicatorReadiness: DataQualityDesktopPayload['indicatorReadiness'] =
      {};
    for (const s of overview.symbols ?? []) {
      if (s.indicators?.status) {
        const key = s.indicators.status;
        if (!indicatorReadiness[key])
          indicatorReadiness[key] = {
            status: key as DataQualityLevel,
            symbolsReady: 0,
            symbolsTotal: 0,
          };
        indicatorReadiness[key].symbolsTotal += 1;
        if (s.indicators.status === 'OK')
          indicatorReadiness[key].symbolsReady += 1;
      }
    }

    const symbolDrilldown: NonNullable<
      DataQualityDesktopPayload['symbolDrilldown']
    > = {};
    for (const readiness of bySymbol) {
      symbolDrilldown[readiness.symbol] = {
        symbol: readiness.symbol,
        featureReadiness: readiness.ready
          ? 'READY'
          : readiness.blocked
          ? 'BLOCKED'
          : 'WARNING',
        missingInputs: readiness.missingFields ?? [],
        blockReasons: readiness.reasons ?? [],
        timestamps: {
          lastValidatedAt: readiness.lastValidatedAt,
          lastBlockedAt: readiness.lastBlockedAt,
          lastSuccessfulDecisionAt: readiness.lastSuccessfulDecisionAt,
        },
        rootCauses: [
          ...(readiness.missingFields ?? []).map(
            (field) => `missing_feature:${field}`,
          ),
          ...(readiness.validationErrors ?? []).slice(0, 8),
        ],
        suggestedAction:
          readiness.suggestedAction ??
          this.resolveSuggestedAction(
            readiness.decisionBlockReason ?? readiness.reasons?.[0],
          ),
      };
    }

    return {
      systemSummary: overview.systemSummary,
      providerStreams: overview.providerStreams,
      symbolLevel: overview.symbols ?? [],
      indicatorReadiness:
        Object.keys(indicatorReadiness).length > 0
          ? indicatorReadiness
          : undefined,
      advisorReadiness: {
        ready,
        blocked,
        degraded,
        bySymbol,
        lastRefresh: overview.systemSummary.lastRefresh,
      },
      blockedSymbols,
      symbolDrilldown,
      recentErrors: overview.recentErrors ?? [],
      recentWarnings: overview.recentWarnings ?? [],
      lastRefresh: overview.systemSummary.lastRefresh,
    };
  }

  private pushRecent(issues: DataQualityIssue[], isError: boolean): void {
    this.trimRecentByTtl();
    const target = isError ? this.recentErrors : this.recentWarnings;
    const now = Date.now();
    for (const i of issues) {
      target.push({ ...i, evaluatedAt: i.evaluatedAt ?? now });
      if (target.length > DataQualityService.RECENT_CAP) target.shift();
    }
  }

  private trimRecentByTtl(): void {
    const cutoff = Date.now() - DataQualityService.RECENT_ISSUES_TTL_MS;
    for (const arr of [this.recentErrors, this.recentWarnings]) {
      while (arr.length > 0 && (arr[0]?.evaluatedAt ?? 0) < cutoff) arr.shift();
    }
  }

  /**
   * Returns recent issues with TTL filter (drop too old) and dedupe by (symbol, code/message) keeping latest.
   */
  private getRecentIssuesFiltered(
    list: DataQualityIssue[],
    cap: number,
  ): DataQualityIssue[] {
    const cutoff = Date.now() - DataQualityService.RECENT_ISSUES_TTL_MS;
    const byKey = new Map<string, DataQualityIssue>();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const issue = list[i]!;
      const at = issue.evaluatedAt ?? 0;
      if (at < cutoff) continue;
      const key = `${issue.symbol ?? ''}|${issue.code ?? ''}|${(
        issue.message ?? ''
      ).slice(0, 80)}`;
      if (!byKey.has(key)) byKey.set(key, issue);
    }
    return Array.from(byKey.values())
      .sort((a, b) => (b.evaluatedAt ?? 0) - (a.evaluatedAt ?? 0))
      .slice(0, cap);
  }

  /**
   * Keeps only issues that are still active for the symbol (symbol still has ERROR/WARNING and has matching issue code).
   * If symbol is not in symbolStatuses or symbol is OK and no matching issue, the recent issue is considered resolved and excluded.
   */
  private filterActiveIssues(
    issues: DataQualityIssue[],
    symbolStatuses: SymbolDataQualityStatus[],
  ): DataQualityIssue[] {
    const bySymbol = new Map<string, SymbolDataQualityStatus>();
    for (const s of symbolStatuses) bySymbol.set(s.symbol, s);
    return issues.filter((issue) => {
      const sym = issue.symbol;
      if (!sym) return true;
      const status = bySymbol.get(sym);
      if (!status) return true;
      if (status.level === 'OK' && !status.issues?.length) return false;
      const code = issue.code ?? '';
      const stillHasIssue = status.issues?.some(
        (i) =>
          (i.code && i.code === code) ||
          (issue.message && i.message === issue.message),
      );
      return stillHasIssue;
    });
  }

  private async fetchAdvisorReadiness(): Promise<
    AdvisorDecisionReadinessStatus[] | null
  > {
    if (!this.advisorProxy) return null;
    try {
      const result = await this.advisorProxy.get(
        'data-quality/readiness',
        undefined,
        undefined,
      );
      if (result.status === 200 && Array.isArray(result.data)) {
        return (result.data as AdvisorDecisionReadinessStatus[]).map((r) => ({
          ...r,
          lastValidatedAt: r.lastValidatedAt ?? Date.now(),
        }));
      }
      const statusResult = await this.advisorProxy.get(
        'status',
        undefined,
        undefined,
      );
      if (
        statusResult.status === 200 &&
        statusResult.data &&
        typeof statusResult.data === 'object'
      ) {
        const data = statusResult.data as {
          symbols?: Record<string, { ready?: boolean; reason?: string }>;
        };
        if (data.symbols && typeof data.symbols === 'object') {
          return Object.entries(data.symbols).map(([symbol, v]) => ({
            symbol,
            ready: Boolean(v?.ready),
            blocked: !v?.ready,
            reasons: v?.reason ? [v.reason] : [],
            lastValidatedAt: Date.now(),
          }));
        }
      }
    } catch (e) {
      this.logger.warn(
        `[data-quality] Advisor readiness fetch failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    return null;
  }

  private async fetchAdvisorReadinessForSymbol(
    symbol: string,
  ): Promise<AdvisorDecisionReadinessStatus | null> {
    const all = await this.fetchAdvisorReadiness();
    if (!Array.isArray(all)) return null;
    return (
      all.find((r) => r.symbol.toUpperCase() === symbol.toUpperCase()) ?? null
    );
  }

  private resolveSuggestedAction(reason: unknown): string | undefined {
    const normalized = String(reason || '')
      .trim()
      .toLowerCase();
    if (!normalized) return undefined;
    if (
      normalized.includes('orderbook') ||
      normalized.includes('stream_stale') ||
      normalized.includes('required_stream_stale')
    ) {
      return 'reconnect_orderbook_stream';
    }
    if (normalized.includes('candle') || normalized.includes('history')) {
      return 'reload_candle_history';
    }
    if (
      normalized.includes('indicator') ||
      normalized.includes('feature') ||
      normalized.includes('nan')
    ) {
      return 'recompute_indicators';
    }
    return undefined;
  }
}
