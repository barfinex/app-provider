import { Injectable } from '@nestjs/common';
import { EventSinkRepository } from '../event-sink.repository';
import { OrderEntity } from '../../../order/order.repository';

@Injectable()
export class OrderEventAdapter {
  constructor(private readonly events: EventSinkRepository) {}

  /** Emit UPDATE event */
  emitUpdate(order: OrderEntity) {
    this.events.emit('order.update', {
      category: 'order',
      action: 'update',
      symbol: order.symbol,
      connectorType: order.connectorType,
      marketType: order.marketType,
      data: order,
      timestamp: Date.now(),
    });
  }

  /** Emit DELETE event */
  emitDelete(order: OrderEntity) {
    this.events.emit('order.delete', {
      category: 'order',
      action: 'delete',
      symbol: order.symbol,
      connectorType: order.connectorType,
      marketType: order.marketType,
      data: order,
      timestamp: Date.now(),
    });
  }
}
