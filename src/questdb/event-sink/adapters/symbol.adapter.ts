import { Injectable } from '@nestjs/common';
import { EventSinkRepository } from '../event-sink.repository';
import { SymbolEntity } from '../../repositories/symbol.repository';

@Injectable()
export class SymbolEventAdapter {
  constructor(private readonly events: EventSinkRepository) {}

  emitUpdate(symbol: SymbolEntity) {
    this.events.emit('symbol.update', {
      category: 'symbol',
      action: 'update',
      symbol: symbol.symbol,
      connectorType: symbol.connectorType,
      marketType: symbol.marketType,
      data: symbol,
      timestamp: Date.now(),
    });
  }
}
