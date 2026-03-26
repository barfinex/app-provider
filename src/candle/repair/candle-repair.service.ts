import { Injectable, Logger } from '@nestjs/common';
import { Candle, TimeFrame } from '@barfinex/types';
import { CandleQueryService } from '../candle-query.service';
import { CandleWriterService } from '../candle-writer.service';
import { InstrumentHistoryService } from '../history/instrument-history.service';
import { RequestFactoryService } from '../providers/request-factory.service';
import { CandleWarmupGateService } from '../warmup/candle-warmup-gate.service';
import {
  CandleRepairRequest,
  CandleRepairResponse,
  CandleSeriesSelector,
  RepairProgressReport,
  SeriesIntegrityReport,
  SeriesRepairPlan,
  SeriesRepairResult,
} from './candle-repair.types';

@Injectable()
export class CandleRepairService {
  private readonly logger = new Logger(CandleRepairService.name);
  private static readonly MAX_REPAIR_ITERATIONS = 5;

  constructor(
    private readonly query: CandleQueryService,
    private readonly writer: CandleWriterService,
    private readonly symbolHistoryService: InstrumentHistoryService,
    private readonly requestFactoryService: RequestFactoryService,
    private readonly warmupGate: CandleWarmupGateService,
  ) {}

  async loadIntegrityReport(
    series?: CandleSeriesSelector,
  ): Promise<SeriesIntegrityReport[]> {
    const seriesList = await this.resolveSeriesList(series);
    const reports: SeriesIntegrityReport[] = [];
    for (const item of seriesList) {
      const report = await this.query.loadSeriesIntegrityReport(item);
      reports.push(report);
    }
    return reports;
  }

  async executeRepair(
    request: CandleRepairRequest,
    progressReporter?: (report: RepairProgressReport) => void,
  ): Promise<CandleRepairResponse> {
    const seriesList = await this.resolveSeriesList(request.series);
    this.logger.log(
      `[repair] starting mode=${request.mode} series=${seriesList.length}`,
    );
    progressReporter?.({
      stage: 'scanning_series',
      totalSeries: seriesList.length,
      progressPercent: 0,
    });
    const initialReports = await this.loadIntegrityForSeriesList(
      seriesList,
      (processed, total) => {
        progressReporter?.({
          stage: 'scanning_series',
          processedSeries: processed,
          totalSeries: total,
          progressPercent:
            total > 0 ? Math.min(99, Math.round((processed / total) * 15)) : 0,
        });
      },
    );
    const plans = initialReports.map((report) => this.toPlan(report));

    if (request.mode === 'dry-run') {
      progressReporter?.({ stage: 'completed', progressPercent: 100 });
      return {
        mode: request.mode,
        plans,
        results: [],
        clean: initialReports.every((report) => this.isClean(report)),
      };
    }

    const deleteSupported = await this.query.supportsDelete();
    if (!deleteSupported) {
      if (request.series) {
        const before = initialReports[0]!;
        progressReporter?.({ stage: 'completed', progressPercent: 100 });
        return {
          mode: request.mode,
          plans,
          results: [
            {
              ...request.series,
              iterations: 0,
              changed: false,
              before,
              after: before,
              repairedDuplicateRows: 0,
              repairedGapRanges: 0,
              repairedOutOfOrderPasses: 0,
              error:
                'QuestDB DELETE is not supported in this runtime. Use full-dataset apply to run truncate+rebuild repair.',
            },
          ],
          clean: this.isClean(before),
        };
      }
      this.logger.warn(
        '[repair] QuestDB DELETE unsupported, switching to full-table truncate+rebuild mode',
      );
      return this.withRepairWarmupGate(seriesList, () =>
        this.fullRebuildRepair(plans, initialReports, progressReporter),
      );
    }

    return this.withRepairWarmupGate(seriesList, async () => {
      const results: SeriesRepairResult[] = [];
      let totalDuplicatesFixed = 0;
      let totalGapsFixed = 0;
      const total = seriesList.length;
      for (let i = 0; i < seriesList.length; i += 1) {
        const selector = seriesList[i]!;
        const basePercent = 15 + Math.round((i / total) * 80);
        progressReporter?.({
          stage: 'collapsing_duplicates',
          currentSeries: this.seriesKey(selector),
          processedSeries: i,
          totalSeries: total,
          duplicatesFixed: totalDuplicatesFixed,
          gapsFixed: totalGapsFixed,
          progressPercent: basePercent,
        });
        this.logger.log(
          `[repair] progress ${i + 1}/${
            seriesList.length
          } series=${this.seriesKey(selector)}`,
        );
        const result = await this.repairSeriesUntilClean(selector, (report) => {
          progressReporter?.({
            ...report,
            processedSeries: i,
            totalSeries: total,
            duplicatesFixed:
              totalDuplicatesFixed + (report.duplicatesFixed ?? 0),
            gapsFixed: totalGapsFixed + (report.gapsFixed ?? 0),
            progressPercent:
              basePercent + Math.round((report.progressPercent ?? 0) * 0.8),
          });
        });
        totalDuplicatesFixed += result.repairedDuplicateRows;
        totalGapsFixed += result.repairedGapRanges;
        results.push(result);
        progressReporter?.({
          stage: 'verifying',
          currentSeries: this.seriesKey(selector),
          processedSeries: i + 1,
          totalSeries: total,
          duplicatesFixed: totalDuplicatesFixed,
          gapsFixed: totalGapsFixed,
          progressPercent: 15 + Math.round(((i + 1) / total) * 80),
        });
      }
      progressReporter?.({
        stage: 'completed',
        processedSeries: total,
        totalSeries: total,
        duplicatesFixed: totalDuplicatesFixed,
        gapsFixed: totalGapsFixed,
        progressPercent: 100,
      });
      return {
        mode: request.mode,
        plans,
        results,
        clean: results.every((result) => this.isClean(result.after)),
      };
    });
  }

