import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { EventSinkRepository } from './event-sink.repository';
import { EventSinkPayload } from './event-sink.type';

@Injectable()
export class EventSinkInterceptor implements NestInterceptor {
    constructor(private readonly events: EventSinkRepository) { }

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const handler = context.getHandler().name;
        const className = context.getClass().name;

        return next.handle().pipe(
            tap((result) => {

                const event: EventSinkPayload = {
                    category: 'analytics',
                    action: `${className}.${handler}`,
                    data: { result },
                    timestamp: Date.now(),
                };

                this.events.emit(
                    `${event.category}.${event.action}`,
                    event,
                );
            }),
        );
    }
}
