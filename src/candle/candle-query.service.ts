import { Injectable, Logger } from '@nestjs/common';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import { TimeFrame, Candle } from '@barfinex/types';
import { normalize } from './aggregation/aggregation.utils';

@Injectable()
export class CandleQueryService {
  private readonly logger = new Logger(CandleQueryService.name);

  constructor(
    private readonly reader: QuestDBQueryService,
  ) { }

  // =========================================================================
  // 🔹 BASE RANGE LOAD (QuestDB, ISO timestamps)
  // =========================================================================
  async loadRange(params: {
    symbol: string;
    connectorType: string;
    marketType: string;
    interval: TimeFrame;
    from: number; // ms UTC
    to: number;   // ms UTC
  }): Promise<Candle[]> {

    let { symbol, connectorType, marketType, interval, from, to } = params;

    symbol = symbol.replace(/'/g, "''");
    connectorType = connectorType.replace(/'/g, "''");
    marketType = marketType.replace(/'/g, "''");
    const intervalSql = String(interval).replace(/'/g, "''");

    const fromIso = new Date(from).toISOString();
    const toIso = new Date(to).toISOString();

    const sql = `
    SELECT
      ts,
      open,
      high,
      low,
      close,
      volume
    FROM candles
    WHERE symbol='${symbol}'
      AND connectorType='${connectorType}'
      AND marketType='${marketType}'
      AND interval='${intervalSql}'
      AND ts >= timestamp '${fromIso}'
      AND ts <= timestamp '${toIso}'
    ORDER BY ts ASC
  `;

    this.logger.debug(`SQL loadRange:\n${sql.trim()}`);

    const rows = await this.reader.queryAsObjects(sql);

    this.logger.debug(`loadRange result: ${rows.length} rows`);

    return rows as Candle[];
  }




  // =========================================================================
  // 🔹 NORMALIZED READ PATH
  // =========================================================================
  async loadRangeNormalized(params: {
    symbol: string;
    connectorType: string;
    marketType: string;
    interval: TimeFrame;
    from: number; // ms
    to: number;   // ms
  }): Promise<Candle[]> {

    this.logger.debug(
      `loadRangeNormalized | symbol=${params.symbol} | interval=${params.interval}`
    );

    const rows = await this.loadRange(params);
    const normalized = normalize(rows);

    this.logger.debug(
      `loadRangeNormalized result: ${normalized.length} candles`
    );

    return normalized;
  }

  // =========================================================================
  // 🔹 LAST TIMESTAMP (ANCHOR)
  // =========================================================================
  async loadLastTimestamp(params: {
    symbol: string;
    connectorType: string;
    marketType: string;
    interval: TimeFrame;
  }): Promise<number | null> {

    let { symbol, connectorType, marketType, interval } = params;

    symbol = symbol.replace(/'/g, "''");
    connectorType = connectorType.replace(/'/g, "''");
    marketType = marketType.replace(/'/g, "''");
    const intervalSql = String(interval).replace(/'/g, "''");

    const sql = `
    SELECT max(ts) AS ts
    FROM candles
    WHERE symbol='${symbol}'
      AND connectorType='${connectorType}'
      AND marketType='${marketType}'
      AND interval='${intervalSql}'
  `;

    this.logger.debug(
      [
        'Executing loadLastTimestamp',
        `symbol=${symbol}`,
        `connectorType=${connectorType}`,
        `marketType=${marketType}`,
        `interval=${intervalSql}`,
      ].join(' | ')
    );

    const rows = await this.reader.queryAsObjects(sql) as { ts: string | null }[];

    if (!rows.length || rows[0]?.ts == null) {
      this.logger.warn(
        `loadLastTimestamp: no data | symbol=${symbol} | interval=${intervalSql}`
      );
      return null;
    }

    const rawTs = rows[0].ts;

    // 🔒 QuestDB timestamp ВСЕГДА UTC, даже если пришёл без 'Z'
    const tsIso =
      typeof rawTs === 'string' && !rawTs.endsWith('Z')
        ? `${rawTs}Z`
        : rawTs;

    const tsMs = Date.parse(tsIso);

    if (!Number.isFinite(tsMs)) {
      this.logger.error(`Invalid ts from DB: ${rawTs}`);
      return null;
    }

    // 🔥 Логируем ТОЛЬКО UTC, никаких локальных дат
    this.logger.debug(
      `loadLastTimestamp result | tsIso=${new Date(tsMs).toISOString()} | ts(ms)=${tsMs}`
    );

    return tsMs;
  }


  // =========================================================================
  // 🔹 LOAD LAST N (DEBUG / ADMIN)
  // =========================================================================
  async loadLastN(
    symbol: string,
    interval: TimeFrame,
    n = 100
  ): Promise<Candle[]> {

    symbol = symbol.replace(/'/g, "''");
    const intervalSql = String(interval).replace(/'/g, "''");

    const sql = `
      SELECT
        ts,
        open,
        high,
        low,
        close,
        volume
      FROM candles
      WHERE symbol='${symbol}'
        AND interval='${intervalSql}'
      ORDER BY ts DESC
      LIMIT ${n}
    `;

    this.logger.debug(
      `Executing loadLastN | symbol=${symbol} | interval=${intervalSql} | n=${n}`
    );

    const rows = await this.reader.queryAsObjects(sql);

    this.logger.debug(`loadLastN result: ${rows.length} rows`);

    return rows as Candle[];
  }
}
