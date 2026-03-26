import { Module } from '@nestjs/common';
import { ConfigModule } from '@barfinex/config';
import { OWNERSHIP_STORE } from './ownership-store.interface';
import { RedisOwnershipStore } from './redis-ownership.store';
import { ProviderInstanceService } from './provider-instance.service';
import { ProviderOwnershipService } from './provider-ownership.service';
import { InstrumentShardService } from './instrument-shard.service';

@Module({
  imports: [ConfigModule],
  providers: [
    ProviderInstanceService,
    {
      provide: OWNERSHIP_STORE,
      useClass: RedisOwnershipStore,
    },
    ProviderOwnershipService,
    InstrumentShardService,
  ],
  exports: [
    ProviderInstanceService,
    ProviderOwnershipService,
    InstrumentShardService,
  ],
})
export class OwnershipModule {}
