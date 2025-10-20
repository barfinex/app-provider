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
import { OrderEntity } from './order.entity';
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { paginate } from '../common/pagination/paginate';
import { ConnectorService } from '../connector/connector.service';
import { ObjectId } from "typeorm";
import moment from 'moment';
import 'moment-timezone';

@Injectable()
export class OrderService {

    constructor(
        @Inject(forwardRef(() => ConnectorService))
        private readonly connectorService: ConnectorService,
        @InjectRepository(OrderEntity) private readonly orderRepository: Repository<OrderEntity>
    ) {

    }

    async getOpenOrders(options: { connectorType: ConnectorType, marketType: MarketType, symbol?: Symbol, symbols: Symbol[], useSandbox?: boolean, source: OrderSource, query?: { limit?: number, page?: number, search?: string } }): Promise<Array<{ id: number, order: Order }> | any> {


        let total: number = 0;

        const { connectorType, marketType, symbol, useSandbox, source, symbols, query } = options

        const sourceSysname = source.key
        const sourceType = source.type as OrderSourceType

        let data: Array<{ id: string, order: Order }> = [];

        let { search = '', limit = 1000, page = 1 } = query || {}

        limit = +limit;
        page = +page;

        const startIndex = (page - 1) * limit;

        if (useSandbox) {

            let orderEntitis: [OrderEntity[], number]

            if (symbol) {

                if (query!.limit) orderEntitis = await this.orderRepository.findAndCount({
                    where: { sourceSysname, sourceType, symbol: symbol.name }, order: { time: 'DESC' }, skip: startIndex, take: limit
                })
                else orderEntitis = await this.orderRepository.findAndCount({ where: { sourceSysname, sourceType, symbol: symbol.name }, order: { time: 'DESC' } })

                total = orderEntitis[1];
            } else {

                if (query!.limit) orderEntitis = await this.orderRepository.findAndCount({ where: { sourceSysname, sourceType, }, order: { time: 'DESC' }, skip: startIndex, take: limit })
                else orderEntitis = await this.orderRepository.findAndCount({ where: { sourceSysname, sourceType, }, order: { time: 'DESC' } })

                total = orderEntitis[1];
            }

            orderEntitis[0].map(orderEntity => this.orderEntityToOrder(orderEntity))
                .forEach(order => {
                    if (order.id) data.push({ id: order.id, order })
                });

        } else {

            let entityOrders: OrderEntity[] = []
            let connectorOrders: Order[] = []

            if (symbol) {
                entityOrders = await this.orderRepository.find({ where: { sourceSysname, sourceType, symbol: symbol.name, connectorType, marketType }, order: { time: 'DESC' } });
                connectorOrders = await this.connectorService.getOpenOrders({ source, symbol, connectorType, marketType })
            }
            else {
                entityOrders = await this.orderRepository.find({ where: { sourceSysname, sourceType, connectorType, marketType }, order: { time: 'DESC' } });

                for (let i = 0; i < symbols.length; i++) {
                    const symbol = symbols[i];

                    const orders = await this.connectorService.getOpenOrders({ source, symbol: symbol, connectorType, marketType });
                    orders.forEach(order => {
                        connectorOrders.push(order)
                    });
                }
            }

            for (let i = 0; i < connectorOrders.length; i++) {
                const order = connectorOrders[i];

                if (order.externalId) {
                    const orderEntity = entityOrders.find(q => q.externalId == order.externalId && q.connectorType == connectorType && q.marketType == marketType)
                    console.log('getOpenOrder');

                    if (orderEntity) {
                        // update Entity
                        order.id = orderEntity.id.toString()
                        await this.orderRepository.update(order.id, this.orderToOrderEntity(order))
                    }
                    else {
                        // create Entity
                        order.id = (this.orderRepository.create(this.orderToOrderEntity(order))).id.toString()
                    }

                    data.push({ id: order.id, order });
                }
            }

            // delete Entity
            let entityIdsForDelete = entityOrders.filter(q => connectorOrders.find(qq => qq.externalId == q.externalId) != null).map(q => q.id)
            if (entityIdsForDelete.length > 0) await this.orderRepository.delete(entityIdsForDelete)
        }

        // const results = data;
        //const results = data.slice(startIndex, endIndex);
        // const results = data.slice(startIndex, endIndex);
        const url = `/api/orders/detector/${options.source.key}?page=${page}&limit=${limit}`;

        if (options.query && options.query.limit)
            return {
                data,
                ...paginate(total, page, limit, data.length, url),
            };
        else return data;
    }



    async getOpenOrdersCount(options: { symbols: Symbol[], sourceSysname: string, sourceType: OrderSourceType }): Promise<Array<{ symbol: Symbol, ordersCount: number }> | any> {

        const { sourceSysname, sourceType, symbols } = options
        let data: Array<{ symbol: Symbol, ordersCount: number }> = [];


        for (let i = 0; i < symbols.length; i++) {
            const symbol = symbols[i];

            const ordersCount = await this.orderRepository.countBy({ sourceSysname, sourceType, symbol: symbol.name })
            data.push({ symbol, ordersCount })
        }

        return data;
    }

    async openOrder(order: Order): Promise<Order> {

        // let { order } = options

        // console.log('connectorType', connectorType);

        // console.log('order:', order);
        // console.log("order.time UTC:", moment.utc(order.time).format('YYYY-MM-DD HH:mm:ss'));

        // order.connectorType = connectorType
        // order.marketType = marketType

        order = await this.connectorService.openOrder(order)

        // console.log('openOrder');

        const orderEntity = await this.orderRepository.save(this.orderToOrderEntity(order))

        order.id = orderEntity.id.toString()


        // this.connectorService.openOrder



        return order;
    }

