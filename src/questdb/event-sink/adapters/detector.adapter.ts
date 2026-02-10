import { Injectable } from '@nestjs/common';
import { EventSinkRepository } from '../event-sink.repository';
import { DetectorEntity } from '../../repositories/detector.repository';

@Injectable()
export class DetectorEventAdapter {
    constructor(private readonly events: EventSinkRepository) { }

    emitSignal(detector: DetectorEntity, signal: any) {
        this.events.emit(
            'detector.signal',
            {
                category: 'detector',
                action: 'signal',
                data: { detector, signal },
                timestamp: Date.now(),
            }
        );
    }
}
