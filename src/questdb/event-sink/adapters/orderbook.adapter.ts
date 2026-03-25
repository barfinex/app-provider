import { Injectable } from '@nestjs/common';
import { EventSinkRepository } from '../event-sink.repository';
import { OrderBookLevelEntity } from '../../repositories/orderbook.repository';

@Injectable()
export class OrderBookEventAdapter {
  constructor(private readonly events: EventSinkRepository) {}

  emitLevel(level: OrderBookLevelEntity) {
    this.events.emit('orderbook.level', {
      category: 'orderbook',
      action: 'level',
      symbol: level.symbol,
      data: level,
      timestamp: Date.now(),
    });
  }
}
