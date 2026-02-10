import { Injectable } from '@nestjs/common';
import { EventSinkRepository } from '../event-sink.repository';
import { ConnectorEntity } from '../../repositories/connector.repository';

@Injectable()
export class ConnectorEventAdapter {
    constructor(private readonly events: EventSinkRepository) { }

    emitUpdate(connector: ConnectorEntity) {
        this.events.emit(
            'connector.update',
            {
                category: 'connector',
                action: 'update',
                // entity: 'ConnectorEntity',
                // reference: connector.connectorType,
                connectorType: connector.connectorType,
                data: connector,
                timestamp: Date.now(),
            }
        );
    }
}
