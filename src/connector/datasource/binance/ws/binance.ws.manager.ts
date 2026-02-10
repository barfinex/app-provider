import { Injectable } from '@nestjs/common';
import {
    MarketType,
    Symbol,
    TimeFrame,
    SubscriptionType,
    SubscriptionValue,
    ConnectorType,
} from '@barfinex/types';
import { WebSocketService } from '../../websocket.service';
import { convertTimeFrame } from '../utils/timeframe.converter';
import { BinanceClientService } from '../core/binance.client';
import { BinanceRedisService } from '../core/binance.redis';

type UnsubscribeFn = () => void;

@Injectable()
export class BinanceWsManager {
    // ======================================================
    // 🔹 READY BARRIER
    // ======================================================
    private ready = false;
    private initializing = false;

    private readyPromise: Promise<void>;
    private resolveReady!: () => void;

    constructor(
        private readonly clientService: BinanceClientService,
        private readonly webSocketService: WebSocketService,
        private readonly redis: BinanceRedisService, // 🔥 ДОБАВЛЕНО
    ) {
        this.readyPromise = new Promise<void>((res) => {
            this.resolveReady = res;
        });
    }

    // ======================================================
    // 🔹 INIT / READY
    // ======================================================
    private async init(): Promise<void> {
        if (this.ready) return;
        if (this.initializing) return this.readyPromise;

        this.initializing = true;

        // 🔥 ГАРАНТИРУЕМ: REST готов
        await this.clientService.ensureReady();

        if (!this.clientService.api) {
            this.initializing = false;
            throw new Error(
                '[BinanceWsManager] Binance REST api is not available after ensureReady',
            );
        }

        this.ready = true;
        this.resolveReady();
        this.initializing = false;
    }

    async ensureReady(): Promise<void> {
        if (!this.ready) {
            await this.init();
        }

        await this.readyPromise;
    }

    // ======================================================
    // 🔹 INTERNAL
    // ======================================================
    private get api(): any {
        if (!this.clientService.api) {
            throw new Error(
                '[BinanceWsManager] Binance api is not initialized',
            );
        }
        return this.clientService.api;
    }

    // ======================================================
    // 🔹 Candles
    // ======================================================
    async subscribeToCandles(
        options: {
            marketType: MarketType;
            symbols: Symbol[];
            interval: TimeFrame;
        },
        handler: any,
    ): Promise<UnsubscribeFn> {
        await this.ensureReady();

        const { marketType, symbols, interval } = options;

        const method =
            marketType === MarketType.futures
                ? 'futuresCandles'
                : 'candles';

        const wrappedHandler = (data: any) => {
            handler(data);

            const payload: SubscriptionValue = {
                value: data,
                options: {
                    connectorType: ConnectorType.binance,
                    marketType,
                    updateMoment: Date.now(),
                },
            };

            this.redis.emit(
                SubscriptionType.PROVIDER_MARKETDATA_CANDLE,
                payload,
            );
        };

        const unsubscribe = this.api.ws[method](
            symbols.map((s) => s.name),
            convertTimeFrame(interval),
            wrappedHandler,
        );

        return () => {
            if (typeof unsubscribe === 'function') {
                unsubscribe({
                    delay: 0,
                    fastClose: true,
                    keepClosed: true,
                });
            }
        };
    }

    // ======================================================
    // 🔹 Symbols (REST polling)
    // ======================================================
    async subscribeToSymbols(
        options: { marketType: MarketType },
        handler: (symbols: any[]) => Promise<void>,
    ): Promise<() => void> {
        await this.ensureReady();

        const { marketType } = options;
        let stopped = false;

        const fetchAndHandle = async () => {
            if (stopped) return;

            try {
                const symbols =
                    marketType === MarketType.spot
                        ? await this.api.exchangeInfo()
                        : await this.api.futuresExchangeInfo();

                await handler(symbols.symbols ?? symbols);

                this.redis.emit(
                    SubscriptionType.PROVIDER_SYMBOLS,
                    {
                        value: symbols.symbols ?? symbols,
                        options: {
                            connectorType: ConnectorType.binance,
                            marketType,
                            updateMoment: Date.now(),
                        },
                    },
                );
            } catch {
                // периодический fetch — без throw
            }
        };

        await fetchAndHandle();
        const intervalId = setInterval(fetchAndHandle, 60 * 60 * 1000);

        return () => {
            stopped = true;
            clearInterval(intervalId);
        };
    }

    // ======================================================
    // 🔹 OrderBook
    // ======================================================
    async subscribeToOrderBook(
        options: {
            marketType: MarketType;
            symbols: Symbol[];
        },
        handler: any,
    ): Promise<UnsubscribeFn> {
        await this.ensureReady();

        const { marketType, symbols } = options;

        const method =
            marketType === MarketType.futures
                ? 'futuresDepth'
                : 'depth';

        const wrappedHandler = (data: any) => {
            handler(data);

            this.redis.emit(
                SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK,
                {
                    value: data,
                    options: {
                        connectorType: ConnectorType.binance,
                        marketType,
                        updateMoment: Date.now(),
                    },
                },
            );
        };

        const unsubscribe = this.api.ws[method](
            symbols.map((s) => s.name),
            wrappedHandler,
        );

        return () => {
            if (typeof unsubscribe === 'function') {
                unsubscribe({
                    delay: 0,
                    fastClose: true,
                    keepClosed: true,
                });
            }
        };
    }

