import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  Order,
  ConnectorType,
  MarketType,
  TradingSymbol,
  SubscriptionType,
  OrderSource,
  EventMessageByType,
} from '@barfinex/types';
import { ClientProxy } from '@nestjs/microservices';
import { randomUUID } from 'crypto';

// import {

//     AlpacaService,
//     TinkoffService,
//     TestnetBinanceFuturesService,
// } from './datasource';

import { ConnectorRegistry } from './connector.registry';
import { BinanceService } from './datasource/binance/binance.service';

@Injectable()
export class ConnectorTradeService {
  private readonly logger = new Logger(ConnectorTradeService.name);
  private readonly isEmitToRedisEnabled = true;
  private readonly eventSource = process.env.SERVICE_NAME || 'provider';
  private readonly transientEmitWarnThrottleMs = 10_000;
  private lastTransientEmitWarnAt = 0;

  constructor(
    private readonly binanceService: BinanceService,
    // private readonly alpacaService: AlpacaService,
    // private readonly tinkoffService: TinkoffService,
    // private readonly testnetBinanceFuturesService: TestnetBinanceFuturesService,

    @Inject('PROVIDER_SERVICE')
    private readonly client: ClientProxy,
  ) {}

  // =========================================================================
  // 🔹 LEVERAGE
  // =========================================================================

  async changeLeverage(
    connectorType: ConnectorType,
    symbol: TradingSymbol,
    newLeverage: number,
  ): Promise<TradingSymbol> {
    switch (connectorType) {
      case ConnectorType.binance:
        return await this.binanceService.changeLeverage(symbol, newLeverage);

      // case ConnectorType.testnetBinanceFutures:
      //     return await this.testnetBinanceFuturesService.changeLeverage(symbol, newLeverage);

      default:
        throw new Error(
          `[ConnectorTradeService] Unsupported connector type: ${connectorType}`,
        );
    }
  }

  // =========================================================================
  // 🔹 OPEN ORDER
  // =========================================================================

  async openOrder(order: Order): Promise<Order> {
    const subscriptionType = SubscriptionType.PROVIDER_ORDER_CREATE;
    const metadata = this.createEventMetadata(this.resolveTraceId(order));

    const subscriptionValue: EventMessageByType<SubscriptionType.PROVIDER_ORDER_CREATE> =
      {
        metadata,
        value: order,
        options: {
          connectorType: order.connectorType,
          marketType: order.marketType,
          key: ConnectorRegistry.key,
          updateMoment: Date.now(),
        },
      };

    let result: Order;

    switch (order.connectorType) {
      case ConnectorType.binance:
        result = await this.binanceService.openOrder(order);
        break;

      // case ConnectorType.alpaca:
      //     result = await this.alpacaService.openOrder(order);
      //     break;

      // case ConnectorType.tinkoff:
      //     result = await this.tinkoffService.openOrder(order);
      //     break;

      // case ConnectorType.testnetBinanceFutures:
      //     result = await this.testnetBinanceFuturesService.openOrder(order);
      //     break;

      default:
        throw new BadRequestException(
          `Unsupported connector type: ${order.connectorType}`,
        );
    }

    if (this.isEmitToRedisEnabled) {
      this.logger.debug(
        `[EVENT_TRACE]\ntraceId=${metadata.traceId}\neventType=${subscriptionType}\nservice=${this.eventSource}`,
      );
      this.safeEmit<EventMessageByType<SubscriptionType.PROVIDER_ORDER_CREATE>>(
        subscriptionType,
        subscriptionValue,
      );
    }

    return result;
  }

  // =========================================================================
  // 🔹 GET OPEN ORDERS
  // =========================================================================

  async getOpenOrders(options: {
    symbol: TradingSymbol;
    source: OrderSource;
    connectorType: ConnectorType;
    marketType: MarketType;
  }): Promise<Order[]> {
    const { symbol, connectorType, marketType } = options;

    switch (connectorType) {
      case ConnectorType.binance:
        return await this.binanceService.getOpenOrders({
          symbol,
          marketType,
        });

      case ConnectorType.alpaca:
        return [];

      case ConnectorType.tinkoff:
        return [];

      case ConnectorType.testnetBinanceFutures:
        return [];

      default:
        throw new BadRequestException(
          `Unsupported connector type: ${connectorType}`,
        );
    }
  }

  async getAllOpenOrders(options: {
    connectorType: ConnectorType;
    marketType: MarketType;
  }): Promise<Order[]> {
    switch (options.connectorType) {
      case ConnectorType.binance:
        return await this.binanceService.getOpenOrders({
          marketType: options.marketType,
        });

      // case ConnectorType.testnetBinanceFutures:
      //     return await this.testnetBinanceFuturesService.getOpenOrders({ marketType: options.marketType });

      default:
        throw new BadRequestException(
          `Unsupported connector type: ${options.connectorType}`,
        );
    }
  }

