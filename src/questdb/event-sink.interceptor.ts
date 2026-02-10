import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { EventSinkRepository } from './event-sink/event-sink.repository';

@Injectable()
export class EventSinkInterceptor implements NestInterceptor {
    constructor(private readonly events: EventSinkRepository) { }

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const handler = context.getHandler().name;
        const className = context.getClass().name;

        const eventType = `${className}.${handler}`;

        return next.handle().pipe(
            tap((response) => {
                this.events.emit(eventType, response);
            }),
        );
    }
}
