import { Inject, Injectable, forwardRef } from '@nestjs/common';
import {
    OrderType,
    OrderSide,
    Order,
    MarketType,
    ConnectorType,
    OrderSourceType,
    OrderSource,
    Symbol
} from '@barfinex/types';

import { OrderEntity, OrderRepository } from './order.repository';
import { ConnectorService } from '../connector/connector.service';

import moment from 'moment';
import 'moment-timezone';

@Injectable()
export class OrderService {

    constructor(
        @Inject(forwardRef(() => ConnectorService))
        private readonly connectorService: ConnectorService,

        private readonly orderRepository: OrderRepository,
    ) { }

    // ============================================================================
    // GET OPEN ORDERS
    // ============================================================================

    async getOpenOrders(options: {
        connectorType: ConnectorType,
        marketType: MarketType,
        symbol?: Symbol,
        symbols: Symbol[],
        useSandbox?: boolean,
        source: OrderSource,
        query?: { limit?: number, page?: number, search?: string }
    }) {
        const { connectorType, marketType, symbol, symbols, source, useSandbox, query } = options;

        const sourceSysname = source.key;
        const sourceType = source.type as OrderSourceType;

        let { limit = 1000, page = 1 } = query || {};
        limit = +limit;
        page = +page;

        const offset = (page - 1) * limit;

        let data: Array<{ id: string, order: Order }> = [];
        let total = 0;

        // SANDBOX
        if (useSandbox) {
            const where = symbol
                ? `sourceSysname='${sourceSysname}' AND sourceType='${sourceType}' AND symbol='${symbol.name}'`
                : `sourceSysname='${sourceSysname}' AND sourceType='${sourceType}'`;

            const [rows, count] = await this.orderRepository.findAndCount(where, limit, offset);
            total = count;

            rows
                .map(entity => this.orderEntityToOrder(entity))
                .forEach(order => data.push({ id: order.id!, order }));

            return { data, total, page, limit };
        }

        // LIVE MODE — QuestDB + биржа
        const whereBase =
            `sourceSysname='${sourceSysname}' AND sourceType='${sourceType}' AND ` +
            `connectorType='${connectorType}' AND marketType='${marketType}'`;

        const entityOrders = await this.orderRepository.find(whereBase);

        let connectorOrders: Order[] = [];

        if (symbol) {
            connectorOrders = await this.connectorService.getOpenOrders({
                source,
                symbol,
                connectorType,
                marketType
            });
        } else {
            for (const s of symbols) {
                const list = await this.connectorService.getOpenOrders({
                    source,
                    symbol: s,
                    connectorType,
                    marketType
                });
                connectorOrders.push(...list);
            }
        }

        for (const o of connectorOrders) {
            if (!o.externalId) continue;

            const existing = entityOrders.find(
                e =>
                    e.externalId === o.externalId &&
                    e.connectorType === connectorType &&
                    e.marketType === marketType,
            );

            if (existing) {
                o.id = existing.id;
                await this.orderRepository.update(existing.id, this.orderToOrderEntity(o));
            } else {
                const entity = this.orderToOrderEntity(o);
                await this.orderRepository.insert(entity);
                o.id = entity.id;
            }

            data.push({ id: o.id!, order: o });
        }

        return data;
    }

    // ============================================================================
    // COUNT OPEN ORDERS
    // ============================================================================

    async getOpenOrdersCount(options: {
        symbols: Symbol[],
        sourceSysname: string,
        sourceType: OrderSourceType
    }) {
        const { symbols, sourceSysname, sourceType } = options;

        const result: Array<{ symbol: Symbol, ordersCount: number }> = [];

        for (const s of symbols) {
            const where = `sourceSysname='${sourceSysname}' AND sourceType='${sourceType}' AND symbol='${s.name}'`;
            const count = await this.orderRepository.count(where);
            result.push({ symbol: s, ordersCount: count });
        }

        return result;
    }

