import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import {
  Order,
  OrderSide,
  OrderType,
  MarketType,
  ConnectorType,
  OrderSourceType,
  TradingSymbol,
} from '@barfinex/types';

import {
  NewOrderSpot,
  NewOrderMarketBase,
  NewOrderLimit,
  NewOrderSL,
  NewFuturesOrder,
  FuturesOrder,
  MarketNewFuturesOrder,
  LimitNewFuturesOrder,
  TakeProfitNewFuturesOrder,
  StopNewFuturesOrder,
  TakeProfitMarketNewFuturesOrder,
  StopMarketNewFuturesOrder,
  OrderType as BinanceOrderType,
} from 'binance-api-node';

import { ConfigService } from '@barfinex/config';
import { BinanceClientService } from '../core/binance.client';

@Injectable()
export class BinanceOrderApi {
  private readonly connectorType = ConnectorType.binance;

  constructor(
    private readonly client: BinanceClientService,
    private readonly configService: ConfigService,
  ) {}

  async openOrder(order: Order): Promise<Order> {
    await this.client.ensureReady();

    const api = this.client.api;
    const result: Order = { ...order };

    if (!order.useSandbox) {
      switch (order.marketType) {
        case MarketType.spot: {
          let spotOrder: NewOrderSpot = {} as NewOrderSpot;

          switch (order.type) {
            case OrderType.MARKET:
              if (order.symbol && order.quantity)
                spotOrder = {
                  type: BinanceOrderType.MARKET,
                  symbol: order.symbol.name,
                  side: order.side,
                  quantity: order.quantity.toString(),
                } as NewOrderMarketBase;
              break;

            case OrderType.LIMIT:
              if (order.symbol && order.quantity && order.price)
                spotOrder = {
                  type: BinanceOrderType.LIMIT,
                  symbol: order.symbol.name,
                  side: order.side,
                  timeInForce: 'GTC',
                  quantity: order.quantity.toString(),
                  price: order.price.toString(),
                } as NewOrderLimit;
              break;

            case OrderType.TAKE_PROFIT:
              if (order.symbol && order.quantity && order.price)
                spotOrder = {
                  type: BinanceOrderType.TAKE_PROFIT_LIMIT,
                  symbol: order.symbol.name,
                  side: order.side,
                  quantity: order.quantity.toString(),
                  price: order.price.toString(),
                } as NewOrderSL;
              break;

            case OrderType.STOP:
              if (order.symbol && order.quantity && order.price)
                spotOrder = {
                  type: BinanceOrderType.STOP_LOSS_LIMIT,
                  symbol: order.symbol.name,
                  side: order.side,
                  quantity: order.quantity.toString(),
                  price: order.price.toString(),
                } as NewOrderSL;
              break;
          }

          const entity = await api.order(spotOrder);
          result.externalId = entity.orderId.toString();
          result.updateTime = entity.updateTime;
          break;
        }

        case MarketType.futures: {
          let futuresOrder: NewFuturesOrder = {} as NewFuturesOrder;

          switch (order.type) {
            case OrderType.MARKET:
              if (order.symbol && order.quantity)
                futuresOrder = {
                  type: order.type,
                  symbol: order.symbol.name,
                  side: order.side,
                  quantity: order.quantity.toString(),
                } as MarketNewFuturesOrder;
              break;

            case OrderType.LIMIT:
              if (order.symbol && order.quantity && order.price)
                futuresOrder = {
                  type: order.type,
                  symbol: order.symbol.name,
                  side: order.side,
                  timeInForce: 'GTC',
                  quantity: order.quantity.toString(),
                  price: order.price.toString(),
                } as LimitNewFuturesOrder;
              break;

            case OrderType.TAKE_PROFIT:
              if (order.symbol && order.quantity && order.price)
                futuresOrder = {
                  type: order.type,
                  symbol: order.symbol.name,
                  side: order.side,
                  quantity: order.quantity.toString(),
                  stopPrice: order.price.toString(),
                } as TakeProfitNewFuturesOrder;
              break;

            case OrderType.STOP:
              if (order.symbol && order.quantity && order.price)
                futuresOrder = {
                  type: order.type,
                  symbol: order.symbol.name,
                  side: order.side,
                  quantity: order.quantity.toString(),
                  stopPrice: order.price.toString(),
                } as StopNewFuturesOrder;
              break;

            case OrderType.TAKE_PROFIT_MARKET:
              if (order.symbol && order.quantity && order.price)
                futuresOrder = {
                  type: order.type,
                  symbol: order.symbol.name,
                  side: order.side,
                  quantity: order.quantity.toString(),
                  stopPrice: order.price.toString(),
                  workingType: 'MARK_PRICE',
                  priceProtect: 'TRUE',
                  priceMatch: 'NONE',
                  selfTradePreventionMode: 'NONE',
                  goodTillDate: 0,
                  positionSide: 'BOTH',
                  closePosition: 'true',
                } as TakeProfitMarketNewFuturesOrder;
              break;

            case OrderType.STOP_MARKET:
              if (order.symbol && order.quantity && order.price)
                futuresOrder = {
                  type: order.type,
                  symbol: order.symbol.name,
                  side: order.side,
                  quantity: order.quantity.toString(),
                  stopPrice: order.price.toString(),
                  workingType: 'MARK_PRICE',
                  priceProtect: 'TRUE',
                  priceMatch: 'NONE',
                  selfTradePreventionMode: 'NONE',
                  goodTillDate: 0,
                  positionSide: 'BOTH',
                  closePosition: 'true',
                } as StopMarketNewFuturesOrder;
              break;
          }

          const existing = await this.getOpenOrders({
            marketType: order.marketType,
          });

          let entity: FuturesOrder | undefined;
          if (
            !existing.find(
              (q) =>
                q.symbol?.name === futuresOrder.symbol &&
                q.type === futuresOrder.type &&
                q.side === futuresOrder.side,
            )
          ) {
            entity = await api.futuresOrder(futuresOrder);
          }

          if (entity) {
            result.externalId = entity.orderId.toString();
            result.updateTime = entity.updateTime;
          }
          break;
        }
      }
    }

    return result;
  }

