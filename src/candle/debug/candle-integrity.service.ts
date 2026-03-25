import { Injectable, Logger } from '@nestjs/common';
import { TimeFrame } from '@barfinex/types';
import { CandleQueryService } from '../candle-query.service';
import {
  CandleSeriesKey,
  CandleSeriesIntegrityReport,
  CandleIntegrityAudit,
} from '../candle-query.service';
import { ms } from '../time/time.utils';

export interface IntegrityDiagnostics {
  /** Global stats across all series */
  totalRows: number;
  seriesCount: number;
  duplicateRowsTotal: number;
  gapCountTotal: number;
  outOfOrderCountTotal: number;
  /** Per-series summary */
  series: Array<{
    key: CandleSeriesKey;
    totalRows: number;
    duplicateRows: number;
    gapCount: number;
    outOfOrderCount: number;
    missingRangesCount: number;
    startTs: number | null;
    endTs: number | null;
    intervalAligned: boolean;
  }>;
  /** Timestamp of this scan */
  scannedAt: string;
}

export interface DuplicateEntry {
  symbol: string;
  interval: TimeFrame;
  connectorType: string;
  marketType: string;
  ts: string;
  tsMs: number;
  count: number;
}

export interface GapEntry {
  symbol: string;
  interval: TimeFrame;
  connectorType: string;
  marketType: string;
  from: number;
  to: number;
  fromIso: string;
  toIso: string;
}

export interface OutOfOrderEntry {
  symbol: string;
  interval: TimeFrame;
  connectorType: string;
  marketType: string;
  ts: number;
  prevTs: number;
  tsIso: string;
}

@Injectable()
export class CandleIntegrityService {
  private readonly logger = new Logger(CandleIntegrityService.name);

  constructor(private readonly query: CandleQueryService) {}

  /**
   * Scan all series and return structured diagnostics (duplicates, gaps, out-of-order, interval alignment).
   */
  async scanDiagnostics(): Promise<IntegrityDiagnostics> {
    const seriesList = await this.query.loadAllSeriesKeys();
    const series: IntegrityDiagnostics['series'] = [];
    let duplicateRowsTotal = 0;
    let gapCountTotal = 0;
    let outOfOrderCountTotal = 0;
    let totalRows = 0;

    for (const key of seriesList) {
      const report = await this.query.loadSeriesIntegrityReport(key);
      totalRows += report.totalRows;
      duplicateRowsTotal += report.duplicateRows;
      gapCountTotal += report.gapCount;
      outOfOrderCountTotal += report.outOfOrderCount;

      const intervalMs = ms(key.interval);
      const aligned = this.checkIntervalAlignment(report, intervalMs);

      series.push({
        key,
        totalRows: report.totalRows,
        duplicateRows: report.duplicateRows,
        gapCount: report.gapCount,
        outOfOrderCount: report.outOfOrderCount,
        missingRangesCount: report.missingRanges?.length ?? 0,
        startTs: report.startTimestamp,
        endTs: report.endTimestamp,
        intervalAligned: aligned,
      });
    }

    return {
      totalRows,
      seriesCount: seriesList.length,
      duplicateRowsTotal,
      gapCountTotal,
      outOfOrderCountTotal,
      series,
      scannedAt: new Date().toISOString(),
    };
  }

  /**
   * Return duplicate buckets across all series or for a single symbol.
   */
  async getDuplicates(symbol?: string): Promise<DuplicateEntry[]> {
    const seriesList = symbol
      ? await this.query
          .loadAllSeriesKeys()
          .then((list) => list.filter((s) => s.symbol === symbol))
      : await this.query.loadAllSeriesKeys();

    const out: DuplicateEntry[] = [];
    for (const key of seriesList) {
      const timestamps = await this.query.loadDuplicateTimestamps(key);
      for (const tsMs of timestamps) {
        const countResult = await this.query.loadSeriesRowsAtTimestamp({
          ...key,
          timestampMs: tsMs,
        });
        const count = countResult.length;
        if (count > 1) {
          out.push({
            symbol: key.symbol,
            interval: key.interval,
            connectorType: key.connectorType,
            marketType: key.marketType,
            ts: new Date(tsMs).toISOString(),
            tsMs,
            count,
          });
        }
      }
    }
    return out;
  }

