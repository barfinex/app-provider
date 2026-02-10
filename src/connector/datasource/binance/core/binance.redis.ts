import {
    Injectable,
    InternalServerErrorException,
    Logger,
    OnModuleInit,
} from '@nestjs/common';
import {
    ClientProxy,
    ClientProxyFactory,
    Transport,
    RedisOptions,
} from '@nestjs/microservices';
import { SubscriptionType } from '@barfinex/types';

@Injectable()
export class BinanceRedisService implements OnModuleInit {
    private readonly logger = new Logger(BinanceRedisService.name);

    public client!: ClientProxy;

    public isEmitToRedisEnabled = true;

    async onModuleInit() {
        /* === 🧠 Подключение к Redis === */
        const tcpHost = process.env.REDIS_HOST || 'localhost';
        const tcpPort = Number(process.env.REDIS_PORT ?? '6379');

        if (isNaN(tcpPort) || tcpPort <= 0 || tcpPort > 65535) {
            this.logger.error(`Invalid Redis port: ${tcpPort}`);
            throw new InternalServerErrorException('Invalid Redis port');
        }

        this.logger.log(`Connecting to Redis on ${tcpHost}:${tcpPort}`);

        this.client = ClientProxyFactory.create({
            transport: Transport.REDIS,
            options: {
                host: tcpHost,
                port: tcpPort,
            },
        } as RedisOptions);

        try {
            await this.client.connect();
            this.logger.log('✅ Connected to Redis successfully!');
        } catch (error: any) {
            this.logger.error(
                '❌ Failed to connect to Redis:',
                error?.message || error,
            );
            throw error;
        }
    }

    emit<T = any>(pattern: SubscriptionType, data: T) {
        if (!this.isEmitToRedisEnabled) return;

        if (!this.client) {
            this.logger.error('❌ Redis client is not initialized');
            return;
        }

        // 🔕 DEBUG лог отключён (слишком шумный для market streams)
        // this.logger.debug(`[RedisEmit] ${pattern}`);

        this.client.emit(pattern, data);
    }

    delay = async (ms: number) =>
        await new Promise((resolve) => setTimeout(resolve, ms));
}
