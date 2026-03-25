import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Inject,
  forwardRef,
} from '@nestjs/common';

import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiQuery,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';

import { OrderService } from './order.service';
import { OrderIdempotencyService } from './order-idempotency.service';
import { DetectorService } from '../detector/detector.service';
import { ConnectorService } from '../connector/connector.service';

import {
  ConnectorType,
  MarketType,
  Order,
  OrderSourceType,
  TradingSymbol,
} from '@barfinex/types';

@ApiTags('Orders')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('orders')
export class OrderController {
  private readonly logger = new Logger(OrderController.name);

  constructor(
    private readonly orderService: OrderService,
    private readonly orderIdempotencyService: OrderIdempotencyService,

    @Inject(forwardRef(() => DetectorService))
    private readonly detectorService: DetectorService,

    @Inject(forwardRef(() => ConnectorService))
    private readonly connectorService: ConnectorService,
  ) {}

  // ========================================================
  // CREATE ORDER
  // ========================================================
  @Post()
  @ApiOperation({
    summary: 'Create order',
    description:
      'Places a new order. Supports idempotency via order.idempotencyKey; duplicate keys return cached result or 409 while processing.',
  })
  @ApiBody({
    description: 'Order object; optional idempotencyKey for idempotent create',
  })
  @ApiOkResponse({ description: 'Created order' })
  async create(@Body('order') order: Order) {
    const idempotencyKey = (order as Order & { idempotencyKey?: string })
      ?.idempotencyKey;
    if (!idempotencyKey) {
      return this.orderService.openOrder(order);
    }

    const processingStarted =
      await this.orderIdempotencyService.tryStartProcessing(idempotencyKey);

    if (processingStarted) {
      this.logger.log(
        `[provider-idempotency] processing_started key=${idempotencyKey}`,
      );

      const result = await this.orderService.openOrder(order);
      await this.orderIdempotencyService.setFinalResponse(
        idempotencyKey,
        result,
      );
      return result;
    }

    const replay = await this.orderIdempotencyService.getFinalResponse<Order>(
      idempotencyKey,
    );
    if (replay) {
      this.logger.log(`[provider-idempotency] replay key=${idempotencyKey}`);
      return replay;
    }

    const replayAfterWait =
      await this.orderIdempotencyService.waitForFinalResponse<Order>(
        idempotencyKey,
        {
          maxWaitMs: 1200,
          pollIntervalMs: 100,
        },
      );
    if (replayAfterWait) {
      this.logger.log(`[provider-idempotency] replay key=${idempotencyKey}`);
      return replayAfterWait;
    }

    this.logger.warn(
      `[provider-idempotency] still_processing key=${idempotencyKey}`,
    );
    throw new ConflictException(
      'Order with this idempotencyKey is still processing. Retry later.',
    );
  }

  // ========================================================
  // GET ORDER BY ID
  // ========================================================
  @Get(':orderId')
  @ApiOperation({
    summary: 'Get order by ID',
    description: 'Returns a single order by ID.',
  })
  @ApiParam({ name: 'orderId', description: 'Order ID' })
  @ApiOkResponse({ description: 'Order' })
  @ApiNotFoundResponse({ description: 'Order not found' })
  async get(@Param('orderId') id: string) {
    return this.orderService.get(id);
  }

  // ========================================================
  // CLOSE ORDER
  // ========================================================
  @Put('close')
  @ApiOperation({
    summary: 'Close order',
    description: 'Closes an open order. Body: order object.',
  })
  @ApiBody({ description: 'Order to close' })
  @ApiOkResponse({ description: 'Close result' })
  async closeOrder(@Body('order') order: Order) {
    return this.orderService.closeOrder(order);
  }

  // ========================================================
  // UPDATE ORDER
  // ========================================================
  @Put(':orderId')
  @ApiOperation({
    summary: 'Update order',
    description: 'Updates an order by ID. Body: order object.',
  })
  @ApiParam({ name: 'orderId', description: 'Order ID' })
  @ApiBody({ description: 'Order updates' })
  @ApiOkResponse({ description: 'Updated order' })
  async update(@Param('orderId') id: string, @Body('order') order: Order) {
    return this.orderService.updateOrder({ id, order });
  }