  /**
   * Return gap ranges across all series or for a single symbol.
   */
  async getGaps(symbol?: string, maxRanges = 500): Promise<GapEntry[]> {
    const seriesList = symbol
      ? await this.query
          .loadAllSeriesKeys()
          .then((list) => list.filter((s) => s.symbol === symbol))
      : await this.query.loadAllSeriesKeys();

    const out: GapEntry[] = [];
    for (const key of seriesList) {
      const report = await this.query.loadSeriesIntegrityReport({
        ...key,
        maxMissingRanges: Math.min(2000, Math.max(50, maxRanges)),
      });
      for (const range of report.missingRanges ?? []) {
        out.push({
          symbol: key.symbol,
          interval: key.interval,
          connectorType: key.connectorType,
          marketType: key.marketType,
          from: range.from,
          to: range.to,
          fromIso: new Date(range.from).toISOString(),
          toIso: new Date(range.to).toISOString(),
        });
      }
    }
    return out;
  }

  /**
   * Out-of-order: currently integrity report uses GROUP BY ts so row order is lost;
   * we return series that report outOfOrderCount > 0 (placeholder entries).
   */
  async getOutOfOrder(symbol?: string): Promise<OutOfOrderEntry[]> {
    const seriesList = symbol
      ? await this.query
          .loadAllSeriesKeys()
          .then((list) => list.filter((s) => s.symbol === symbol))
      : await this.query.loadAllSeriesKeys();

    const out: OutOfOrderEntry[] = [];
    for (const key of seriesList) {
      const report = await this.query.loadSeriesIntegrityReport(key);
      if (report.outOfOrderCount > 0) {
        out.push({
          symbol: key.symbol,
          interval: key.interval,
          connectorType: key.connectorType,
          marketType: key.marketType,
          ts: report.endTimestamp ?? 0,
          prevTs: report.startTimestamp ?? 0,
          tsIso: new Date(report.endTimestamp ?? 0).toISOString(),
        });
      }
    }
    return out;
  }

  /**
   * Diagnostics for a single symbol (all intervals/connectors for that symbol).
   */
  async getDiagnosticsForSymbol(symbol: string): Promise<{
    symbol: string;
    series: CandleSeriesIntegrityReport[];
    audits: CandleIntegrityAudit[];
    scannedAt: string;
  }> {
    const seriesList = await this.query
      .loadAllSeriesKeys()
      .then((list) => list.filter((s) => s.symbol === symbol));
    const series: CandleSeriesIntegrityReport[] = [];
    const audits: CandleIntegrityAudit[] = [];

    for (const key of seriesList) {
      const report = await this.query.loadSeriesIntegrityReport(key);
      series.push(report);
      if (report.startTimestamp != null && report.endTimestamp != null) {
        const audit = await this.query.loadIntegrityAudit({
          symbol: key.symbol,
          connectorType: key.connectorType,
          marketType: key.marketType,
          interval: key.interval,
          from: report.startTimestamp,
          to: report.endTimestamp,
          maxGapSamples: 20,
          maxDuplicateSamples: 20,
        });
        audits.push(audit);
      }
    }

    return {
      symbol,
      series,
      audits,
      scannedAt: new Date().toISOString(),
    };
  }

  /**
   * Return per-series summary: symbol, interval, rows, first_ts, last_ts, seriesKey.
   * Use for /api/candles/debug/series to detect broken series.
   */
  async getSeries(symbol?: string): Promise<
    Array<{
      symbol: string;
      interval: TimeFrame;
      connectorType: string;
      marketType: string;
      seriesKey: string;
      rows: number;
      first_ts: number | null;
      last_ts: number | null;
    }>
  > {
    const diagnostics = await this.scanDiagnostics();
    let series = diagnostics.series ?? [];
    if (symbol != null && symbol !== '') {
      series = series.filter((s) => s.key.symbol === symbol);
    }
    return series.map((s) => ({
      symbol: s.key.symbol,
      interval: s.key.interval,
      connectorType: s.key.connectorType,
      marketType: s.key.marketType,
      seriesKey: `${s.key.symbol}:${String(s.key.interval)}:${
        s.key.connectorType
      }:${s.key.marketType}`,
      rows: s.totalRows,
      first_ts: s.startTs ?? null,
      last_ts: s.endTs ?? null,
    }));
  }

