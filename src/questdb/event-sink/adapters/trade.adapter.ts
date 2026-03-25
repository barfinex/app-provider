import { Injectable } from '@nestjs/common';
import { EventSinkRepository } from '../event-sink.repository';
import { TradeEntity } from '../../repositories/trade.repository';

@Injectable()
export class TradeEventAdapter {
  constructor(private readonly events: EventSinkRepository) {}

  emitTrade(trade: TradeEntity) {
    this.events.emit('trade.tick', {
      category: 'trade',
      action: 'tick',
      symbol: trade.symbol,
      data: trade,
      timestamp: Date.now(),
    });
  }
}
