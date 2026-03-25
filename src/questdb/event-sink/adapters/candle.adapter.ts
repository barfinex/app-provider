import { Injectable } from '@nestjs/common';
import { EventSinkRepository } from '../event-sink.repository';
import { CandleEntity } from '../../repositories/candle.repository';

@Injectable()
export class CandleEventAdapter {
  constructor(private readonly events: EventSinkRepository) {}

  emitSave(candle: CandleEntity) {
    this.events.emit('candle.save', {
      category: 'candle',
      action: 'save',
      symbol: candle.symbol,
      connectorType: candle.connectorType,
      marketType: candle.marketType,
      data: candle,
      timestamp: Date.now(),
    });
  }
}
