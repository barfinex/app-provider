import { Injectable } from '@nestjs/common';
import { EventSinkRepository } from '../event-sink.repository';
import { InstrumentEntity } from '../../repositories/instrument.repository';

@Injectable()
export class InstrumentEventAdapter {
  constructor(private readonly events: EventSinkRepository) {}

  emitUpdate(instrument: InstrumentEntity) {
    this.events.emit('symbol.update', {
      category: 'symbol',
      action: 'update',
      symbol: instrument.symbol,
      connectorType: instrument.connectorType,
      marketType: instrument.marketType,
      data: instrument,
      timestamp: Date.now(),
    });
  }
}