  /**
   * Paginated series with optional filters. status = healthy | degraded (from duplicates/gaps/outOfOrder).
   */
  async getSeriesPaginated(options: {
    symbol?: string;
    status?: 'healthy' | 'degraded';
    connectorType?: string;
    interval?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    total: number;
    limit: number;
    offset: number;
    series: Array<{
      symbol: string;
      interval: TimeFrame;
      connectorType: string;
      marketType: string;
      seriesKey: string;
      rows: number;
      first_ts: number | null;
      last_ts: number | null;
      duplicateRows: number;
      gapCount: number;
      outOfOrderCount: number;
      status: 'healthy' | 'degraded';
    }>;
  }> {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
    const offset = Math.max(0, options.offset ?? 0);
    const diagnostics = await this.scanDiagnostics();
    let series = diagnostics.series ?? [];
    if (options.symbol != null && options.symbol !== '') {
      series = series.filter((s) => s.key.symbol === options.symbol);
    }
    if (options.connectorType != null && options.connectorType !== '') {
      series = series.filter(
        (s) => s.key.connectorType === options.connectorType,
      );
    }
    if (options.interval != null && options.interval !== '') {
      series = series.filter(
        (s) => String(s.key.interval) === options.interval,
      );
    }
    const withStatus = series.map((s) => {
      const healthy =
        (s.duplicateRows ?? 0) === 0 &&
        (s.gapCount ?? 0) === 0 &&
        (s.outOfOrderCount ?? 0) === 0;
      const status: 'healthy' | 'degraded' = healthy ? 'healthy' : 'degraded';
      return {
        symbol: s.key.symbol,
        interval: s.key.interval,
        connectorType: s.key.connectorType,
        marketType: s.key.marketType,
        seriesKey: `${s.key.symbol}:${String(s.key.interval)}:${
          s.key.connectorType
        }:${s.key.marketType}`,
        rows: s.totalRows,
        first_ts: s.startTs ?? null,
        last_ts: s.endTs ?? null,
        duplicateRows: s.duplicateRows ?? 0,
        gapCount: s.gapCount ?? 0,
        outOfOrderCount: s.outOfOrderCount ?? 0,
        status,
      };
    });
    let filtered = withStatus;
    const statusFilter =
      options.status === 'healthy' || options.status === 'degraded'
        ? options.status
        : undefined;
    if (statusFilter != null) {
      filtered = withStatus.filter((s) => s.status === statusFilter);
    }
    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);
    return { total, limit, offset, series: page };
  }

  /**
   * Seam diagnostics: per-series first_ts, last_ts, rows at last ts (duplicate-at-seam), gap count, gap at seam.
   * Use for /api/candles/debug/seam to verify historical + realtime stitching.
   */
  async getSeamDiagnostics(symbol?: string): Promise<
    Array<{
      symbol: string;
      interval: TimeFrame;
      connectorType: string;
      marketType: string;
      seriesKey: string;
      first_ts: number | null;
      last_ts: number | null;
      rows: number;
      duplicateRows: number;
      gapCount: number;
      rowsAtLastTs: number;
      gapAtSeam: boolean;
    }>
  > {
    const diagnostics = await this.scanDiagnostics();
    let series = diagnostics.series;
    if (symbol != null && symbol !== '') {
      series = series.filter((s) => s.key.symbol === symbol);
    }
    const out: Array<{
      symbol: string;
      interval: TimeFrame;
      connectorType: string;
      marketType: string;
      seriesKey: string;
      first_ts: number | null;
      last_ts: number | null;
      rows: number;
      duplicateRows: number;
      gapCount: number;
      rowsAtLastTs: number;
      gapAtSeam: boolean;
    }> = [];
    for (const s of series) {
      const report = await this.query.loadSeriesIntegrityReport(s.key);
      const endTs = report.endTimestamp ?? null;
      let rowsAtLastTs = 0;
      if (endTs != null) {
        const rowsAt = await this.query.loadSeriesRowsAtTimestamp({
          ...s.key,
          timestampMs: endTs,
        });
        rowsAtLastTs = rowsAt?.length ?? 0;
      }
      const intervalMs = ms(s.key.interval);
      const lastRange = report.missingRanges?.length
        ? report.missingRanges[report.missingRanges.length - 1]
        : null;
      const gapAtSeam =
        lastRange != null &&
        endTs != null &&
        intervalMs > 0 &&
        lastRange.to >= endTs - intervalMs;
      out.push({
        symbol: s.key.symbol,
        interval: s.key.interval,
        connectorType: s.key.connectorType,
        marketType: s.key.marketType,
        seriesKey: `${s.key.symbol}:${String(s.key.interval)}:${
          s.key.connectorType
        }:${s.key.marketType}`,
        first_ts: s.startTs ?? null,
        last_ts: endTs,
        rows: s.totalRows,
        duplicateRows: s.duplicateRows,
        gapCount: s.gapCount,
        rowsAtLastTs,
        gapAtSeam,
      });
    }
    return out;
  }

