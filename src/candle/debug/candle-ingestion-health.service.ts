import { Injectable, Optional } from '@nestjs/common';
import { CandleQueryService } from '../candle-query.service';
import { IntegrityAutoscanService } from './integrity-autoscan.service';

export interface IngestionConnectorDto {
  connector: string;
  marketType: string;
  wsConnected: boolean;
  lastTradeTimestamp: string | null;
  lastCandleTimestamp: string | null;
  lagSeconds: number;
}

export interface IngestionHealthResponse {
  connectors: IngestionConnectorDto[];
}

@Injectable()
export class CandleIngestionHealthService {
  constructor(
    private readonly query: CandleQueryService,
    @Optional()
    private readonly autoscan?: IntegrityAutoscanService,
  ) {}

  async getIngestionHealth(): Promise<IngestionHealthResponse> {
    const cached = this.autoscan?.getCached();
    const keyToLastTs = new Map<string, number>();
    const pairsSet = new Set<string>();

    if (cached?.diagnostics?.series) {
      for (const s of cached.diagnostics.series) {
        const k = `${s.key.connectorType}:${s.key.marketType}`;
        pairsSet.add(k);
        const ts = s.endTs ?? 0;
        if (ts) {
          const prev = keyToLastTs.get(k);
          if (prev == null || ts > prev) keyToLastTs.set(k, ts);
        }
      }
    } else {
      const keys = await this.query.loadAllSeriesKeys();
      const seenPair = new Set<string>();
      for (const key of keys) {
        const k = `${key.connectorType}:${key.marketType}`;
        pairsSet.add(k);
        if (seenPair.has(k)) continue;
        seenPair.add(k);
        const candle = await this.query.loadLastCandle(key);
        const raw = candle as { ts?: string; time?: number } | null;
        const ts =
          raw?.ts != null
            ? new Date(raw.ts).getTime()
            : raw?.time != null
            ? raw.time
            : null;
        if (ts != null) {
          const prev = keyToLastTs.get(k);
          if (prev == null || ts > prev) keyToLastTs.set(k, ts);
        }
      }
    }

    const pairs = Array.from(pairsSet);
    const nowMs = Date.now();
    const connectors: IngestionConnectorDto[] = [];

    for (const pair of pairs) {
      const [connector, marketType] = pair.split(':');
      const lastTs = keyToLastTs.get(pair) ?? null;
      const lastCandleTimestamp =
        lastTs != null ? new Date(lastTs).toISOString() : null;
      const lagSeconds =
        lastTs != null ? Math.max(0, Math.floor((nowMs - lastTs) / 1000)) : 0;
      const wsConnected = this.getWsConnected(connector, marketType);
      connectors.push({
        connector: connector ?? 'unknown',
        marketType: marketType ?? 'unknown',
        wsConnected,
        lastTradeTimestamp: lastCandleTimestamp,
        lastCandleTimestamp,
        lagSeconds,
      });
    }

    return {
      connectors: connectors.sort(
        (a, b) =>
          a.connector.localeCompare(b.connector) ||
          a.marketType.localeCompare(b.marketType),
      ),
    };
  }

  /** Override via optional provider for real WS state. Default true when unknown. */
  private getWsConnected(_connector: string, _marketType: string): boolean {
    return true;
  }
}
