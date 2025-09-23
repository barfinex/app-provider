import { WebSocketGateway, SubscribeMessage } from '@nestjs/websockets';
import { Socket } from 'socket.io';

@WebSocketGateway({ cors: { origin: '*' } })
export class WsHealthGateway {
    @SubscribeMessage('health')
    handleHealth(client: Socket) {
        client.emit('health:ok', { ok: true, t: Date.now(), source: 'local' });
    }
}
