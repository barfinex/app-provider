import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiParam,
  ApiOkResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import { QuestDBQueryService } from '../questdb/questdb-query.service';
import { ExchangeDataService } from '../connector/datasource/exchange/exchange-data.service';
import { toDomainInterval } from '../candle/time/time.utils';
import {
  MarketDataRetentionService,
  MARKET_DATA_LAG_WARNING_MS,
  MARKET_DATA_STALE_MS,
} from './market-data-retention.service';

function escapeSql(str: string): string {
  return String(str ?? '')
    .replace(/'/g, "''")
    .trim();
}

function normalizeConnectorType(value?: string): string | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeMarketType(value?: string): string | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;
  if (
    normalized === 'future' ||
    normalized === 'perp' ||
    normalized === 'perpetual'
  )
    return 'futures';
  return normalized;
}

function normalizeInstrument(value?: string): string {
  return String(value ?? '')
    .trim()
    .toUpperCase();
}

@ApiTags('MarketData')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('')
export class MarketDataController {
  constructor(
    private readonly reader: QuestDBQueryService,
    private readonly retention: MarketDataRetentionService,
    private readonly exchangeDataService: ExchangeDataService,
  ) {}

  private parseOrderbookSnapshot(snapshotJson: unknown): {
    bids: Array<[number, number]>;
    asks: Array<[number, number]>;
  } {
    if (typeof snapshotJson !== 'string' || snapshotJson.length === 0) {
      return { bids: [], asks: [] };
    }
    try {
      const parsed = JSON.parse(snapshotJson) as {
        bids?: Array<{ price?: number; volume?: number }>;
        asks?: Array<{ price?: number; volume?: number }>;
        b?: Array<[number, number]>;
        a?: Array<[number, number]>;
      };

      const fromObjects = (
        rows: Array<{ price?: number; volume?: number }> | undefined,
        sortDesc: boolean,
      ) =>
        (rows ?? [])
          .map(
            (level) =>
              [Number(level?.price ?? 0), Number(level?.volume ?? 0)] as [
                number,
                number,
              ],
          )
          .filter(
            ([price, volume]) =>
              Number.isFinite(price) &&
              price > 0 &&
              Number.isFinite(volume) &&
              volume > 0,
          )
          .sort((left, right) =>
            sortDesc ? right[0] - left[0] : left[0] - right[0],
          );

      const fromTuples = (
        rows: Array<[number, number]> | undefined,
        sortDesc: boolean,
      ) =>
        (rows ?? [])
          .map(
            (level) =>
              [Number(level?.[0] ?? 0), Number(level?.[1] ?? 0)] as [
                number,
                number,
              ],
          )
          .filter(
            ([price, volume]) =>
              Number.isFinite(price) &&
              price > 0 &&
              Number.isFinite(volume) &&
              volume > 0,
          )
          .sort((left, right) =>
            sortDesc ? right[0] - left[0] : left[0] - right[0],
          );

      const bids = parsed?.bids?.length
        ? fromObjects(parsed.bids, true)
        : fromTuples(parsed?.b, true);
      const asks = parsed?.asks?.length
        ? fromObjects(parsed.asks, false)
        : fromTuples(parsed?.a, false);
      return { bids, asks };
    } catch {
      return { bids: [], asks: [] };
    }
  }

  private toTimestampMs(value: unknown): number {
    if (value == null) return 0;
    if (typeof value === 'number')
      return value > 1e12 ? Math.trunc(value) : Math.trunc(value * 1000);
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string') {
      const numeric = Number(value);
      if (Number.isFinite(numeric))
        return numeric > 1e12
          ? Math.trunc(numeric)
          : Math.trunc(numeric * 1000);
      return Date.parse(value) || 0;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return numeric > 1e12 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
  }