  async closeOrder(options: {
    id: string;
    symbol: TradingSymbol;
    marketType: MarketType;
  }): Promise<Order> {
    await this.client.ensureReady();

    const api = this.client.api;
    const { id, symbol, marketType } = options;

    const orders = await api.futuresOpenOrders({ symbol: symbol.name });
    const element = orders.find((q) => q.orderId == id);

    if (!element) throw new NotFoundException(`Order with id ${id} not found`);

    const provider = this.configService.getConfig().provider;
    if (!provider)
      throw new InternalServerErrorException('Provider config is missing');

    const result: Order = {
      symbol: { name: element.symbol },
      externalId: element.orderId.toString(),
      side: element.side as OrderSide,
      type: element.type as OrderType,
      price: parseFloat(element.price),
      quantity: parseFloat(element.origQty),
      time: element.time,
      updateTime: element.updateTime,
      useSandbox: false,
      marketType,
      connectorType: this.connectorType,
      source: {
        type: OrderSourceType.provider,
        key: this.connectorType,
        restApiUrl: provider.restApiUrl,
      },
      closeTime: null,
    };

    await api.futuresCancelOrder({ orderId: +id, symbol: symbol.name });
    return result;
  }

  async closeAllOrders(options: {
    symbol: TradingSymbol;
    marketType: MarketType;
  }): Promise<void> {
    await this.client.ensureReady();

    const api = this.client.api;
    const { symbol, marketType } = options;

    if (marketType === MarketType.spot) {
      await api.cancelOpenOrders({ symbol: symbol.name });
    } else {
      await api.futuresCancelAllOpenOrders({ symbol: symbol.name });
    }
  }

  async getOpenOrders(options: {
    symbol?: TradingSymbol;
    marketType: MarketType;
  }): Promise<Order[]> {
    await this.client.ensureReady();

    const api = this.client.api;
    const result: Order[] = [];

    const provider = this.configService.getConfig().provider;
    if (!provider)
      throw new InternalServerErrorException('Provider config is missing');

    const { symbol, marketType } = options;

    if (marketType === MarketType.spot) {
      const orders = await api.openOrders(
        symbol ? { symbol: symbol.name } : {},
      );
      orders.forEach((o) => {
        result.push({
          symbol: { name: o.symbol },
          externalId: o.orderId.toString(),
          side: o.side as OrderSide,
          type: o.type as OrderType,
          price: parseFloat(o.price),
          quantity: parseFloat(o.origQty),
          time: o.time,
          updateTime: o.updateTime,
          useSandbox: false,
          marketType,
          connectorType: this.connectorType,
          source: {
            type: OrderSourceType.provider,
            key: this.connectorType,
            restApiUrl: provider.restApiUrl,
          },
          closeTime: null,
        });
      });
    } else {
      const orders = await api.futuresOpenOrders(
        symbol ? { symbol: symbol.name } : {},
      );
      orders.forEach((o) => {
        let price = parseFloat(o.price);
        if (
          o.type === OrderType.STOP_MARKET ||
          o.type === OrderType.TAKE_PROFIT_MARKET
        ) {
          price = parseFloat(o.stopPrice);
        }

        result.push({
          symbol: { name: o.symbol },
          externalId: o.orderId,
          side: o.side as OrderSide,
          type: o.type as OrderType,
          price,
          quantity: parseFloat(o.origQty),
          time: o.time,
          updateTime: o.updateTime,
          useSandbox: false,
          marketType,
          connectorType: this.connectorType,
          source: {
            type: OrderSourceType.provider,
            key: this.connectorType,
            restApiUrl: provider.restApiUrl,
          },
          closeTime: null,
        });
      });
    }

    return result;
  }
}
