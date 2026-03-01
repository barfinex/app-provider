import {
    Injectable,
    InternalServerErrorException,
    Logger,
} from '@nestjs/common';
import Binance, { Binance as BinanceClient } from 'binance-api-node';
import moment from 'moment';
import { ConfigService } from '@barfinex/config';

@Injectable()
export class BinanceClientService {
    private readonly logger = new Logger(BinanceClientService.name);

    private ready = false;
    private initializing = false;

    private readyPromise: Promise<void>;
    private resolveReady!: () => void;

    public api!: BinanceClient;

    constructor(
        private readonly configService: ConfigService,
    ) {
        this.readyPromise = new Promise<void>((res) => {
            this.resolveReady = res;
        });
    }

    // ======================================================================
    // 🔹 LAZY INIT (ЕДИНСТВЕННАЯ ТОЧКА ИНИЦИАЛИЗАЦИИ)
    // ======================================================================
    private async init(): Promise<void> {
        if (this.ready) return;
        if (this.initializing) return this.readyPromise;

        this.initializing = true;
        this.logger.log('🧩 BinanceClient initializing...');

        try {
            const config = this.configService.getConfig();
            const providerConfig = config.provider;

            const connectorConfig = providerConfig?.connectors?.find(
                (c: { connectorType: string }) =>
                    c.connectorType === 'binance',
            );

            if (!connectorConfig) {
                throw new InternalServerErrorException(
                    'Binance connector not found in configuration',
                );
            }

            const connectorKey =
                connectorConfig.key ?? process.env.BINANCE_API_KEY;
            const connectorSecret =
                connectorConfig.secret ??
                process.env.BINANCE_API_SECRET;

            if (!connectorKey || !connectorSecret) {
                throw new InternalServerErrorException(
                    'Binance API credentials missing',
                );
            }

            // Use futures server time so signed requests to fapi.binance.com stay within recvWindow.
            // Spot (api.binance.com) and futures (fapi.binance.com) can differ slightly; using
            // fapi time avoids -1021 "Timestamp outside recvWindow" on futures account/orders.
            const fetchBinanceTime = async (): Promise<number> => {
                const res = await fetch(
                    'https://fapi.binance.com/fapi/v1/time',
                );
                const json = (await res.json()) as {
                    serverTime?: number;
                };

                if (typeof json.serverTime !== 'number') {
                    throw new InternalServerErrorException(
                        'Invalid Binance time response',
                    );
                }

                return json.serverTime;
            };

            this.api = Binance({
                apiKey: connectorKey,
                apiSecret: connectorSecret,
                getTime: fetchBinanceTime,
                // Allow 60s window for clock drift / latency (Binance max is 60000)
                recvWindow: 60_000,
            } as Parameters<typeof Binance>[0]);

            try {
                const time = await this.api.time();
                this.logger.log(
                    `🕒 Binance time: ${moment
                        .utc(time)
                        .format('YYYY-MM-DD HH:mm:ss')}`,
                );
            } catch {
                this.logger.warn('⚠️ Unable to fetch Binance time');
            }

            this.ready = true;
            this.resolveReady();
            this.logger.log('✅ BinanceClient ready');
        } catch (err) {
            this.logger.error(
                '❌ BinanceClient initialization failed',
                err instanceof Error ? err.stack : undefined,
            );
            throw err;
        } finally {
            this.initializing = false;
        }
    }

    // ======================================================================
    // 🔹 READY BARRIER (ЕДИНСТВЕННЫЙ ПУБЛИЧНЫЙ МЕТОД)
    // ======================================================================
    async ensureReady(timeoutMs = 10_000): Promise<void> {
        if (!this.ready) {
            await this.init();
        }

        await Promise.race([
            this.readyPromise,
            new Promise((_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                'BinanceClientService ensureReady timeout',
                            ),
                        ),
                    timeoutMs,
                ),
            ),
        ]);
    }
}