  @Get('trades')
  @ApiOperation({
    summary: 'Query raw trades',
    description:
      'Returns raw trades from QuestDB. Filter by connectorType, marketType, symbol, from, to. Order and limit supported.',
  })
  @ApiQuery({ name: 'connectorType', required: false })
  @ApiQuery({ name: 'marketType', required: false })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'order', required: false, description: 'asc | desc' })
  @ApiOkResponse({ description: '{ data: trades[] }' })
  async getTrades(
    @Query('connectorType') connectorType?: string,
    @Query('marketType') marketType?: string,
    @Query('symbol') symbol?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('order') order?: string,
  ) {
    const limitNum = Math.min(
      500,
      Math.max(1, parseInt(limit ?? '100', 10) || 100),
    );
    const orderDir = (order ?? 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const normalizedConnector = normalizeConnectorType(connectorType);
    const normalizedMarket = normalizeMarketType(marketType);
    const normalizedInstrument = normalizeInstrument(symbol);
    const where: string[] = [];
    if (normalizedConnector)
      where.push(`connectorType = '${escapeSql(normalizedConnector)}'`);
    if (normalizedMarket)
      where.push(`marketType = '${escapeSql(normalizedMarket)}'`);
    if (normalizedInstrument)
      where.push(`symbol = '${escapeSql(normalizedInstrument)}'`);
    if (from && to && (parseInt(from, 10) || 0) > (parseInt(to, 10) || 0)) {
      throw new BadRequestException(
        '"from" must be less than or equal to "to"',
      );
    }
    if (from) where.push(`ts >= ${(parseInt(from, 10) || 0) * 1000}L`);
    if (to) where.push(`ts <= ${(parseInt(to, 10) || 0) * 1000}L`);
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM raw_trades ${whereClause} ORDER BY ts ${orderDir} LIMIT ${limitNum}`;
    const data = await this.reader.queryAsObjects(sql);
    if (Array.isArray(data) && data.length > 0) {
      return { data };
    }

    // Runtime fallback keeps API usable when persistence lags or is unavailable.
    if (normalizedInstrument) {
      const runtimeTrades = this.exchangeDataService.getRecentRuntimeTrades(
        normalizedInstrument,
        limitNum,
      );
      if (runtimeTrades.length > 0) {
        return {
          data: runtimeTrades.map((row) => ({
            id: row.id,
            tradeId: row.tradeId ?? row.id,
            ts: row.time,
            time: row.time,
            price: row.price,
            qty: row.size,
            volume: row.size,
            size: row.size,
            side: row.side,
            isBuyerMaker: row.isBuyerMaker,
            source: 'runtime-fallback',
          })),
        };
      }
    }
    return { data: [] };
  }

  @Get('trades/features')
  @ApiOperation({
    summary: 'Query trade features',
    description:
      'Returns trade features from QuestDB (trade_features table). Filter by connectorType, marketType, symbol, window, from, to. Order desc, limit up to 500.',
  })
  @ApiQuery({ name: 'connectorType', required: false })
  @ApiQuery({ name: 'marketType', required: false })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'window', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'Unix seconds' })
  @ApiQuery({ name: 'to', required: false, description: 'Unix seconds' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ description: '{ data: trade features[] }' })
  async getTradeFeatures(
    @Query('connectorType') connectorType?: string,
    @Query('marketType') marketType?: string,
    @Query('symbol') symbol?: string,
    @Query('window') window?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = Math.min(
      500,
      Math.max(1, parseInt(limit ?? '100', 10) || 100),
    );
    const normalizedConnector = normalizeConnectorType(connectorType);
    const normalizedMarket = normalizeMarketType(marketType);
    const normalizedInstrument = normalizeInstrument(symbol);
    const where: string[] = [];
    if (normalizedConnector)
      where.push(`connectorType = '${escapeSql(normalizedConnector)}'`);
    if (normalizedMarket)
      where.push(`marketType = '${escapeSql(normalizedMarket)}'`);
    if (normalizedInstrument)
      where.push(`symbol = '${escapeSql(normalizedInstrument)}'`);
    if (window) where.push(`window = '${escapeSql(window)}'`);
    if (from && to && (parseInt(from, 10) || 0) > (parseInt(to, 10) || 0)) {
      throw new BadRequestException(
        '"from" must be less than or equal to "to"',
      );
    }
    if (from) where.push(`ts >= ${(parseInt(from, 10) || 0) * 1000}L`);
    if (to) where.push(`ts <= ${(parseInt(to, 10) || 0) * 1000}L`);
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM trade_features ${whereClause} ORDER BY ts DESC LIMIT ${limitNum}`;
    const data = await this.reader.queryAsObjects(sql);
    return { data };
  }

  @Get('trades/debug/stats')
  @ApiOperation({
    summary: 'Trades debug stats',
    description:
      'Returns row counts and latest ts for raw_trades, trade_features, trades (legacy), plus distinct symbols and retention config. Used for debugging market data pipeline.',
  })
  @ApiOkResponse({
    description:
      '{ raw_trades, trade_features, trades_legacy, symbols, retentionStatus }',
  })
  async getTradesDebugStats() {
    const [rawCount, rawLatest, legacyCount, featuresCount, symbolsRows] =
      await Promise.all([
        this.reader.queryValue(`SELECT count() FROM raw_trades`).catch(() => 0),
        this.reader
          .queryValue(`SELECT max(ts) FROM raw_trades`)
          .catch(() => null),
        this.reader.queryValue(`SELECT count() FROM trades`).catch(() => 0),
        this.reader
          .queryValue(`SELECT count() FROM trade_features`)
          .catch(() => 0),
        this.reader
          .queryAsObjects(`SELECT distinct symbol FROM raw_trades LIMIT 500`)
          .catch(() => []),
      ]);
    const retention = this.retention.getRetentionConfig();
    const symbols = Array.isArray(symbolsRows)
      ? (symbolsRows as { symbol?: string }[])
          .map((r) => String(r?.symbol ?? ''))
          .filter(Boolean)
      : [];
    return {
      raw_trades: {
        rowCount: Number(rawCount ?? 0),
        latestTs: rawLatest ?? null,
      },
      trade_features: { rowCount: Number(featuresCount ?? 0) },
      trades_legacy: { rowCount: Number(legacyCount ?? 0) },
      symbols: symbols.slice(0, 200),
      retentionStatus: {
        rawTradesRetentionDays: retention.rawTradesDays,
        retentionConfigured: true,
      },
    };
  }

  @Get('orderbook/top')
  @ApiOperation({
    summary: 'Query orderbook top',
    description:
      'Returns orderbook top-of-book data from QuestDB. Filter by connectorType, marketType, symbol, from, to. Limit up to 500.',
  })
  @ApiQuery({ name: 'connectorType', required: false })
  @ApiQuery({ name: 'marketType', required: false })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'Unix seconds' })
  @ApiQuery({ name: 'to', required: false, description: 'Unix seconds' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ description: '{ data: orderbook top[] }' })
  async getOrderbookTop(
    @Query('connectorType') connectorType?: string,
    @Query('marketType') marketType?: string,
    @Query('symbol') symbol?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = Math.min(
      500,
      Math.max(1, parseInt(limit ?? '100', 10) || 100),
    );
    const normalizedConnector = normalizeConnectorType(connectorType);
    const normalizedMarket = normalizeMarketType(marketType);
    const normalizedInstrument = normalizeInstrument(symbol);
    const where: string[] = [];
    if (normalizedConnector)
      where.push(`connectorType = '${escapeSql(normalizedConnector)}'`);
    if (normalizedMarket)
      where.push(`marketType = '${escapeSql(normalizedMarket)}'`);
    if (normalizedInstrument)
      where.push(`symbol = '${escapeSql(normalizedInstrument)}'`);
    if (from && to && (parseInt(from, 10) || 0) > (parseInt(to, 10) || 0)) {
      throw new BadRequestException(
        '"from" must be less than or equal to "to"',
      );
    }
    if (from) where.push(`ts >= ${(parseInt(from, 10) || 0) * 1000}L`);
    if (to) where.push(`ts <= ${(parseInt(to, 10) || 0) * 1000}L`);
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM orderbook_top ${whereClause} ORDER BY ts DESC LIMIT ${limitNum}`;
    const data = await this.reader.queryAsObjects(sql);
    return { data };
  }

  @Get('orderbook/snapshots')
  @ApiOperation({
    summary: 'Query orderbook snapshots',
    description:
      'Returns orderbook snapshots (ts, depthLevels, snapshotJson) from QuestDB. Filter by connectorType, marketType, symbol, from, to. Limit up to 100.',
  })
  @ApiQuery({ name: 'connectorType', required: false })
  @ApiQuery({ name: 'marketType', required: false })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ description: '{ data: snapshots[] }' })
  async getOrderbookSnapshots(
    @Query('connectorType') connectorType?: string,
    @Query('marketType') marketType?: string,
    @Query('symbol') symbol?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = Math.min(
      100,
      Math.max(1, parseInt(limit ?? '20', 10) || 20),
    );
    const normalizedConnector = normalizeConnectorType(connectorType);
    const normalizedMarket = normalizeMarketType(marketType);
    const normalizedInstrument = normalizeInstrument(symbol);
    const where: string[] = [];
    if (normalizedConnector)
      where.push(`connectorType = '${escapeSql(normalizedConnector)}'`);
    if (normalizedMarket)
      where.push(`marketType = '${escapeSql(normalizedMarket)}'`);
    if (normalizedInstrument)
      where.push(`symbol = '${escapeSql(normalizedInstrument)}'`);
    if (from && to && (parseInt(from, 10) || 0) > (parseInt(to, 10) || 0)) {
      throw new BadRequestException(
        '"from" must be less than or equal to "to"',
      );
    }
    if (from) where.push(`ts >= ${(parseInt(from, 10) || 0) * 1000}L`);
    if (to) where.push(`ts <= ${(parseInt(to, 10) || 0) * 1000}L`);
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT ts, connectorType, marketType, symbol, depthLevels, snapshotJson FROM orderbook_snapshots ${whereClause} ORDER BY ts DESC LIMIT ${limitNum}`;
    const data = await this.reader.queryAsObjects(sql);
    if (Array.isArray(data) && data.length > 0) {
      return { data };
    }

    if (normalizedInstrument) {
      const runtimeSnapshot =
        this.exchangeDataService.getMarketQualitySnapshot(normalizedInstrument);
      if (runtimeSnapshot?.orderbook) {
        const bids = (runtimeSnapshot.orderbook.bids ?? [])
          .map(
            (level) =>
              [Number(level?.price ?? 0), Number(level?.volume ?? 0)] as [
                number,
                number,
              ],
          )
          .filter(
            ([price, volume]) =>
              Number.isFinite(price) &&
              price > 0 &&
              Number.isFinite(volume) &&
              volume > 0,
          );
        const asks = (runtimeSnapshot.orderbook.asks ?? [])
          .map(
            (level) =>
              [Number(level?.price ?? 0), Number(level?.volume ?? 0)] as [
                number,
                number,
              ],
          )
          .filter(
            ([price, volume]) =>
              Number.isFinite(price) &&
              price > 0 &&
              Number.isFinite(volume) &&
              volume > 0,
          );
        if (bids.length > 0 || asks.length > 0) {
          return {
            data: [
              {
                ts:
                  runtimeSnapshot.timestamps?.orderbookTimestamp ?? Date.now(),
                connectorType: normalizedConnector ?? connectorType,
                marketType: normalizedMarket ?? 'futures',
                symbol: normalizedInstrument,
                depthLevels: Math.max(bids.length, asks.length),
                snapshotJson: JSON.stringify({
                  b: bids,
                  a: asks,
                  ts:
                    runtimeSnapshot.timestamps?.orderbookTimestamp ??
                    Date.now(),
                }),
                source: 'runtime-fallback',
              },
            ],
          };
        }
      }
    }
    return { data: [] };
  }

  @Get('orderbook/features')
  @ApiOperation({
    summary: 'Query orderbook features',
    description:
      'Returns orderbook features from QuestDB. Filter by connectorType, marketType, symbol, from, to. Limit up to 500.',
  })
  @ApiQuery({ name: 'connectorType', required: false })
  @ApiQuery({ name: 'marketType', required: false })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ description: '{ data: orderbook features[] }' })
  async getOrderbookFeatures(
    @Query('connectorType') connectorType?: string,
    @Query('marketType') marketType?: string,
    @Query('symbol') symbol?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const limitNum = Math.min(
      500,
      Math.max(1, parseInt(limit ?? '100', 10) || 100),
    );
    const normalizedConnector = normalizeConnectorType(connectorType);
    const normalizedMarket = normalizeMarketType(marketType);
    const normalizedInstrument = normalizeInstrument(symbol);
    const where: string[] = [];
    if (normalizedConnector)
      where.push(`connectorType = '${escapeSql(normalizedConnector)}'`);
    if (normalizedMarket)
      where.push(`marketType = '${escapeSql(normalizedMarket)}'`);
    if (normalizedInstrument)
      where.push(`symbol = '${escapeSql(normalizedInstrument)}'`);
    if (from && to && (parseInt(from, 10) || 0) > (parseInt(to, 10) || 0)) {
      throw new BadRequestException(
        '"from" must be less than or equal to "to"',
      );
    }
    if (from) where.push(`ts >= ${(parseInt(from, 10) || 0) * 1000}L`);
    if (to) where.push(`ts <= ${(parseInt(to, 10) || 0) * 1000}L`);
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM orderbook_features ${whereClause} ORDER BY ts DESC LIMIT ${limitNum}`;
    const data = await this.reader.queryAsObjects(sql);
    return { data };
  }

  @Get('orderbook/debug/stats')
  @ApiOperation({
    summary: 'Orderbook debug stats',
    description:
      'Returns row counts and latest ts for orderbook_top, orderbook_snapshots, orderbook_features, plus retention config. Used for debugging orderbook pipeline.',
  })
  @ApiOkResponse({
    description:
      '{ orderbook_top, orderbook_snapshots, orderbook_features, retention }',
  })
  async getOrderbookDebugStats() {
    const [
      topCount,
      topLatest,
      snapCount,
      snapLatest,
      featuresCount,
      featuresLatest,
    ] = await Promise.all([
      this.reader
        .queryValue(`SELECT count() FROM orderbook_top`)
        .catch(() => 0),
      this.reader
        .queryValue(`SELECT max(ts) FROM orderbook_top`)
        .catch(() => null),
      this.reader
        .queryValue(`SELECT count() FROM orderbook_snapshots`)
        .catch(() => 0),
      this.reader
        .queryValue(`SELECT max(ts) FROM orderbook_snapshots`)
        .catch(() => null),
      this.reader
        .queryValue(`SELECT count() FROM orderbook_features`)
        .catch(() => 0),
      this.reader
        .queryValue(`SELECT max(ts) FROM orderbook_features`)
        .catch(() => null),
    ]);
    const retention = this.retention.getRetentionConfig();
    return {
      orderbook_top: {
        rowCount: Number(topCount ?? 0),
        latestTs: topLatest ?? null,
      },
      orderbook_snapshots: {
        rowCount: Number(snapCount ?? 0),
        latestTs: snapLatest ?? null,
      },
      orderbook_features: {
        rowCount: Number(featuresCount ?? 0),
        latestTs: featuresLatest ?? null,
      },
      retention: {
        orderbookSnapshotsDays: retention.orderbookSnapshotsDays,
      },
    };
  }

  @Get('market-data/symbol/:symbol')
  @ApiOperation({
    summary: 'Unified market snapshot for a symbol',
    description:
      'Returns a single response with orderbook (bids/asks) and recent trades for the symbol. Reduces 3–5 REST calls to 1. Filter by connectorType and marketType.',
  })
  @ApiParam({
    name: 'symbol',
    example: 'DOGSUSDT',
    description: 'Trading symbol',
  })
  @ApiQuery({ name: 'connectorType', required: true })
  @ApiQuery({ name: 'marketType', required: true })
  @ApiQuery({
    name: 'orderbookLimit',
    required: false,
    description: 'Max orderbook levels per side (default 20)',
  })
  @ApiQuery({
    name: 'tradesLimit',
    required: false,
    description: 'Max trades (default 50)',
  })
  @ApiQuery({
    name: 'candleInterval',
    required: false,
    description: 'Candle interval (default 1m)',
  })
  @ApiQuery({
    name: 'candlesLimit',
    required: false,
    description: 'Max recent candles (default 200)',
  })
  @ApiQuery({
    name: 'candlesTo',
    required: false,
    description:
      'When set, return candles strictly before this timestamp (ms). Used for loading older history.',
  })
  @ApiOkResponse({
    description:
      '{ symbol, candles, orderbook: { bids, asks }, trades, marketQuality, sourceMeta }',
  })
  async getMarketDataSymbol(
    @Param('symbol') symbol: string,
    @Query('connectorType') connectorType?: string,
    @Query('marketType') marketType?: string,
    @Query('orderbookLimit') orderbookLimit?: string,
    @Query('tradesLimit') tradesLimit?: string,
    @Query('candleInterval') candleInterval?: string,
    @Query('candlesLimit') candlesLimit?: string,
    @Query('candlesTo') candlesTo?: string,
  ) {
    const sym = normalizeInstrument(symbol);
    const normalizedConnector =
      normalizeConnectorType(connectorType) ?? connectorType ?? '';
    const normalizedMarket = normalizeMarketType(marketType) ?? 'futures';
    const normalizedInterval = String(toDomainInterval(candleInterval ?? '1m'));
    const obLimit = Math.min(
      100,
      Math.max(1, parseInt(orderbookLimit ?? '20', 10) || 20),
    );
    const trLimit = Math.min(
      500,
      Math.max(1, parseInt(tradesLimit ?? '50', 10) || 50),
    );
    const cLimit = Math.min(
      2000,
      Math.max(1, parseInt(candlesLimit ?? '200', 10) || 200),
    );

    const candlesToMs =
      candlesTo != null && candlesTo.trim() !== ''
        ? Number(candlesTo.trim()) || NaN
        : NaN;
    const candlesToCondition =
      Number.isFinite(candlesToMs) && candlesToMs > 0
        ? ` AND ts < ${Math.floor(candlesToMs)} * 1000`
        : '';

    const whereOb: string[] = [
      `symbol = '${escapeSql(sym)}'`,
      `connectorType = '${escapeSql(normalizedConnector)}'`,
      `marketType = '${escapeSql(normalizedMarket)}'`,
    ];
    const whereTrades: string[] = [
      `symbol = '${escapeSql(sym)}'`,
      `connectorType = '${escapeSql(normalizedConnector)}'`,
      `marketType = '${escapeSql(normalizedMarket)}'`,
    ];
    const [snapRows, tradeRows, candleRows] = await Promise.all([
      this.reader.queryAsObjects(
        `SELECT ts, snapshotJson FROM orderbook_snapshots WHERE ${whereOb.join(
          ' AND ',
        )} ORDER BY ts DESC LIMIT 1`,
      ),
      this.reader.queryAsObjects(
        `SELECT * FROM raw_trades WHERE ${whereTrades.join(
          ' AND ',
        )} ORDER BY ts DESC LIMIT ${trLimit}`,
      ),
      this.reader.queryAsObjects(
        `SELECT ts, open, high, low, close, volume FROM candles
         WHERE symbol = '${escapeSql(sym)}'
           AND connectorType = '${escapeSql(normalizedConnector)}'
           AND marketType = '${escapeSql(normalizedMarket)}'
           AND interval = '${escapeSql(
             normalizedInterval,
           )}'${candlesToCondition}
         ORDER BY ts DESC LIMIT ${cLimit}`,
      ),
    ]);

    let orderbookSource: 'questdb' | 'runtime-fallback' | 'empty' = 'empty';
    let bids: Array<[number, number]> = [];
    let asks: Array<[number, number]> = [];
    if (Array.isArray(snapRows) && snapRows.length > 0) {
      const row = snapRows[0] as {
        snapshotJson?: string;
        snapshotjson?: string;
      };
      const parsed = this.parseOrderbookSnapshot(
        row?.snapshotJson ?? row?.snapshotjson,
      );
      bids = parsed.bids.slice(0, obLimit);
      asks = parsed.asks.slice(0, obLimit);
      if (bids.length > 0 || asks.length > 0) {
        orderbookSource = 'questdb';
      }
    }

    const trades = (Array.isArray(tradeRows) ? tradeRows : []).map(
      (r: Record<string, unknown>, i: number) => {
        const tsMs = this.toTimestampMs(r.ts ?? r.eventTs ?? r.ingestTs);
        const price = Number(r.price ?? 0);
        const size = Number(
          r.qty ??
            (r as { volume?: number }).volume ??
            (r as { size?: number }).size ??
            0,
        );
        const side = String(r.side ?? '').toLowerCase();
        const isBuy =
          side === 'buy' ||
          (r as { isBuyerMaker?: boolean }).isBuyerMaker === false;
        return {
          id: String((r as { tradeId?: string }).tradeId ?? `${tsMs}-${i}`),
          time: tsMs,
          price,
          size,
          side: isBuy ? 'buy' : 'sell',
        };
      },
    );

    let tradesSource: 'questdb' | 'runtime-fallback' | 'empty' =
      trades.length > 0 ? 'questdb' : 'empty';
    const runtimeSnapshot = this.exchangeDataService.getMarketQualitySnapshot(sym);
    if (bids.length === 0 && asks.length === 0 && runtimeSnapshot?.orderbook) {
      bids = (runtimeSnapshot.orderbook.bids ?? [])
        .map(
          (level) =>
            [Number(level?.price ?? 0), Number(level?.volume ?? 0)] as [
              number,
              number,
            ],
        )
        .filter(
          ([price, volume]) =>
            Number.isFinite(price) &&
            price > 0 &&
            Number.isFinite(volume) &&
            volume > 0,
        )
        .sort((left, right) => right[0] - left[0])
        .slice(0, obLimit);
      asks = (runtimeSnapshot.orderbook.asks ?? [])
        .map(
          (level) =>
            [Number(level?.price ?? 0), Number(level?.volume ?? 0)] as [
              number,
              number,
            ],
        )
        .filter(
          ([price, volume]) =>
            Number.isFinite(price) &&
            price > 0 &&
            Number.isFinite(volume) &&
            volume > 0,
        )
        .sort((left, right) => left[0] - right[0])
        .slice(0, obLimit);
      if (bids.length > 0 || asks.length > 0) {
        orderbookSource = 'runtime-fallback';
      }
    }

    const runtimeTrades =
      trades.length === 0
        ? this.exchangeDataService.getRecentRuntimeTrades(sym, trLimit)
        : [];
    if (trades.length === 0 && runtimeTrades.length > 0) {
      trades.push(
        ...runtimeTrades.map((row) => ({
          id: row.id,
          time: row.time,
          price: row.price,
          size: row.size,
          side: row.side,
        })),
      );
      tradesSource = 'runtime-fallback';
    }

    // candlesSource 'empty': no rows in QuestDB for this symbol/connector/market/interval, and no runtime fallback for min1 (runtime only has h1/h4/d1)
    let candlesSource: 'questdb' | 'runtime-fallback' | 'empty' = 'empty';
    const candles = (Array.isArray(candleRows) ? candleRows : [])
      .map((row) => {
        const time = this.toTimestampMs((row as { ts?: unknown }).ts);
        const open = Number((row as { open?: unknown }).open ?? 0);
        const high = Number((row as { high?: unknown }).high ?? 0);
        const low = Number((row as { low?: unknown }).low ?? 0);
        const close = Number((row as { close?: unknown }).close ?? 0);
        const volume = Number((row as { volume?: unknown }).volume ?? 0);
        return { time, open, high, low, close, volume };
      })
      .filter((row) => row.time > 0 && row.close > 0)
      .reverse();
    if (candles.length > 0) {
      candlesSource = 'questdb';
    } else if (runtimeSnapshot?.candles) {
      const runtimeKey: 'h1' | 'h4' | 'd1' =
        normalizedInterval === 'h4'
          ? 'h4'
          : normalizedInterval === 'day'
          ? 'd1'
          : 'h1';
      const runtimeCandles = (runtimeSnapshot.candles?.[runtimeKey] ?? [])
        .map((row) => ({
          time: this.toTimestampMs((row as { time?: unknown }).time),
          open: Number((row as { open?: unknown }).open ?? 0),
          high: Number((row as { high?: unknown }).high ?? 0),
          low: Number((row as { low?: unknown }).low ?? 0),
          close: Number((row as { close?: unknown }).close ?? 0),
          volume: Number((row as { volume?: unknown }).volume ?? 0),
        }))
        .filter((row) => row.time > 0 && row.close > 0);
      if (runtimeCandles.length > 0) {
        candles.push(
          ...runtimeCandles.slice(Math.max(0, runtimeCandles.length - cLimit)),
        );
        candlesSource = 'runtime-fallback';
      }
    }

    const marketQualityReport = runtimeSnapshot
      ? this.exchangeDataService.getMarketQualityReport(sym, runtimeSnapshot)
      : null;
    const marketQuality =
      runtimeSnapshot && marketQualityReport
        ? {
            symbol: sym,
            healthScore: marketQualityReport.healthScore,
            valid: marketQualityReport.valid,
            critical: marketQualityReport.critical,
            componentStatuses: marketQualityReport.componentStatuses,
            reasons: marketQualityReport.reasons,
            checkedAt: marketQualityReport.checkedAt,
            bestBid: Number(runtimeSnapshot.orderbook?.bestBid ?? 0),
            bestAsk: Number(runtimeSnapshot.orderbook?.bestAsk ?? 0),
            mid: Number(runtimeSnapshot.orderbook?.mid ?? 0),
            spread: Number(runtimeSnapshot.orderbook?.spread ?? 0),
            spreadPct: Number(runtimeSnapshot.orderbook?.spreadPct ?? 0),
            orderbookDepth: Number(runtimeSnapshot.orderbook?.depth ?? 0),
            tradeCount: Number(runtimeSnapshot.trades?.tradeCount ?? 0),
            buyVolume: Number(runtimeSnapshot.trades?.buyVolume ?? 0),
            sellVolume: Number(runtimeSnapshot.trades?.sellVolume ?? 0),
            vwap: Number(runtimeSnapshot.trades?.vwap ?? 0),
            avgTradeSize: Number(runtimeSnapshot.trades?.avgTradeSize ?? 0),
            maxTradeSize: Number(runtimeSnapshot.trades?.maxTradeSize ?? 0),
            lastTradeTimestamp: Number(
              runtimeSnapshot.trades?.lastTrade?.timestamp ?? 0,
            ),
            orderbookTimestamp: Number(
              runtimeSnapshot.timestamps?.orderbookTimestamp ?? 0,
            ),
            tradeTimestamp: Number(
              runtimeSnapshot.timestamps?.tradeTimestamp ?? 0,
            ),
            candleTimestamp: Number(
              runtimeSnapshot.timestamps?.candleTimestamp ?? 0,
            ),
            horizontalVolumeProfile:
              runtimeSnapshot.trades?.horizontalVolumeProfileSummary,
            liquidityMap: runtimeSnapshot.trades?.liquidityMap ?? {},
          }
        : null;

    return {
      symbol: sym,
      candles,
      orderbook: { bids, asks },
      trades,
      marketQuality,
      sourceMeta: {
        connectorType: normalizedConnector,
        marketType: normalizedMarket,
        candlesInterval: normalizedInterval,
        candlesSource,
        orderbookSource,
        tradesSource,
        marketQualitySource: marketQuality ? 'runtime' : 'unavailable',
      },
    };
  }

  @Get('market-data/dashboard')
  @ApiOperation({
    summary: 'Market data dashboard',
    description:
      'Returns dashboard stats: candles, trades, orderbook row counts, latest ts, lag, retention. Used for observability.',
  })
  @ApiOkResponse({
    description: 'candles, trades, orderbook, retention, storage',
  })
  async getMarketDataDashboard() {
    const [
      rawTradesCount,
      rawTradesLatest,
      obTopCount,
      obTopLatest,
      candleCount,
      candleLatest,
      featuresCount,
      obFeaturesCount,
      obSnapCount,
    ] = await Promise.all([
      this.reader.queryValue(`SELECT count() FROM raw_trades`).catch(() => 0),
      this.reader
        .queryValue(`SELECT max(ts) FROM raw_trades`)
        .catch(() => null),
      this.reader
        .queryValue(`SELECT count() FROM orderbook_top`)
        .catch(() => 0),
      this.reader
        .queryValue(`SELECT max(ts) FROM orderbook_top`)
        .catch(() => null),
      this.reader.queryValue(`SELECT count() FROM candles`).catch(() => 0),
      this.reader.queryValue(`SELECT max(ts) FROM candles`).catch(() => null),
      this.reader
        .queryValue(`SELECT count() FROM trade_features`)
        .catch(() => 0),
      this.reader
        .queryValue(`SELECT count() FROM orderbook_features`)
        .catch(() => 0),
      this.reader
        .queryValue(`SELECT count() FROM orderbook_snapshots`)
        .catch(() => 0),
    ]);
    const now = Date.now();
    const rawTradesTs =
      rawTradesLatest != null ? new Date(rawTradesLatest).getTime() : null;
    const obTopTs =
      obTopLatest != null ? new Date(obTopLatest).getTime() : null;
    const candleTs =
      candleLatest != null ? new Date(candleLatest).getTime() : null;
    const lagWarning = MARKET_DATA_LAG_WARNING_MS;
    const lagStale = MARKET_DATA_STALE_MS;
    const tradeLag = rawTradesTs != null ? now - rawTradesTs : null;
    const obLag = obTopTs != null ? now - obTopTs : null;
    const tradeStreamStatus =
      tradeLag == null
        ? 'STALE'
        : tradeLag >= lagStale
        ? 'STALE'
        : tradeLag >= lagWarning
        ? 'LAGGING'
        : 'OK';
    const orderbookStreamStatus =
      obLag == null
        ? 'STALE'
        : obLag >= lagStale
        ? 'STALE'
        : obLag >= lagWarning
        ? 'LAGGING'
        : 'OK';
    return {
      candles: {
        rowCount: Number(candleCount ?? 0),
        candles_latest_ts: candleLatest ?? null,
        lag_ms: candleTs != null ? now - candleTs : null,
      },
      trades: {
        raw_rowCount: Number(rawTradesCount ?? 0),
        trades_latest_ts: rawTradesLatest ?? null,
        latest_ts: rawTradesLatest ?? null,
        lag_ms: tradeLag,
        trade_stream_status: tradeStreamStatus,
      },
      orderbook: {
        top_rowCount: Number(obTopCount ?? 0),
        orderbook_latest_ts: obTopLatest ?? null,
        latest_ts: obTopLatest ?? null,
        lag_ms: obLag,
        orderbook_stream_status: orderbookStreamStatus,
      },
      retention: this.retention.getRetentionConfig(),
      storage: {
        raw_trades_rows: Number(rawTradesCount ?? 0),
        trade_features_rows: Number(featuresCount ?? 0),
        orderbook_top_rows: Number(obTopCount ?? 0),
        orderbook_snapshots_rows: Number(obSnapCount ?? 0),
        orderbook_features_rows: Number(obFeaturesCount ?? 0),
        candles_rows: Number(candleCount ?? 0),
        approximate_daily_ingestion_note:
          'Daily rates can be estimated from (row delta over 24h) or from connector ingest logs.',
      },
    };
  }
}
