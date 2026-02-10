import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientProxy, ClientProxyFactory, Transport } from '@nestjs/microservices';
import { SubscriptionType, SubscriptionValue } from '@barfinex/types';

@Injectable()
export class BinanceRedisService implements OnModuleInit {
    private readonly logger = new Logger(BinanceRedisService.name);
    private client!: ClientProxy;

    async onModuleInit() {
        this.client = ClientProxyFactory.create({
            transport: Transport.REDIS,
            options: {
                host: process.env.REDIS_HOST ?? 'localhost',
                port: Number(process.env.REDIS_PORT ?? 6379),
            },
        });

        await this.client.connect();
        this.logger.log('✅ BinanceRedisService connected');
    }

    emit(type: SubscriptionType, value: SubscriptionValue) {
        this.client.emit(type, value);
    }
}
