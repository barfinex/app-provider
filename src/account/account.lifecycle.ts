import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountService } from './account.service';

@Injectable()
export class AccountLifecycle implements OnModuleInit {
  constructor(private readonly accountService: AccountService) {}

  async onModuleInit() {
    await this.accountService.getAll();
  }
}
