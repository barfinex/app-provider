import { Module, forwardRef } from '@nestjs/common';
import { OrderBookSamplingService } from './orderbook-sampling.service';
import { EventSinkModule } from '../event-sink/event-sink.module';

@Module({
  imports: [
    forwardRef(() => EventSinkModule), // ← добавили
  ],
  providers: [OrderBookSamplingService],
  exports: [OrderBookSamplingService],
})
export class OrderBookSamplingModule {}