  // =========================================================================
  // 🔹 CLOSE ORDER
  // =========================================================================

  async closeOrder(order: Order): Promise<Order> {
    const { externalId, symbol, connectorType, marketType, source } = order;

    if (!externalId) {
      throw new BadRequestException(
        'Order.externalId is required to close order',
      );
    }

    if (!symbol) {
      throw new BadRequestException('Order.symbol is required to close order');
    }

    let result: Order = {
      useSandbox: false,
      connectorType,
      marketType,
      source,
      closeTime: null,
    };

    switch (connectorType) {
      case ConnectorType.binance:
        result = await this.binanceService.closeOrder({
          id: externalId,
          symbol,
          marketType,
        });
        break;

      // case ConnectorType.testnetBinanceFutures:
      //     result = await this.testnetBinanceFuturesService.closeOrder({
      //         id: externalId,
      //         symbol,
      //         marketType,
      //     });
      //     break;

      case ConnectorType.alpaca:
      case ConnectorType.tinkoff:
        throw new BadRequestException(
          `closeOrder not supported for ${connectorType}`,
        );

      default:
        throw new BadRequestException(
          `Unsupported connector type: ${connectorType}`,
        );
    }

    const metadata = this.createEventMetadata(this.resolveTraceId(order));
    const subscriptionValue: EventMessageByType<SubscriptionType.PROVIDER_ORDER_CLOSE> =
      {
        metadata,
        value: result,
        options: {
          connectorType: result.connectorType,
          marketType: result.marketType,
          key: ConnectorRegistry.key,
          updateMoment: Date.now(),
        },
      };

    if (this.isEmitToRedisEnabled) {
      this.logger.debug(
        `[EVENT_TRACE]\ntraceId=${metadata.traceId}\neventType=${SubscriptionType.PROVIDER_ORDER_CLOSE}\nservice=${this.eventSource}`,
      );
      this.safeEmit<EventMessageByType<SubscriptionType.PROVIDER_ORDER_CLOSE>>(
        SubscriptionType.PROVIDER_ORDER_CLOSE,
        subscriptionValue,
      );
    }

    return result;
  }

  private createEventMetadata(traceId?: string) {
    const eventId = randomUUID();
    return {
      eventId,
      traceId: traceId || eventId,
      timestamp: Date.now(),
      version: 1,
      source: this.eventSource,
    };
  }

  private resolveTraceId(order: Order): string | undefined {
    const payload = order as Order & {
      traceId?: string;
      source?: { meta?: { traceId?: string } };
    };
    return payload.traceId || payload.source?.meta?.traceId;
  }

  private safeEmit<TPayload>(type: SubscriptionType, payload: TPayload): void {
    try {
      const emission = this.client.emit<TPayload>(type, payload) as
        | {
            subscribe?: (observer: {
              error?: (error: unknown) => void;
            }) => unknown;
          }
        | undefined;
      emission?.subscribe?.({
        error: (error: unknown) => {
          if (this.isTransientEmitError(error)) {
            this.warnTransientEmit(type, error);
            return;
          }
          this.logger.warn(
            `Order event emit failed type=${type} error=${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      });
    } catch (error) {
      if (this.isTransientEmitError(error)) {
        this.warnTransientEmit(type, error);
        return;
      }
      this.logger.warn(
        `Order event emit failed type=${type} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private warnTransientEmit(type: SubscriptionType, error: unknown): void {
    const now = Date.now();
    if (now - this.lastTransientEmitWarnAt < this.transientEmitWarnThrottleMs)
      return;
    this.lastTransientEmitWarnAt = now;
    this.logger.warn(
      `Order event emit transient error type=${type} error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  private isTransientEmitError(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    const message = String(
      (error as { message?: unknown })?.message || error || '',
    ).toLowerCase();
    return (
      code === 'ECONNRESET' ||
      code === 'ECONNABORTED' ||
      code === 'EPIPE' ||
      code === 'ETIMEDOUT' ||
      message.includes('econnreset') ||
      message.includes('econnaborted') ||
      message.includes('socket hang up') ||
      message.includes('connection reset') ||
      message.includes('connection is closed')
    );
  }

  // =========================================================================
  // 🔹 CLOSE ALL
  // =========================================================================

  async closeAllOrders(options: {
    symbol: TradingSymbol;
    connectorType: ConnectorType;
    marketType: MarketType;
  }): Promise<void> {
    const { symbol, connectorType, marketType } = options;

    switch (connectorType) {
      case ConnectorType.binance:
        return await this.binanceService.closeAllOrders({
          symbol,
          marketType,
        });

      case ConnectorType.alpaca:
        return;

      case ConnectorType.tinkoff:
        return;

      // case ConnectorType.testnetBinanceFutures:
      //     return await this.testnetBinanceFuturesService.closeAllOrders({ symbol, marketType });
    }
  }
}