  /**
   * Staleness per series: lastTs, lagSeconds, status (ok | warning | critical).
   */
  async getStaleness(options?: {
    warningSeconds?: number;
    criticalSeconds?: number;
  }): Promise<{
    generatedAt: string;
    thresholds: { warningSeconds: number; criticalSeconds: number };
    series: Array<{
      seriesKey: string;
      symbol: string;
      interval: TimeFrame;
      connectorType: string;
      marketType: string;
      lastTs: number | null;
      lastTsIso: string | null;
      lagSeconds: number | null;
      status: 'ok' | 'warning' | 'critical';
    }>;
  }> {
    const warningSeconds = options?.warningSeconds ?? 60;
    const criticalSeconds = options?.criticalSeconds ?? 180;
    const diagnostics = await this.scanDiagnostics();
    const nowSec = Math.floor(Date.now() / 1000);
    const series = diagnostics.series.map((s) => {
      const seriesKey = `${s.key.symbol}:${String(s.key.interval)}:${
        s.key.connectorType
      }:${s.key.marketType}`;
      const lastTsSec = s.endTs != null ? Math.floor(s.endTs / 1000) : null;
      const lagSeconds =
        lastTsSec != null ? Math.max(0, nowSec - lastTsSec) : null;
      let status: 'ok' | 'warning' | 'critical' = 'ok';
      if (lagSeconds != null) {
        if (lagSeconds >= criticalSeconds) status = 'critical';
        else if (lagSeconds >= warningSeconds) status = 'warning';
      }
      return {
        seriesKey,
        symbol: s.key.symbol,
        interval: s.key.interval,
        connectorType: s.key.connectorType,
        marketType: s.key.marketType,
        lastTs: s.endTs ?? null,
        lastTsIso: s.endTs != null ? new Date(s.endTs).toISOString() : null,
        lagSeconds,
        status,
      };
    });
    return {
      generatedAt: new Date().toISOString(),
      thresholds: { warningSeconds, criticalSeconds },
      series,
    };
  }

  /**
   * Per-series diagnostics for one series (connectorType, marketType, symbol, interval).
   */
  async getSeriesDetail(key: {
    connectorType: string;
    marketType: string;
    symbol: string;
    interval: TimeFrame;
  }): Promise<{
    seriesKey: string;
    rows: number;
    firstTs: number | null;
    lastTs: number | null;
    lagSeconds: number | null;
    duplicateRows: number;
    gapCount: number;
    outOfOrderCount: number;
    rowsAtLastTs: number;
    gapAtSeam: boolean;
    status: 'healthy' | 'degraded';
  } | null> {
    const seriesList = await this.query.loadAllSeriesKeys();
    const match = seriesList.find(
      (k) =>
        k.connectorType === key.connectorType &&
        k.marketType === key.marketType &&
        k.symbol === key.symbol &&
        k.interval === key.interval,
    );
    if (!match) return null;
    const report = await this.query.loadSeriesIntegrityReport(match);
    const seriesKey = `${match.symbol}:${String(match.interval)}:${
      match.connectorType
    }:${match.marketType}`;
    const endTs = report.endTimestamp ?? null;
    let rowsAtLastTs = 0;
    if (endTs != null) {
      const rowsAt = await this.query.loadSeriesRowsAtTimestamp({
        ...match,
        timestampMs: endTs,
      });
      rowsAtLastTs = rowsAt?.length ?? 0;
    }
    const intervalMs = ms(match.interval);
    const lastRange = report.missingRanges?.length
      ? report.missingRanges[report.missingRanges.length - 1]
      : null;
    const gapAtSeam =
      lastRange != null &&
      endTs != null &&
      intervalMs > 0 &&
      lastRange.to >= endTs - intervalMs;
    const nowSec = Math.floor(Date.now() / 1000);
    const lagSeconds =
      endTs != null ? Math.max(0, nowSec - Math.floor(endTs / 1000)) : null;
    const healthy =
      report.duplicateRows === 0 &&
      report.outOfOrderCount === 0 &&
      !gapAtSeam &&
      rowsAtLastTs === 1;
    return {
      seriesKey,
      rows: report.totalRows,
      firstTs: report.startTimestamp ?? null,
      lastTs: endTs,
      lagSeconds,
      duplicateRows: report.duplicateRows,
      gapCount: report.gapCount,
      outOfOrderCount: report.outOfOrderCount,
      rowsAtLastTs,
      gapAtSeam,
      status: healthy ? 'healthy' : 'degraded',
    };
  }

  /**
   * Check that reported range boundaries align to interval (optional sanity check).
   */
  private checkIntervalAlignment(
    report: CandleSeriesIntegrityReport,
    intervalMs: number,
  ): boolean {
    if (
      report.startTimestamp == null ||
      report.endTimestamp == null ||
      intervalMs <= 0
    )
      return true;
    const startAligned = report.startTimestamp % intervalMs === 0;
    const endAligned = report.endTimestamp % intervalMs === 0;
    return startAligned && endAligned;
  }
}
