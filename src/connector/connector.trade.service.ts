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
  Instrument,
  SubscriptionType,
  OrderSource,
  EventMessageByType,
  ExchangeConnectorStatus,
} from '@barfinex/types';
import { ClientProxy } from '@nestjs/microservices';
import { randomUUID } from 'crypto';

import { ConnectorRegistry } from './connector.registry';
import { ExchangeDataService } from './datasource/exchange/exchange-data.service';
import { ExchangeManagerService } from './exchange-manager/exchange-manager.service';

@Injectable()
export class ConnectorTradeService {
  private readonly logger = new Logger(ConnectorTradeService.name);
  private readonly isEmitToRedisEnabled = true;
  private readonly eventSource = process.env.SERVICE_NAME || 'provider';
  private readonly transientEmitWarnThrottleMs = 10_000;
  private lastTransientEmitWarnAt = 0;

  constructor(
    private readonly exchangeDataService: ExchangeDataService,
    private readonly exchangeManager: ExchangeManagerService,

    @Inject('PROVIDER_SERVICE')
    private readonly client: ClientProxy,
  ) {}

  // =========================================================================
  // 🔹 LEVERAGE
  // =========================================================================

  async changeLeverage(
    connectorType: ConnectorType,
    instrument: Instrument,
    newLeverage: number,
  ): Promise<Instrument> {
    this.assertActive(connectorType, instrument.marketType as MarketType);
    return await this.exchangeDataService.changeLeverage(instrument, newLeverage);
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

    this.assertActive(order.connectorType, order.marketType);
    const result = await this.exchangeDataService.openOrder(order);

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
    instrument: Instrument;
    source: OrderSource;
    connectorType: ConnectorType;
    marketType: MarketType;
  }): Promise<Order[]> {
    const { instrument, connectorType, marketType } = options;

    const status = this.exchangeManager.getStatus(connectorType, marketType);
    if (status === ExchangeConnectorStatus.INACTIVE) return [];

    return await this.exchangeDataService.getOpenOrders({
      instrument,
      marketType,
    });
  }

  async getAllOpenOrders(options: {
    connectorType: ConnectorType;
    marketType: MarketType;
  }): Promise<Order[]> {
    const status = this.exchangeManager.getStatus(
      options.connectorType,
      options.marketType,
    );
    if (status === ExchangeConnectorStatus.INACTIVE) return [];

    return await this.exchangeDataService.getOpenOrders({
      marketType: options.marketType,
    });
  }

  // =========================================================================
  // 🔹 CLOSE ORDER
  // =========================================================================

  async closeOrder(order: Order): Promise<Order> {
    const { externalId, instrument, connectorType, marketType, source } = order;

    if (!externalId) {
      throw new BadRequestException(
        'Order.externalId is required to close order',
      );
    }

    if (!instrument) {
      throw new BadRequestException('Order.symbol is required to close order');
    }

    this.assertActive(connectorType, marketType);

    const result = await this.exchangeDataService.closeOrder({
      id: externalId,
      symbol: instrument,
      marketType,
    });

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
    instrument: Instrument;
    connectorType: ConnectorType;
    marketType: MarketType;
  }): Promise<void> {
    const { instrument, connectorType, marketType } = options;
    this.assertActive(connectorType, marketType);
    return await this.exchangeDataService.closeAllOrders({
      instrument,
      marketType,
    });
  }

  // =========================================================================
  // 🔹 PRIVATE
  // =========================================================================

  private assertActive(
    connectorType: ConnectorType,
    marketType: MarketType,
  ): void {
    const status = this.exchangeManager.getStatus(connectorType, marketType);
    if (
      status !== ExchangeConnectorStatus.ACTIVE &&
      status !== ExchangeConnectorStatus.CONNECTING
    ) {
      throw new BadRequestException(
        `Connector ${connectorType}:${marketType} is not active (status: ${status})`,
      );
    }
  }
}