    //    async closeOrder(options: { id?: number, externalId?: string, symbol: Symbol, connectorType?: ConnectorType, marketType?: MarketType, source: OrderSource }): Promise<Order> {
    async closeOrder(order: Order): Promise<Order> {

        let result: Order = {} as Order

        let orderEntity: OrderEntity | null = null;

        if (order.id) {
            orderEntity = await this.orderRepository.findOne({ where: { id: new ObjectId(order.id) } })
            if (orderEntity) {
                order.externalId = orderEntity.externalId
                orderEntity.closeTime = moment(moment.utc(new Date()).format('YYYY-MM-DD HH:mm:ss')).unix()
            }
        }

        if (order.externalId) await this.connectorService.closeOrder(order)

        if (orderEntity && order.id) {
            await this.orderRepository.update(order.id, orderEntity)
            result = this.orderEntityToOrder(orderEntity)
        }

        return result;
    }

    async updateOrder(options: { id: string, order: Order }): Promise<Order> {

        const { id, order } = options
        order.id = id

        const orderEntity: OrderEntity | null = await this.orderRepository.findOne({ where: { id: new ObjectId(id) } })

        if (orderEntity && !orderEntity.useSandbox) {
            await this.connectorService.closeOrder(this.orderEntityToOrder(orderEntity))

            const newOrder = await this.openOrder(order)
            if (newOrder.id) {
                order.externalId = newOrder.id.toString()
            }
        }

        console.log('updateOrder');
        await this.orderRepository.update(id, this.orderToOrderEntity(order))
        return order;
    }

    async deleteAll(options: { connectorType: ConnectorType, marketType: MarketType, symbols?: Symbol[] }): Promise<boolean> {

        const { connectorType, marketType, symbols } = options

        let result = false
        let ordersEntity: OrderEntity[]

        if (connectorType && marketType) {

            // ordersEntity = await this.orderRepository.find({ where: { detectorSysname } })
            // console.log("ordersEntity.length:", ordersEntity.length);


            this.orderRepository.delete({ connectorType, marketType })

            // // ordersEntity = await this.orderRepository.find({ where: { detectorSysname } })
            // // console.log("ordersEntity.length:", ordersEntity.length);
            // // const ids = ordersEntity.map(q => q.id)
            // // if (ids.length > 0) {
            // //     console.log("ids.length:", ids.length);
            // //     await this.orderRepository.delete({ id: In(ids) })
            // //     console.log("ids.length:", ids.length);
            // // }


            // for (let i = 0; i < symbols.length; i++) {
            //     const symbol = symbols[i];
            //     await this.connectorService.closeAllOrders({ symbol, connectorType, marketType })
            // }




            result = true
        }

        return result
    }

    async get(id: string): Promise<Order> {

        const orderEntity = await this.orderRepository.findOne({ where: { id: new ObjectId(id) } })
        if (orderEntity)
            return this.orderEntityToOrder(orderEntity)
        else throw new Error('Order not found')
    }

    private orderToOrderEntity(order: Order): OrderEntity {

        console.log("order:", order);
        
        let result: OrderEntity = {
            id: (order.id) ? new ObjectId(order.id) : new ObjectId(),
            externalId: (order.externalId) ? order.externalId : null,
            connectorType: order.connectorType.toString(),
            marketType: order.marketType.toString(),
            symbol: (order.symbol) ? order.symbol.name : '',
            side: order.side?.toString() ?? null,
            type: order.type?.toString() ?? null,
            price: order.price ?? null,
            sourceSysname: order.source.key,
            sourceType: order.source.type,
            sourceBaseApiUrl: (order.source.restApiUrl) ? order.source.restApiUrl : '',
            time: (order.time) ? +order.time : moment.utc(new Date()).unix(),
            updateTime: (order.updateTime) ? order.updateTime : null,
            quantity: (order.quantity) ? order.quantity : null,
            quantityExecuted: (order.quantityExecuted) ? order.quantityExecuted : null,
            // priceStop: (order.priceStop) ? order.priceStop : null,
            // isClose: (order.isClose) ? order.isClose : false,
            useSandbox: (order.useSandbox) ? order.useSandbox : true,
            priceClose: (order.priceClose) ? order.priceClose : null
        }

        return result
    }

    private orderEntityToOrder(orderEntity: OrderEntity): Order {

        let result: Order = {
            symbol: { name: orderEntity.symbol },
            id: orderEntity.id.toString(),
            externalId: orderEntity.externalId,
            side: orderEntity.side as OrderSide,
            type: orderEntity.type as OrderType,
            price: orderEntity.price,
            source: {
                key: orderEntity.sourceSysname,
                type: orderEntity.sourceType as OrderSourceType,
                restApiUrl: orderEntity.sourceBaseApiUrl
            },
            time: orderEntity.time,
            updateTime: orderEntity.updateTime,
            quantity: orderEntity.quantity,
            quantityExecuted: orderEntity.quantityExecuted,
            priceClose: orderEntity.priceClose,
            useSandbox: orderEntity.useSandbox,
            connectorType: orderEntity.connectorType as ConnectorType,
            marketType: orderEntity.marketType as MarketType
        }

        return result
    }


}
