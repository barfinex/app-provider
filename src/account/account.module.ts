// src/account/account.module.ts
import { Module, forwardRef } from '@nestjs/common';

import { AccountService } from './account.service';
import { AccountController } from './account.controller';

import { ConnectorModule } from '../connector/connector.module';
import { OrderModule } from '../order/order.module'; // чтобы AccountService мог закрывать/открывать ордера
import { DetectorModule } from '../detector/detector.module'; // если нужны детекторы
import { AccountLifecycle } from './account.lifecycle';
import { ExchangeDataModule } from '../connector/datasource/exchange/exchange-data.module';

@Module({
  imports: [
    forwardRef(() => ConnectorModule),
    forwardRef(() => OrderModule),
    forwardRef(() => DetectorModule),
    ExchangeDataModule,
  ],
  controllers: [AccountController],
  providers: [AccountService, AccountLifecycle],
  exports: [AccountService],
})
export class AccountModule {}
