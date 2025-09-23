// candle.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CandleController } from './candle.controller';
import { CandleEntity } from './candle.entity';
import { CandleMetadataEntity } from './candleMetadata.entity';
import { CandleService } from './candle.service';
import { DetectorModule } from '../detector/detector.module';
// (DetectorEntity репозиторий CandleService НЕ использует — можно убрать из forFeature)

@Module({
  imports: [
    TypeOrmModule.forFeature([CandleEntity, CandleMetadataEntity]),
    // если есть зависимость CandleService -> DetectorService, чтобы не упасть на цикле:
    forwardRef(() => DetectorModule),
  ],
  controllers: [CandleController],
  providers: [CandleService],
  exports: [CandleService], // <-- ВАЖНО: даёт наружу CandleService
})
export class CandleModule {}