  private seriesKey(series: CandleSeriesSelector): string {
    return `${series.connectorType}:${series.marketType}:${
      series.symbol
    }:${String(series.interval)}`;
  }

  private buildRepairPairs(seriesList: CandleSeriesSelector[]): Array<{
    connectorType: string;
    marketType: string;
  }> {
    const pairs = new Map<
      string,
      { connectorType: string; marketType: string }
    >();
    for (const series of seriesList) {
      const key = `${series.connectorType}:${series.marketType}`;
      if (!pairs.has(key)) {
        pairs.set(key, {
          connectorType: series.connectorType,
          marketType: series.marketType,
        });
      }
    }
    return Array.from(pairs.values());
  }

  private async withRepairWarmupGate<T>(
    seriesList: CandleSeriesSelector[],
    run: () => Promise<T>,
  ): Promise<T> {
    const repairPairs = this.buildRepairPairs(seriesList);
    const previousWarmupState = this.warmupGate.isWarmupCompleted();
    this.warmupGate.setWarmupCompleted(false);
    for (const pair of repairPairs) {
      this.warmupGate.setWarmupRunning(
        pair.connectorType,
        pair.marketType,
        true,
      );
    }

    try {
      return await run();
    } finally {
      for (const pair of repairPairs) {
        this.warmupGate.setWarmupRunning(
          pair.connectorType,
          pair.marketType,
          false,
        );
      }
      this.warmupGate.setWarmupCompleted(previousWarmupState);
    }
  }