  // ========================================================
  // GET OPEN ORDERS BY CONNECTOR + MARKET
  // ========================================================
  @Get(':connectorType/:marketType')
  @ApiOperation({
    summary: 'Get open orders by connector and market',
    description:
      'Returns open orders for the given connector type and market type. Uses symbols from connector config. Query params are forwarded to the order service (e.g. symbol, limit).',
  })
  @ApiParam({
    name: 'connectorType',
    example: 'BINANCE',
    description: 'Connector type',
  })
  @ApiParam({
    name: 'marketType',
    example: 'FUTURES',
    description: 'Market type (SPOT, FUTURES)',
  })
  @ApiQuery({
    name: 'symbol',
    required: false,
    description: 'Filter by symbol',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max orders to return',
  })
  @ApiOkResponse({ description: 'Array of open orders' })
  async allByConnectorMarket(
    @Param('connectorType') connectorType: ConnectorType,
    @Param('marketType') marketType: MarketType,
    @Query() query: any,
  ) {
    const connector = await this.connectorService.get({
      connectorType,
      marketType,
    });
    const targetMarket = connector.markets?.find(
      (m) => m.marketType === marketType,
    );
    const symbols = targetMarket?.symbols ?? [];

    if (!symbols.length) return [];

    const providerKey = this.connectorService.key || 'provider';
    const openOrders = await this.orderService.getOpenOrders({
      connectorType,
      marketType,
      symbols,
      source: {
        key: providerKey,
        type: OrderSourceType.provider,
        restApiUrl: null,
      },
      query,
    });

    return Array.isArray(openOrders) ? openOrders : openOrders.data;
  }

  // ========================================================
  // GET OPEN ORDERS BY DETECTOR
  // ========================================================
  @Get('detector/:sysname')
  @ApiOperation({
    summary: 'Get open orders by detector',
    description:
      'Returns all open orders for the detector identified by sysname, across all its connector/market/symbol configs. Query params (e.g. symbol) are forwarded to the order service.',
  })
  @ApiParam({ name: 'sysname', description: 'Detector system name' })
  @ApiQuery({
    name: 'symbol',
    required: false,
    description: 'Filter by symbol',
  })
  @ApiOkResponse({ description: 'Array of { id, order } for open orders' })
  async allByDetector(@Param('sysname') sysname: string, @Query() query: any) {
    const result: Array<{ id: string; order: Order }> = [];

    const detector = await this.detectorService.getDetector({ sysname });

    for (const provider of detector.providers) {
      for (const connector of provider.connectors ?? []) {
        for (const market of connector.markets) {
          const openOrders = await this.orderService.getOpenOrders({
            connectorType: connector.connectorType,
            marketType: market.marketType,
            useSandbox: detector.useSandbox,
            source: {
              key: sysname,
              type: OrderSourceType.detector,
              restApiUrl: null,
            },
            symbols: market.symbols,
            query,
          });

          const rows = Array.isArray(openOrders) ? openOrders : openOrders.data;

          result.push(...rows);
        }
      }
    }

    return result;
  }

  // ========================================================
  // GET ORDERS COUNT BY DETECTOR
  // ========================================================
  @Get('detector/:sysname/count')
  @ApiOperation({
    summary: 'Get order count by detector',
    description:
      'Returns per-symbol open order counts for the detector. Used for dashboards and risk overview.',
  })
  @ApiParam({ name: 'sysname', description: 'Detector system name' })
  @ApiOkResponse({ description: 'Array of { symbol, ordersCount }' })
  async allCountByDetector(@Param('sysname') sysname: string) {
    const result: Array<{ symbol: TradingSymbol; ordersCount: number }> = [];

    const detector = await this.detectorService.getDetector({ sysname });

    for (const provider of detector.providers) {
      for (const connector of provider.connectors ?? []) {
        for (const market of connector.markets) {
          const counts = await this.orderService.getOpenOrdersCount({
            sourceSysname: sysname,
            sourceType: OrderSourceType.detector,
            symbols: market.symbols,
          });

          result.push(...counts);
        }
      }
    }

    return result;
  }

  // ========================================================
  // GET OPEN ORDERS BY DETECTOR + SYMBOL
  // ========================================================
  @Get('detector/:sysname/symbol/:symbol')
  @ApiOperation({
    summary: 'Get open orders by detector and symbol',
    description:
      'Returns open orders for the detector and symbol. Query params are forwarded to the order service.',
  })
  @ApiParam({ name: 'sysname', description: 'Detector system name' })
  @ApiParam({ name: 'symbol', description: 'Trading symbol (e.g. BTCUSDT)' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max orders to return',
  })
  @ApiOkResponse({ description: 'Array of { id, order } for open orders' })
  async allByDetectorBySymbol(
    @Param('sysname') sysname: string,
    @Param('symbol') symbolName: string,
    @Query() query: any,
  ) {
    const result: Array<{ id: string; order: Order }> = [];

    const symbolObj: TradingSymbol = { name: symbolName };

    const detector = await this.detectorService.getDetector({ sysname });

    for (const provider of detector.providers) {
      for (const connector of provider.connectors ?? []) {
        for (const market of connector.markets) {
          const openOrders = await this.orderService.getOpenOrders({
            connectorType: connector.connectorType,
            marketType: market.marketType,
            symbol: symbolObj,
            useSandbox: detector.useSandbox,
            source: {
              key: sysname,
              type: OrderSourceType.detector,
              restApiUrl: null,
            },
            symbols: market.symbols,
            query,
          });

          const rows = Array.isArray(openOrders) ? openOrders : openOrders.data;

          result.push(...rows);
        }
      }
    }

    return result;
  }