    // ======================================================
    // 🔹 Trades
    // ======================================================
    async subscribeToTrade(
        options: {
            marketType: MarketType;
            symbols: Symbol[];
        },
        handler: any,
    ): Promise<UnsubscribeFn> {
        await this.ensureReady();

        const { marketType, symbols } = options;

        const method =
            marketType === MarketType.futures
                ? 'futuresAggTrades'
                : 'aggTrades';

        const wrappedHandler = (data: any) => {
            handler(data);

            this.redis.emit(
                SubscriptionType.PROVIDER_MARKETDATA_TRADE,
                {
                    value: data,
                    options: {
                        connectorType: ConnectorType.binance,
                        marketType,
                        updateMoment: Date.now(),
                    },
                },
            );
        };

        const unsubscribe = this.api.ws[method](
            symbols.map((s) => s.name),
            wrappedHandler,
        );

        return () => {
            if (typeof unsubscribe === 'function') {
                unsubscribe({
                    delay: 0,
                    fastClose: true,
                    keepClosed: true,
                });
            }
        };
    }

    // ======================================================
    // 🔹 Account
    // ======================================================
    async subscribeToAccount(
        options: { marketType: MarketType },
        handler: any,
    ): Promise<UnsubscribeFn> {
        await this.ensureReady();

        const { marketType } = options;

        const method =
            marketType === MarketType.futures
                ? 'futuresUser'
                : 'user';

        const wrappedHandler = (data: any) => {
            handler(data);

            this.redis.emit(
                SubscriptionType.PROVIDER_ACCOUNT_EVENT,
                {
                    value: data,
                    options: {
                        connectorType: ConnectorType.binance,
                        marketType,
                        updateMoment: Date.now(),
                    },
                },
            );
        };

        const unsubscribe = await this.api.ws[method](wrappedHandler);

        return () => {
            if (typeof unsubscribe === 'function') {
                unsubscribe({
                    delay: 0,
                    fastClose: true,
                    keepClosed: true,
                });
            }
        };
    }

    // ======================================================
    // 🔹 Symbol Prices (через WebSocketService)
    // ======================================================
    async subscribeToSymbolPrices(
        options: {
            marketType: MarketType;
            symbols: string[];
        },
        handler: any,
    ): Promise<UnsubscribeFn> {
        await this.ensureReady();

        const { marketType, symbols } = options;
        let wsUrl: string;

        if (marketType === MarketType.spot) {
            const stream = symbols
                .map((s) => `${s.toLowerCase()}@ticker`)
                .join('/');

            wsUrl = `wss://stream.binance.com:9443/stream?streams=${stream}`;
        } else {
            wsUrl = 'wss://fstream.binance.com/ws';
        }

        const unsubscribeStream =
            await this.webSocketService.subscribeToStream(wsUrl);

        this.webSocketService.onMessage(wsUrl, (data) => {
            handler(data);

            this.redis.emit(
                SubscriptionType.PROVIDER_SYMBOL_PRICES,
                {
                    value: data,
                    options: {
                        connectorType: ConnectorType.binance,
                        marketType,
                        updateMoment: Date.now(),
                    },
                },
            );
        });

        if (marketType === MarketType.futures) {
            this.webSocketService.onOpen(wsUrl, (ws) => {
                const params = symbols.map(
                    (s) => `${s.toLowerCase()}@ticker`,
                );

                ws.send(
                    JSON.stringify({
                        method: 'SUBSCRIBE',
                        params,
                        id: Date.now(),
                    }),
                );

                this.webSocketService.withSocket(wsUrl, (si) => {
                    si.activeSubs = params;
                });
            });
        }

        return () => {
            if (marketType === MarketType.futures) {
                this.webSocketService.withSocket(wsUrl, (si) => {
                    si.ws.send(
                        JSON.stringify({
                            method: 'UNSUBSCRIBE',
                            params: symbols.map(
                                (s) => `${s.toLowerCase()}@ticker`,
                            ),
                            id: Date.now(),
                        }),
                    );
                });
            }

            unsubscribeStream();
        };
    }

    // ======================================================
    // 🔹 Utils
    // ======================================================
    chunkSymbols(
        symbols: string[],
        maxPerWs = 50,
        maxUrlLength = 1900,
    ): string[][] {
        const result: string[][] = [];
        let batch: string[] = [];
        let length = 0;

        for (const sym of symbols) {
            const stream = `${sym.toLowerCase()}@ticker`;
            const extraLength =
                (batch.length > 0 ? 1 : 0) + stream.length;

            if (
                batch.length >= maxPerWs ||
                length + extraLength > maxUrlLength
            ) {
                result.push(batch);
                batch = [];
                length = 0;
            }

            batch.push(stream);
            length += extraLength;
        }

        if (batch.length) {
            result.push(batch);
        }

        return result;
    }
}
