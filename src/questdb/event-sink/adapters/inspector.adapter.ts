import { Injectable } from '@nestjs/common';
import { EventSinkRepository } from '../event-sink.repository';
import { InspectorEntity } from '../../repositories/inspector.repository';

@Injectable()
export class InspectorEventAdapter {
    constructor(private readonly events: EventSinkRepository) { }

    emitCheck(inspector: InspectorEntity, result: any) {
        this.events.emit(
            'inspector.check',
            {
                category: 'inspector',
                action: 'check',
                data: { inspector, result },
                timestamp: Date.now(),
            }
        );
    }
}
