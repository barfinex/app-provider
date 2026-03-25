import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  CandleIntegrityService,
  IntegrityDiagnostics,
} from './candle-integrity.service';
import { IntegrityAlertService } from './integrity-alert.service';
import { CandleIntegrityEventStore } from './candle-integrity-event.store';
import { CandleSelfHealingOrchestratorService } from './candle-self-healing-orchestrator.service';

const CACHE_TTL_MS = 25 * 1000; // 25 seconds (between 10-30s for dashboard)

export interface CachedScanResult {
  diagnostics: IntegrityDiagnostics;
  seam: Array<{
    seriesKey: string;
    gapAtSeam: boolean;
    rowsAtLastTs: number;
    symbol: string;
    interval: string;
    connectorType: string;
    marketType: string;
  }>;
  scannedAt: number;
}

@Injectable()
export class IntegrityAutoscanService {
  private readonly logger = new Logger(IntegrityAutoscanService.name);

  private scanInProgress = false;
  private cached: CachedScanResult | null = null;

  constructor(
    private readonly integrityService: CandleIntegrityService,
    @Optional() private readonly alertService?: IntegrityAlertService,
    @Optional() private readonly eventStore?: CandleIntegrityEventStore,
    @Optional()
    private readonly selfHealingOrchestrator?: CandleSelfHealingOrchestratorService,
  ) {
    // Run once on startup after a short delay so app is ready
    setTimeout(() => void this.runScanOnce(), 15_000);
  }

  /** Run every 5 minutes. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleScheduledScan(): Promise<void> {
    await this.runScanOnce();
  }

  /**
   * Run scan only once at a time. Errors are logged and do not crash the provider.
   */
  async runScanOnce(): Promise<void> {
    if (this.scanInProgress) {
      this.logger.debug(
        'Integrity scan skipped: previous run still in progress',
      );
      return;
    }
    this.scanInProgress = true;
    const startMs = Date.now();
    this.emitEvent('SCAN_STARTED', 'INFO', 'Integrity scan started');
    try {
      const [diagnostics, seam] = await Promise.all([
        this.integrityService.scanDiagnostics(),
        this.integrityService.getSeamDiagnostics(undefined),
      ]);
      this.cached = {
        diagnostics,
        seam: (seam ?? []).map((s) => ({
          seriesKey: s.seriesKey,
          gapAtSeam: s.gapAtSeam,
          rowsAtLastTs: s.rowsAtLastTs ?? 0,
          symbol: s.symbol,
          interval: String(s.interval),
          connectorType: s.connectorType,
          marketType: s.marketType,
        })),
        scannedAt: Date.now(),
      };
      const durationMs = Date.now() - startMs;
      this.emitEvent(
        'SCAN_COMPLETED',
        'INFO',
        `Integrity autoscan completed: series=${diagnostics.seriesCount} duplicates=${diagnostics.duplicateRowsTotal} gaps=${diagnostics.gapCountTotal}`,
        { durationMs },
      );
      this.logger.debug(
        `Integrity autoscan completed: series=${diagnostics.seriesCount} duplicates=${diagnostics.duplicateRowsTotal} gaps=${diagnostics.gapCountTotal}`,
      );
      const seamIssueCount = (this.cached.seam ?? []).filter(
        (s) => s.gapAtSeam || (s.rowsAtLastTs != null && s.rowsAtLastTs !== 1),
      ).length;
      const structuralBroken =
        (diagnostics.duplicateRowsTotal ?? 0) > 0 ||
        (diagnostics.outOfOrderCountTotal ?? 0) > 0 ||
        seamIssueCount > 0;
      if (structuralBroken && this.alertService) {
        this.alertService.maybeAlertStructuralFailure({
          duplicates: diagnostics.duplicateRowsTotal ?? 0,
          outOfOrder: diagnostics.outOfOrderCountTotal ?? 0,
          seamIssues: seamIssueCount,
        });
      }
      if (this.cached && this.selfHealingOrchestrator) {
        await this.selfHealingOrchestrator.tryRecoverFromScanResult(
          this.cached,
        );
        this.selfHealingOrchestrator.processRecoveryState();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitEvent(
        'SCAN_FAILED',
        'ERROR',
        `Integrity autoscan failed: ${msg}`,
        undefined,
        msg,
      );
      this.logger.warn(`Integrity autoscan failed: ${msg}`);
      // Keep previous cache; do not clear it
    } finally {
      this.scanInProgress = false;
    }
  }

  private emitEvent(
    eventType: 'SCAN_STARTED' | 'SCAN_COMPLETED' | 'SCAN_FAILED',
    level: 'INFO' | 'WARN' | 'ERROR',
    message: string,
    payload?: Record<string, unknown>,
    error?: string,
  ): void {
    if (!this.eventStore) return;
    const eventId = `evt-${Date.now()}-${Math.floor(
      100 + Math.random() * 900,
    )}`;
    this.eventStore.append({
      eventId,
      eventType,
      level,
      timestamp: new Date().toISOString(),
      message,
      payload,
      error,
    });
  }

  /**
   * Get cached scan result if still valid (within CACHE_TTL_MS).
   * Returns null if cache is expired or never run.
   */
  getCachedIfValid(): CachedScanResult | null {
    if (!this.cached) return null;
    if (Date.now() - this.cached.scannedAt > CACHE_TTL_MS) return null;
    return this.cached;
  }

  /**
   * Get cached result regardless of TTL (for dashboard fallback).
   */
  getCached(): CachedScanResult | null {
    return this.cached;
  }

  /** Whether a scan is currently running. */
  isScanning(): boolean {
    return this.scanInProgress;
  }

  /** Cache TTL in ms (for dashboard logic). */
  getCacheTtlMs(): number {
    return CACHE_TTL_MS;
  }
}
