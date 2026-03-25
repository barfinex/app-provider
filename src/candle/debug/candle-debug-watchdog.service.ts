import { Injectable, Optional } from '@nestjs/common';
import { CandleIntegrityService } from './candle-integrity.service';
import { IntegrityAutoscanService } from './integrity-autoscan.service';

const STALE_WARNING_SEC = 60;
const STALE_CRITICAL_SEC = 180;

export interface WatchdogResponse {
  status: 'OK' | 'WARN' | 'CRITICAL';
  structuralIntegrity: 'healthy' | 'broken';
  operationalIntegrity: 'healthy' | 'repair_recommended';
  metrics: {
    duplicates: number;
    outOfOrder: number;
    seamIssues: number;
    gaps: number;
    staleSeries: number;
    laggingSeries: number;
  };
}

@Injectable()
export class CandleDebugWatchdogService {
  constructor(
    private readonly integrityService: CandleIntegrityService,
    @Optional()
    private readonly autoscan?: IntegrityAutoscanService,
  ) {}

  async getWatchdog(): Promise<WatchdogResponse> {
    const cached =
      this.autoscan?.getCachedIfValid() ?? this.autoscan?.getCached();
    let diagnostics: import('./candle-integrity.service').IntegrityDiagnostics;
    let seam: Array<{ gapAtSeam: boolean; rowsAtLastTs?: number | null }>;

    if (cached) {
      diagnostics = cached.diagnostics;
      seam = cached.seam;
    } else {
      const [d, s] = await Promise.all([
        this.integrityService.scanDiagnostics(),
        this.integrityService.getSeamDiagnostics(undefined),
      ]);
      diagnostics = d;
      seam = s ?? [];
    }

    const nowSec = Math.floor(Date.now() / 1000);
    let staleSeries = 0;
    let laggingSeries = 0;
    const series = diagnostics.series ?? [];
    for (const s of series) {
      const lastTsSec = s.endTs != null ? Math.floor(s.endTs / 1000) : null;
      if (lastTsSec == null) continue;
      const lagSec = nowSec - lastTsSec;
      if (lagSec >= STALE_CRITICAL_SEC) laggingSeries += 1;
      else if (lagSec >= STALE_WARNING_SEC) staleSeries += 1;
    }

    const seamIssueCount = (seam ?? []).filter(
      (s) => s.gapAtSeam || (s.rowsAtLastTs != null && s.rowsAtLastTs !== 1),
    ).length;

    const structuralHealthy =
      (diagnostics.duplicateRowsTotal ?? 0) === 0 &&
      (diagnostics.outOfOrderCountTotal ?? 0) === 0 &&
      seamIssueCount === 0;

    const operationalHealthy =
      (diagnostics.gapCountTotal ?? 0) === 0 &&
      staleSeries === 0 &&
      laggingSeries === 0;

    const metrics = {
      duplicates: diagnostics.duplicateRowsTotal ?? 0,
      outOfOrder: diagnostics.outOfOrderCountTotal ?? 0,
      seamIssues: seamIssueCount,
      gaps: diagnostics.gapCountTotal ?? 0,
      staleSeries,
      laggingSeries,
    };

    let status: 'OK' | 'WARN' | 'CRITICAL' = 'OK';
    if (!structuralHealthy) status = 'CRITICAL';
    else if (!operationalHealthy) status = 'WARN';

    return {
      status,
      structuralIntegrity: structuralHealthy ? 'healthy' : 'broken',
      operationalIntegrity: operationalHealthy
        ? 'healthy'
        : 'repair_recommended',
      metrics,
    };
  }
}