    // ============================================================================
    // OPEN ORDER
    // ============================================================================

    async openOrder(order: Order): Promise<Order> {
        order = await this.connectorService.openOrder(order);

        const entity = this.orderToOrderEntity(order);
        await this.orderRepository.insert(entity);

        order.id = entity.id;
        return order;
    }

    // ============================================================================
    // CLOSE ORDER
    // ============================================================================

    async closeOrder(order: Order): Promise<Order> {
        let entity = order.id
            ? await this.orderRepository.getById(order.id)
            : null;

        if (entity) {
            order.externalId = entity.externalId;
            entity.closeTime = moment.utc().unix();
        }

        if (order.externalId) {
            await this.connectorService.closeOrder(order);
        }

        if (entity) {
            await this.orderRepository.update(entity.id, entity);
            return this.orderEntityToOrder(entity);
        }

        return order;
    }

    // ============================================================================
    // UPDATE ORDER
    // ============================================================================

    async updateOrder(options: { id: string, order: Order }): Promise<Order> {
        const { id, order } = options;

        const existing = await this.orderRepository.getById(id);
        if (!existing) return order;

        if (!existing.useSandbox) {
            await this.connectorService.closeOrder(this.orderEntityToOrder(existing));

            const newOrder = await this.openOrder(order);
            order.externalId = newOrder.id!;
        }

        await this.orderRepository.update(id, this.orderToOrderEntity(order));
        return order;
    }

    // ============================================================================
    // DELETE ALL
    // ============================================================================

    async deleteAll(options: { connectorType: ConnectorType, marketType: MarketType }) {
        const { connectorType, marketType } = options;

        const where =
            `connectorType='${connectorType}' AND marketType='${marketType}'`;

        await this.orderRepository.deleteWhere(where);

        return true;
    }

    // ============================================================================
    // GET BY ID
    // ============================================================================

    async get(id: string): Promise<Order> {
        const entity = await this.orderRepository.getById(id);
        if (!entity) throw new Error('Order not found');

        return this.orderEntityToOrder(entity);
    }

    // ============================================================================
    // MAPPERS
    // ============================================================================

    private orderToOrderEntity(order: Order): OrderEntity {
        return {
            id: order.id ?? (Date.now().toString() + Math.random().toString(16).slice(2)),
            externalId: order.externalId ?? null,
            connectorType: order.connectorType,
            marketType: order.marketType,
            symbol: order.symbol?.name ?? '',

            side: order.side ?? null,
            type: order.type ?? null,
            price: order.price ?? null,

            sourceSysname: order.source.key,
            sourceType: order.source.type,
            sourceBaseApiUrl: order.source.restApiUrl ?? '',

            time: order.time ?? moment.utc().unix(),
            updateTime: order.updateTime ?? null,

            quantity: order.quantity ?? null,
            quantityExecuted: order.quantityExecuted ?? null,

            priceClose: order.priceClose ?? null,
            closeTime: order.closeTime ?? null,

            useSandbox: order.useSandbox ?? true,

            status: 'active',
            deletedAt: null,
        };
    }

    private orderEntityToOrder(entity: any): Order {
        return {
            id: entity.id,
            externalId: entity.externalId,
            symbol: { name: entity.symbol },
            connectorType: entity.connectorType as ConnectorType,
            marketType: entity.marketType as MarketType,
            side: entity.side as OrderSide,
            type: entity.type as OrderType,
            price: entity.price,
            source: {
                key: entity.sourceSysname,
                type: entity.sourceType as OrderSourceType,
                restApiUrl: entity.sourceBaseApiUrl,
            },
            time: entity.time,
            updateTime: entity.updateTime,
            quantity: entity.quantity,
            quantityExecuted: entity.quantityExecuted,
            priceClose: entity.priceClose,
            useSandbox: entity.useSandbox,
            closeTime: entity.closeTime,
        };
    }
}
