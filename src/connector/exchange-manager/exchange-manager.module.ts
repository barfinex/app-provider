import { Module } from '@nestjs/common';
import { ConfigModule } from '@barfinex/config';
import { ExchangeManagerService } from './exchange-manager.service';
import { ExchangeManagerController } from './exchange-manager.controller';

@Module({
  imports: [ConfigModule],
  controllers: [ExchangeManagerController],
  providers: [ExchangeManagerService],
  exports: [ExchangeManagerService],
})
export class ExchangeManagerModule {}
