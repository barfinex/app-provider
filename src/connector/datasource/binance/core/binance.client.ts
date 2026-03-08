import {
    Injectable,
    InternalServerErrorException,
    Logger,
} from '@nestjs/common';
import Binance, { Binance as BinanceClient } from 'binance-api-node';
import moment from 'moment';
import { ConfigService } from '@barfinex/config';
import { MarketType } from '@barfinex/types';

@Injectable()
export class BinanceClientService {
    private readonly logger = new Logger(BinanceClientService.name);

    private ready = false;
    private initializing = false;

    private readyPromise: Promise<void>;
    private resolveReady!: () => void;

    public api!: BinanceClient;
    private validSpotSymbols: ReadonlySet<string> = new Set<string>();
    private validFuturesSymbols: ReadonlySet<string> = new Set<string>();

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

            await this.preloadExchangeInfoSymbols();

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

    getValidSymbols(marketType: MarketType): ReadonlySet<string> {
        if (marketType === MarketType.futures) {
            return this.validFuturesSymbols.size > 0
                ? this.validFuturesSymbols
                : this.validSpotSymbols;
        }

        return this.validSpotSymbols;
    }

    validateBinanceSymbols(
        marketType: MarketType,
        symbols: string[],
    ): { validSymbols: string[]; removedSymbols: string[] } {
        const validSet = this.getValidSymbols(marketType);
        const normalizedUnique: string[] = [];
        const seen = new Set<string>();

        for (const raw of symbols) {
            const normalized = String(raw ?? '').trim().toUpperCase();
            if (!normalized) continue;
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            normalizedUnique.push(normalized);
        }

        const validSymbols: string[] = [];
        const removedSymbols: string[] = [];
        for (const symbol of normalizedUnique) {
            if (validSet.has(symbol)) {
                validSymbols.push(symbol);
            } else {
                removedSymbols.push(symbol);
            }
        }

        return { validSymbols, removedSymbols };
    }

    private async preloadExchangeInfoSymbols(): Promise<void> {
        const spotSymbols = await this.loadExchangeSymbols('spot');
        const futuresSymbols = await this.loadExchangeSymbols('futures');

        this.validSpotSymbols = new Set(spotSymbols);
        this.validFuturesSymbols = new Set(futuresSymbols);

        this.logger.log(
            `[BinanceSymbols] spot=${this.validSpotSymbols.size} futures=${this.validFuturesSymbols.size}`,
        );
    }

    private async loadExchangeSymbols(kind: 'spot' | 'futures'): Promise<string[]> {
        try {
            const response =
                kind === 'spot'
                    ? await this.api.exchangeInfo()
                    : await this.api.futuresExchangeInfo();
            const symbols = (response?.symbols ?? [])
                .map((s: any) => String(s?.symbol ?? '').trim().toUpperCase())
                .filter((s: string) => s.length > 0);
            return Array.from(new Set(symbols));
        } catch (error) {
            this.logger.warn(
                `[BinanceSymbols] failed to load ${kind} exchangeInfo symbols: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return [];
        }
    }
}