  // ========================================================
  // DELETE ALL ORDERS BY DETECTOR
  // ========================================================
  @Delete('detector/:sysname')
  @ApiOperation({
    summary: 'Delete all orders for detector',
    description:
      'Closes and removes all open orders for the detector across all connector/market configs. Use with caution.',
  })
  @ApiParam({ name: 'sysname', description: 'Detector system name' })
  @ApiOkResponse({ description: 'true if any orders were deleted' })
  async deleteAllByDetector(@Param('sysname') sysname: string) {
    let result = false;

    const detector = await this.detectorService.getDetector({ sysname });

    for (const provider of detector.providers) {
      for (const connector of provider.connectors ?? []) {
        for (const market of connector.markets) {
          await this.orderService.deleteAll({
            connectorType: connector.connectorType,
            marketType: market.marketType,
          });

          result = true;
        }
      }
    }

    return result;
  }

  // ========================================================
  // DELETE ALL ORDERS BY DETECTOR + SYMBOL
  // ========================================================
  @Delete('detector/:sysname/symbol/:symbol')
  @ApiOperation({
    summary: 'Delete all orders for detector and symbol',
    description:
      'Closes and removes all open orders for the detector and symbol. Use with caution.',
  })
  @ApiParam({ name: 'sysname', description: 'Detector system name' })
  @ApiParam({ name: 'symbol', description: 'Trading symbol (e.g. BTCUSDT)' })
  @ApiOkResponse({ description: 'true if any orders were deleted' })
  async deleteAllByDetectorBySymbol(
    @Param('sysname') sysname: string,
    @Param('symbol') symbolName: string,
  ) {
    let result = false;

    const detector = await this.detectorService.getDetector({ sysname });

    for (const provider of detector.providers) {
      for (const connector of provider.connectors ?? []) {
        for (const market of connector.markets) {
          await this.orderService.deleteAll({
            connectorType: connector.connectorType,
            marketType: market.marketType,
          });

          result = true;
        }
      }
    }

    return result;
  }

  // ========================================================
  // DELETE ORDER BY ID + CONNECTOR + MARKET
  // ========================================================
  @Delete(':id/:connectorType/:marketType')
  @ApiOperation({
    summary: 'Delete order by ID and connector/market',
    description:
      'Closes the order by ID. ConnectorType and marketType must match the order; returns 400 if they do not.',
  })
  @ApiParam({ name: 'id', description: 'Order ID' })
  @ApiParam({
    name: 'connectorType',
    example: 'BINANCE',
    description: 'Connector type',
  })
  @ApiParam({
    name: 'marketType',
    example: 'FUTURES',
    description: 'Market type',
  })
  @ApiOkResponse({ description: 'true on success' })
  @ApiBadRequestResponse({
    description: 'Order does not belong to given connector/market',
  })
  async deleteByIdConnectorMarket(
    @Param('id') id: string,
    @Param('connectorType') connectorType: ConnectorType,
    @Param('marketType') marketType: MarketType,
  ) {
    const order = await this.orderService.get(id);

    if (
      order.connectorType !== connectorType ||
      order.marketType !== marketType
    ) {
      throw new BadRequestException(
        `Order ${id} does not belong to ${connectorType}/${marketType}`,
      );
    }

    await this.orderService.closeOrder(order);
    return true;
  }

  // ========================================================
  // DELETE ALL ORDERS BY CONNECTOR + MARKET
  // ========================================================
  @Delete('all/:connectorType/:marketType')
  @ApiOperation({
    summary: 'Delete all orders by connector and market',
    description:
      'Closes and removes all open orders for the given connector type and market type. Use with caution.',
  })
  @ApiParam({
    name: 'connectorType',
    example: 'BINANCE',
    description: 'Connector type',
  })
  @ApiParam({
    name: 'marketType',
    example: 'FUTURES',
    description: 'Market type',
  })
  @ApiOkResponse({ description: 'Result of deleteAll' })
  async deleteAllByConnectorMarket(
    @Param('connectorType') connectorType: ConnectorType,
    @Param('marketType') marketType: MarketType,
  ) {
    return this.orderService.deleteAll({ connectorType, marketType });
  }
}
