import { Module } from '@nestjs/common';
import { SignalsController } from './signals.controller';
import { SignalsService } from './signals.service';
import { CandleModule } from '../candle/candle.module';
import { QuestDBModule } from '../questdb/questdb.module';
import { BinanceModule } from '../connector/datasource/binance/binance.module';

@Module({
    imports: [CandleModule, QuestDBModule, BinanceModule],
    controllers: [SignalsController],
    providers: [SignalsService],
    exports: [SignalsService],
})
export class SignalsModule { }

