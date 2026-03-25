import { Module } from '@nestjs/common';
import { ConfigModule } from '@barfinex/config';
import { OWNERSHIP_STORE } from './ownership-store.interface';
import { RedisOwnershipStore } from './redis-ownership.store';
import { ProviderInstanceService } from './provider-instance.service';
import { ProviderOwnershipService } from './provider-ownership.service';
import { SymbolShardService } from './symbol-shard.service';

@Module({
  imports: [ConfigModule],
  providers: [
    ProviderInstanceService,
    {
      provide: OWNERSHIP_STORE,
      useClass: RedisOwnershipStore,
    },
    ProviderOwnershipService,
    SymbolShardService,
  ],
  exports: [
    ProviderInstanceService,
    ProviderOwnershipService,
    SymbolShardService,
  ],
})
export class OwnershipModule {}
