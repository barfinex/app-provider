import {
  Body,
  Controller,
  Delete,
  Get,
  InternalServerErrorException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';

import { DetectorService } from './detector.service';
import { ConnectorService } from '../connector/connector.service';

import { Detector, DetectorListItem, TradingSymbol, TimeFrame } from '@barfinex/types';
import {
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiParam,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';

@ApiTags('Detectors')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('detectors')
export class DetectorController {
  constructor(
    private readonly connectorService: ConnectorService,
    private readonly detectorService: DetectorService,
  ) {}

  @Get(':key/capital-efficiency/overview')
  @ApiOperation({
    summary: 'Proxy detector capital efficiency overview',
    description:
      'Returns capital efficiency overview for the detector. Proxies to Detector service. Optional filters: from, to, instanceId, symbol.',
  })
  @ApiParam({ name: 'key', description: 'Detector key or sysname' })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description: 'Start of time range (ISO or ms)',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description: 'End of time range (ISO or ms)',
  })
  @ApiQuery({ name: 'instanceId', required: false, type: String })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Capital efficiency overview' })
  async getCapitalEfficiencyOverview(
    @Param('key') key: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('instanceId') instanceId?: string,
    @Query('symbol') symbol?: string,
  ) {
    return this.detectorService.getCapitalEfficiency(key, 'overview', {
      from,
      to,
      instanceId,
      symbol,
    });
  }

  @Get(':key/capital-efficiency/utilization')
  @ApiOperation({
    summary: 'Proxy detector capital efficiency utilization',
    description:
      'Returns capital efficiency utilization for the detector. Optional filters: from, to, instanceId, symbol.',
  })
  @ApiParam({ name: 'key', description: 'Detector key or sysname' })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'instanceId', required: false, type: String })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Capital efficiency utilization' })
  async getCapitalEfficiencyUtilization(
    @Param('key') key: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('instanceId') instanceId?: string,
    @Query('symbol') symbol?: string,
  ) {
    return this.detectorService.getCapitalEfficiency(key, 'utilization', {
      from,
      to,
      instanceId,
      symbol,
    });
  }

  @Get(':key/capital-efficiency/suppression')
  @ApiOperation({
    summary: 'Proxy detector capital efficiency suppression',
    description:
      'Returns capital efficiency suppression metrics for the detector. Optional filters: from, to, instanceId, symbol.',
  })
  @ApiParam({ name: 'key', description: 'Detector key or sysname' })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'instanceId', required: false, type: String })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Capital efficiency suppression' })
  async getCapitalEfficiencySuppression(
    @Param('key') key: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('instanceId') instanceId?: string,
    @Query('symbol') symbol?: string,
  ) {
    return this.detectorService.getCapitalEfficiency(key, 'suppression', {
      from,
      to,
      instanceId,
      symbol,
    });
  }

  @Get(':key/capital-efficiency/symbols')
  @ApiOperation({
    summary: 'Proxy detector capital efficiency symbols',
    description:
      'Returns capital efficiency per-symbol data for the detector. Optional filters: from, to, instanceId, symbol.',
  })
  @ApiParam({ name: 'key', description: 'Detector key or sysname' })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'instanceId', required: false, type: String })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Capital efficiency symbols' })
  async getCapitalEfficiencySymbols(
    @Param('key') key: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('instanceId') instanceId?: string,
    @Query('symbol') symbol?: string,
  ) {
    return this.detectorService.getCapitalEfficiency(key, 'symbols', {
      from,
      to,
      instanceId,
      symbol,
    });
  }

  @Get(':key/capital-efficiency/reservations')
  @ApiOperation({
    summary: 'Proxy detector capital efficiency reservations',
    description:
      'Returns capital efficiency reservations for the detector. Optional filters: from, to, instanceId, symbol.',
  })
  @ApiParam({ name: 'key', description: 'Detector key or sysname' })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'instanceId', required: false, type: String })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Capital efficiency reservations' })
  async getCapitalEfficiencyReservations(
    @Param('key') key: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('instanceId') instanceId?: string,
    @Query('symbol') symbol?: string,
  ) {
    return this.detectorService.getCapitalEfficiency(key, 'reservations', {
      from,
      to,
      instanceId,
      symbol,
    });
  }

  @Get(':key/capital-efficiency/stability')
  @ApiOperation({
    summary: 'Proxy detector capital efficiency stability',
    description:
      'Returns capital efficiency stability metrics for the detector. Optional filters: from, to, instanceId, symbol.',
  })
  @ApiParam({ name: 'key', description: 'Detector key or sysname' })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'instanceId', required: false, type: String })
  @ApiQuery({ name: 'symbol', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Capital efficiency stability' })
  async getCapitalEfficiencyStability(
    @Param('key') key: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('instanceId') instanceId?: string,
    @Query('symbol') symbol?: string,
  ) {
    return this.detectorService.getCapitalEfficiency(key, 'stability', {
      from,
      to,
      instanceId,
      symbol,
    });
  }

  // -------------------------------------------------------
  // GET ALL DETECTORS FOR CURRENT PROVIDER
  // -------------------------------------------------------
  @Get()
  @ApiOperation({
    summary: 'List all detectors',
    description: 'Returns all detectors for the current Provider key.',
  })
  @ApiResponse({ status: 200, description: 'List of detector list items' })
  async getAll(): Promise<DetectorListItem[]> {
    const key = this.connectorService.key;

    if (!key) {
      throw new InternalServerErrorException(
        'Provider key not initialized yet',
      );
    }

    return this.detectorService.getAllDetectorsByProviderKey(key);
  }

  // -------------------------------------------------------
  // GET ONE DETECTOR
  // -------------------------------------------------------
  @Get(':key')
  @ApiOperation({
    summary: 'Get detector by key',
    description: 'Returns a single detector by key (or sysname).',
  })
  @ApiParam({ name: 'key', description: 'Detector key or sysname' })
  @ApiResponse({ status: 200, description: 'Detector' })
  async get(@Param('key') key: string) {
    return this.detectorService.getDetector({ key });
  }

  // -------------------------------------------------------
  // CREATE NEW DETECTOR
  // -------------------------------------------------------
  @Post()
  @ApiOperation({
    summary: 'Create detector',
    description: 'Registers a new detector. Body: detector object.',
  })
  @ApiResponse({ status: 201, description: 'Created detector' })
  async registration(@Body('detector') detector: Detector) {
    console.log('Registration detector:', detector);

    return await this.detectorService.createDetector(detector);
  }

  // -------------------------------------------------------
  // UPDATE DETECTOR CONFIG
  // -------------------------------------------------------
  @Put(':key')
  @ApiOperation({
    summary: 'Update detector',
    description: 'Updates detector config by key. Body: options (Detector).',
  })
  @ApiParam({ name: 'key', description: 'Detector key' })
  @ApiResponse({ status: 200, description: 'Updated detector' })
  async update(@Param('key') key: string, @Body('options') options: Detector) {
    const updated = await this.detectorService.updateDetectorByKey(
      key,
      options,
    );
    if (!updated) return null;

    // Пересобираем подписки (как в старой логике)
    const activeSymbols = await this.detectorService.getAllActiveSymbols();

    for (const provider of options.providers) {
      if (!provider.connectors) continue;

      for (const connector of provider.connectors) {
        for (const market of connector.markets) {
          await this.detectorService.updateSubscribeCollectionInConnector({
            connectorType: connector.connectorType,
            marketType: market.marketType,
            symbols: activeSymbols,
            intervals: options.intervals,
          });
        }
      }
    }

    return updated;
  }

  // -------------------------------------------------------
  // DELETE DETECTOR BY KEY
  // -------------------------------------------------------
  @Delete(':key')
  @ApiOperation({
    summary: 'Delete detector',
    description: 'Deletes detector by key and cleans up orders/subscriptions.',
  })
  @ApiParam({ name: 'key', description: 'Detector key' })
  @ApiResponse({ status: 200, description: 'true if deleted' })
  async delete(@Param('key') key: string) {
    const detector = await this.detectorService.getDetector({ key });
    if (!detector) return false;

    let isDelete = false;

    for (const provider of detector.providers) {
      if (!provider.connectors) continue;

      for (const connector of provider.connectors) {
        for (const market of connector.markets) {
          // 1. Удаляем ордера для этого детектора
          await this.detectorService.deleteAllOrders({
            connectorType: connector.connectorType,
            marketType: market.marketType,
            sysname: detector.sysname,
          });

          // 2. Удаляем детектор
          isDelete = await this.detectorService.deleteDetectorByKey(key);

          // 3. Перестраиваем подписки
          const activeSymbols =
            await this.detectorService.getAllActiveSymbols();

          await this.detectorService.updateSubscribeCollectionInConnector({
            connectorType: connector.connectorType,
            marketType: market.marketType,
            symbols: activeSymbols,
            intervals: detector.intervals,
          });
        }
      }
    }

    return isDelete;
  }

  // -------------------------------------------------------
  // PLUGINS
  // -------------------------------------------------------
  @Get(':key/plugins/:pluginkey')
  @ApiOperation({
    summary: 'Get detector plugin state',
    description:
      'Returns the runtime state for a plugin attached to the detector. Used to inspect plugin data (e.g. trade journal, orderflow analytics) by pluginkey.',
  })
  @ApiParam({ name: 'key', description: 'Detector key or sysname' })
  @ApiParam({
    name: 'pluginkey',
    description: 'Plugin key (e.g. trade-journal, orderflow-trade-analytics)',
  })
  @ApiResponse({
    status: 200,
    description: 'Plugin state object (structure depends on plugin)',
  })
  async getDetectorPluginState(
    @Param('key') key: string,
    @Param('pluginkey') pluginkey: string,
  ) {
    return this.detectorService.getPluginState(key, pluginkey);
  }

  // -------------------------------------------------------
  // SYMBOLS
  // -------------------------------------------------------
  @Get(':key/symbols')
  @ApiOperation({
    summary: 'List detector symbols',
    description:
      'Returns the list of trading symbols configured for the detector. Used to inspect which symbols the detector subscribes to.',
  })
  @ApiParam({ name: 'key', description: 'Detector key or sysname' })
  @ApiResponse({
    status: 200,
    description: 'Array of symbol names or Symbol objects',
  })
  async getDetectorSymbols(@Param('key') key: string) {
    return this.detectorService.getSymbols(key);
  }

  @Get(':key/symbols/:symbol')
  @ApiOperation({
    summary: 'Get detector symbol state',
    description:
      'Returns the runtime state for a single symbol within the detector (e.g. candle/indicator readiness).',
  })
  @ApiParam({ name: 'key', description: 'Detector key or sysname' })
  @ApiParam({ name: 'symbol', description: 'Trading symbol (e.g. BTCUSDT)' })
  @ApiResponse({ status: 200, description: 'Symbol state object' })
  async getDetectorSymbolState(
    @Param('key') key: string,
    @Param('symbol') symbol: string,
  ) {
    return this.detectorService.getSymbolState(key, symbol);
  }

  // -------------------------------------------------------
  // CANDLES
  // -------------------------------------------------------
  @Get(':key/symbols/:symbol/candles')
  @ApiOperation({
    summary: 'List detector candle intervals for symbol',
    description:
      'Returns the list of candle intervals configured for the detector for the given symbol (e.g. 1m, 5m, h1).',
  })
  @ApiParam({ name: 'key', description: 'Detector key or sysname' })
  @ApiParam({ name: 'symbol', description: 'Trading symbol (e.g. BTCUSDT)' })
  @ApiResponse({
    status: 200,
    description: 'Array of interval strings (e.g. min1, min5, h1)',
  })
  async getDetectorSymbolCandles(
    @Param('key') key: string,
    @Param('symbol') symbol: string,
  ) {
    const detector = await this.detectorService.getDetector({ key });
    return detector.intervals;
  }

  @Get(':key/symbols/:symbol/candles/:interval')
  @ApiOperation({
    summary: 'Get detector symbol candles state',
    description:
      'Returns candle state (e.g. last timestamp, count) for the detector symbol and interval. Optional orderBy for sort direction.',
  })
  @ApiParam({ name: 'key', description: 'Detector key or sysname' })
  @ApiParam({ name: 'symbol', description: 'Trading symbol (e.g. BTCUSDT)' })
  @ApiParam({
    name: 'interval',
    description: 'Candle interval (e.g. 1m, min5, h1)',
  })
  @ApiQuery({
    name: 'orderBy',
    required: false,
    description: 'Sort order (e.g. asc, desc)',
  })
  @ApiResponse({ status: 200, description: 'Candle state for the series' })
  async getDetectorSymbolCandlesState(
    @Param('key') key: string,
    @Param('symbol') symbol: string,
    @Param('interval') interval: TimeFrame,
    @Query() reqParams: any,
  ) {
    const { orderBy } = reqParams;
    return this.detectorService.getSymbolCandlesState({
      key,
      symbol: { name: symbol },
      interval,
      orderBy,
    });
  }

  // -------------------------------------------------------
  // INDICATORS
  // -------------------------------------------------------
  @Get(':key/symbols/:symbol/indicators')
  @ApiOperation({
    summary: 'List detector indicators for symbol',
    description:
      'Returns the list of indicators configured for the detector (e.g. EMA, MACD). Used to inspect indicator config for the symbol.',
  })
  @ApiParam({ name: 'key', description: 'Detector key or sysname' })
  @ApiParam({ name: 'symbol', description: 'Trading symbol (e.g. BTCUSDT)' })
  @ApiResponse({ status: 200, description: 'Array of indicator configs' })
  async getDetectorSymbolIndicators(
    @Param('key') key: string,
    @Param('symbol') symbol: string,
  ) {
    const detector = await this.detectorService.getDetector({ key });
    return detector.indicators;
  }

  @Get(':key/symbols/:symbol/indicators/:interval')
  @ApiOperation({
    summary: 'Get detector symbol indicator state',
    description:
      'Returns computed indicator values for the detector symbol and interval. Optional selectIndicators to filter which indicators to return.',
  })
  @ApiParam({ name: 'key', description: 'Detector key or sysname' })
  @ApiParam({ name: 'symbol', description: 'Trading symbol (e.g. BTCUSDT)' })
  @ApiParam({
    name: 'interval',
    description: 'Candle interval (e.g. 1m, min5, h1)',
  })
  @ApiQuery({
    name: 'selectIndicators',
    required: false,
    description: 'Comma-separated indicator names to include',
  })
  @ApiResponse({
    status: 200,
    description: 'Indicator state (values per indicator)',
  })
  async getDetectorSymbolIndicatorState(
    @Param('key') key: string,
    @Param('symbol') symbol: string,
    @Param('interval') interval: TimeFrame,
    @Query() reqParams: any,
  ) {
    const { selectIndicators } = reqParams;

    return this.detectorService.getSymbolIndocatorState({
      key,
      symbol: { name: symbol },
      selectIndicators,
      interval,
    });
  }
}
