import { Module } from '@nestjs/common';
import { SignalsController } from './signals.controller';
import { SignalsService } from './signals.service';
import { CandleModule } from '../candle/candle.module';
import { QuestDBModule } from '../questdb/questdb.module';

@Module({
    imports: [CandleModule, QuestDBModule],
    controllers: [SignalsController],
    providers: [SignalsService],
    exports: [SignalsService],
})
export class SignalsModule { }

