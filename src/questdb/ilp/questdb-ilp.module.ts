import { Module } from '@nestjs/common';
import { QuestDbIlpWriterService } from './questdb-ilp-writer.service';

@Module({
    providers: [QuestDbIlpWriterService],
    exports: [QuestDbIlpWriterService],
})
export class QuestDbIlpModule { }