  private async fullRebuildRepair(
    plans: SeriesRepairPlan[],
    initialReports: SeriesIntegrityReport[],
    progressReporter?: (report: RepairProgressReport) => void,
  ): Promise<CandleRepairResponse> {
    const seriesByKey = new Map<string, SeriesIntegrityReport>();
    for (const report of initialReports) {
      seriesByKey.set(this.seriesKey(report), report);
    }

    await this.query.truncateCandles();

    const results: SeriesRepairResult[] = [];
    for (let i = 0; i < initialReports.length; i += 1) {
      const report = initialReports[i]!;
      progressReporter?.({
        stage: 'fetching_history',
        currentSeries: this.seriesKey(report),
        processedSeries: i,
        totalSeries: initialReports.length,
        progressPercent: 20 + Math.round((i / initialReports.length) * 70),
      });
      this.logger.log(
        `[repair] progress ${i + 1}/${
          initialReports.length
        } series=${this.seriesKey(report)} (full-rebuild)`,
      );
      const selector: CandleSeriesSelector = {
        connectorType: report.connectorType,
        marketType: report.marketType,
        symbol: report.symbol,
        interval: report.interval,
      };
      let error: string | undefined;
      let repairedGapRanges = 0;
      if (report.startTimestamp != null && report.endTimestamp != null) {
        try {
          const requestFn = this.requestFactoryService.create(
            selector.connectorType as any,
            selector.marketType as any,
          );
          await this.symbolHistoryService.loadForSymbol({
            connectorType: selector.connectorType,
            marketType: selector.marketType,
            symbol: selector.symbol,
            interval: selector.interval,
            from: report.startTimestamp,
            to: report.endTimestamp,
            requestFn,
          });
          repairedGapRanges = report.gapCount;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
          this.logger.warn(
            `[repair] rebuild skipped series=${this.seriesKey(
              selector,
            )} error=${error}`,
          );
        }
      }

      const before = seriesByKey.get(this.seriesKey(selector)) ?? report;
      const after = await this.query.loadSeriesIntegrityReport(selector);
      results.push({
        ...selector,
        iterations: 1,
        changed: !error,
        before,
        after,
        repairedDuplicateRows: Math.max(
          0,
          before.duplicateRows - after.duplicateRows,
        ),
        repairedGapRanges,
        repairedOutOfOrderPasses:
          before.outOfOrderCount > 0 && after.outOfOrderCount === 0 ? 1 : 0,
        error,
      });
    }

    progressReporter?.({ stage: 'completed', progressPercent: 100 });
    return {
      mode: 'apply',
      plans,
      results,
      clean: results.every((result) => this.isClean(result.after)),
    };
  }

  private async resolveSeriesList(
    series?: CandleSeriesSelector,
  ): Promise<CandleSeriesSelector[]> {
    if (series) return [series];
    return this.query.loadAllSeriesKeys();
  }

  private async loadIntegrityForSeriesList(
    seriesList: CandleSeriesSelector[],
    onSeriesLoaded?: (processed: number, total: number) => void,
  ): Promise<SeriesIntegrityReport[]> {
    const reports: SeriesIntegrityReport[] = [];
    for (let i = 0; i < seriesList.length; i += 1) {
      reports.push(await this.query.loadSeriesIntegrityReport(seriesList[i]!));
      onSeriesLoaded?.(i + 1, seriesList.length);
    }
    return reports;
  }

  private toPlan(report: SeriesIntegrityReport): SeriesRepairPlan {
    return {
      connectorType: report.connectorType,
      marketType: report.marketType,
      symbol: report.symbol,
      interval: report.interval,
      duplicateRowsToRemove: report.duplicateRows,
      gapRangesToBackfill: report.missingRanges,
      requiresOutOfOrderRewrite: report.outOfOrderCount > 0,
    };
  }

  private isClean(report: SeriesIntegrityReport): boolean {
    return (
      report.duplicateRows === 0 &&
      report.gapCount === 0 &&
      report.outOfOrderCount === 0
    );
  }

