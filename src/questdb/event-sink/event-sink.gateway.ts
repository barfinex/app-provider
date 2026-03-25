import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Inject, Injectable } from '@nestjs/common';
import { EventSinkRepository } from './event-sink.repository';

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/eventsink',
})
@Injectable()
export class EventSinkGateway implements OnGatewayInit {
  @WebSocketServer()
  server!: Server;

  constructor(
    @Inject(EventSinkRepository)
    private readonly eventSink: EventSinkRepository,
  ) {}

  afterInit() {
    console.log('🚀 EventSink WebSocket Ready: /ws/eventsink');
  }

  /**
   * Вызывается EventSinkRepository.emit() → шлюм в WebSocket
   */
  broadcast(event: any) {
    this.server.emit('event', event);
  }
}