  private async repairSeriesUntilClean(
    selector: CandleSeriesSelector,
    progressReporter?: (report: RepairProgressReport) => void,
  ): Promise<SeriesRepairResult> {
    const currentSeriesKey = this.seriesKey(selector);
    const before = await this.query.loadSeriesIntegrityReport(selector);
    let repairedDuplicateRows = 0;
    let repairedGapRanges = 0;
    let repairedOutOfOrderPasses = 0;
    let changed = false;
    let iterations = 0;
    let current = before;
    let error: string | undefined;

    try {
      while (
        !this.isClean(current) &&
        iterations < CandleRepairService.MAX_REPAIR_ITERATIONS
      ) {
        iterations += 1;
        this.logger.log(
          `[repair] iteration=${iterations} series=${selector.connectorType}:${
            selector.marketType
          }:${selector.symbol}:${String(selector.interval)} dup=${
            current.duplicateRows
          } gaps=${current.gapCount} outOfOrder=${current.outOfOrderCount}`,
        );

        if (current.duplicateRows > 0) {
          progressReporter?.({
            stage: 'collapsing_duplicates',
            currentSeries: currentSeriesKey,
            duplicatesFixed: repairedDuplicateRows,
            gapsFixed: repairedGapRanges,
          });
          const removed = await this.repairDuplicates(selector);
          repairedDuplicateRows += removed;
          progressReporter?.({
            stage: 'collapsing_duplicates',
            currentSeries: currentSeriesKey,
            duplicatesFixed: repairedDuplicateRows,
            gapsFixed: repairedGapRanges,
          });
          this.logger.log(`[repair] duplicates removed=${removed}`);
          changed = true;
        }

        if (current.gapCount > 0 && current.missingRanges.length > 0) {
          progressReporter?.({
            stage: 'detecting_gaps',
            currentSeries: currentSeriesKey,
            duplicatesFixed: repairedDuplicateRows,
            gapsFixed: repairedGapRanges,
          });
          progressReporter?.({
            stage: 'fetching_history',
            currentSeries: currentSeriesKey,
            duplicatesFixed: repairedDuplicateRows,
            gapsFixed: repairedGapRanges,
          });
          const rebuilt = await this.repairGaps(
            selector,
            current.missingRanges,
          );
          repairedGapRanges += rebuilt;
          progressReporter?.({
            stage: 'inserting_backfill',
            currentSeries: currentSeriesKey,
            duplicatesFixed: repairedDuplicateRows,
            gapsFixed: repairedGapRanges,
          });
          this.logger.log(`[repair] gaps rebuilt=${rebuilt}`);
          changed = true;
        }

        if (current.outOfOrderCount > 0) {
          progressReporter?.({
            stage: 'inserting_backfill',
            currentSeries: currentSeriesKey,
            duplicatesFixed: repairedDuplicateRows,
            gapsFixed: repairedGapRanges,
          });
          const rewritten = await this.rewriteSeriesChronological(
            selector,
            current,
          );
          if (rewritten) {
            repairedOutOfOrderPasses += 1;
            changed = true;
          }
        }

        progressReporter?.({
          stage: 'verifying',
          currentSeries: currentSeriesKey,
          duplicatesFixed: repairedDuplicateRows,
          gapsFixed: repairedGapRanges,
        });
        current = await this.query.loadSeriesIntegrityReport(selector);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      this.logger.error(
        `[repair] series failed ${selector.connectorType}:${
          selector.marketType
        }:${selector.symbol}:${String(selector.interval)} error=${error}`,
      );
    }

    return {
      ...selector,
      iterations,
      changed,
      before,
      after: current,
      repairedDuplicateRows,
      repairedGapRanges,
      repairedOutOfOrderPasses,
      error,
    };
  }

  private selectBestDuplicate(candles: Candle[]): Candle | null {
    if (!candles.length) return null;
    let best = candles[0]!;
    for (const current of candles) {
      if (!Number.isFinite(current.volume) && Number.isFinite(best.volume))
        continue;
      if (Number.isFinite(current.volume) && !Number.isFinite(best.volume)) {
        best = current;
        continue;
      }
      if (current.volume > best.volume) {
        best = current;
        continue;
      }
      if (current.volume === best.volume) {
        const currentTuple = `${current.open}|${current.high}|${current.low}|${current.close}|${current.time}`;
        const bestTuple = `${best.open}|${best.high}|${best.low}|${best.close}|${best.time}`;
        if (currentTuple > bestTuple) {
          best = current;
        }
      }
    }
    return best;
  }

  private async repairDuplicates(
    selector: CandleSeriesSelector,
  ): Promise<number> {
    const duplicateTimestamps = await this.query.loadDuplicateTimestamps(
      selector,
    );
    let repairedRows = 0;
    for (const timestampMs of duplicateTimestamps) {
      const rows = await this.query.loadSeriesRowsAtTimestamp({
        ...selector,
        timestampMs,
      });
      if (rows.length <= 1) continue;
      const best = this.selectBestDuplicate(rows);
      if (!best) continue;

      await this.query.deleteSeriesRowsAtTimestamp({
        ...selector,
        timestampMs,
      });
      await this.writer.bulkInsertHistory(
        selector.symbol,
        selector.interval,
        selector.connectorType,
        selector.marketType,
        [best],
      );
      const seriesKeyRepair = `${selector.symbol}:${String(
        selector.interval,
      )}:${selector.connectorType}:${selector.marketType}`;
      this.logger.log(
        `[CANDLE_PIPELINE] symbol=${selector.symbol} interval=${String(
          selector.interval,
        )} ts=${timestampMs} source=repair action=merge reason=duplicate kept=1 removed=${
          rows.length - 1
        } seriesKey=${seriesKeyRepair}`,
      );
      repairedRows += rows.length - 1;
    }
    return repairedRows;
  }

  private async repairGaps(
    selector: CandleSeriesSelector,
    missingRanges: Array<{ from: number; to: number }>,
  ): Promise<number> {
    if (!missingRanges.length) return 0;
    const requestFn = this.requestFactoryService.create(
      selector.connectorType as any,
      selector.marketType as any,
    );

    let repairedRanges = 0;
    for (const range of missingRanges) {
      try {
        await this.symbolHistoryService.loadForSymbol({
          connectorType: selector.connectorType,
          marketType: selector.marketType,
          symbol: selector.symbol,
          interval: selector.interval,
          from: range.from,
          to: range.to,
          requestFn,
        });
        const seriesKeyGap = `${selector.symbol}:${String(selector.interval)}:${
          selector.connectorType
        }:${selector.marketType}`;
        this.logger.log(
          `[CANDLE_PIPELINE] symbol=${selector.symbol} interval=${String(
            selector.interval,
          )} ts=${range.from}..${
            range.to
          } source=repair action=insert reason=gap seriesKey=${seriesKeyGap}`,
        );
        repairedRanges += 1;
      } catch (e) {
        this.logger.warn(
          `[repair] gap backfill skipped series=${selector.connectorType}:${
            selector.marketType
          }:${selector.symbol}:${String(selector.interval)} range=${new Date(
            range.from,
          ).toISOString()}..${new Date(range.to).toISOString()} error=${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    return repairedRanges;
  }

  private toCanonicalSorted(candles: Candle[]): Candle[] {
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const byTs = new Map<number, Candle>();
    for (const candle of sorted) {
      const existing = byTs.get(candle.time);
      if (!existing) {
        byTs.set(candle.time, candle);
        continue;
      }
      const winner = this.selectBestDuplicate([existing, candle]);
      if (winner) byTs.set(candle.time, winner);
    }
    return Array.from(byTs.values()).sort((a, b) => a.time - b.time);
  }

  private async rewriteSeriesChronological(
    selector: CandleSeriesSelector,
    report: SeriesIntegrityReport,
  ): Promise<boolean> {
    if (report.startTimestamp == null || report.endTimestamp == null)
      return false;
    const existing = await this.query.loadRange({
      symbol: selector.symbol,
      connectorType: selector.connectorType,
      marketType: selector.marketType,
      interval: selector.interval as TimeFrame,
      from: report.startTimestamp,
      to: report.endTimestamp,
    });
    if (!existing.length) return false;
    const canonical = this.toCanonicalSorted(existing);

    await this.query.deleteSeriesRange({
      ...selector,
      fromMs: report.startTimestamp,
      toMs: report.endTimestamp,
    });
    await this.writer.bulkInsertHistory(
      selector.symbol,
      selector.interval,
      selector.connectorType,
      selector.marketType,
      canonical,
    );
    return true;
  }
}
