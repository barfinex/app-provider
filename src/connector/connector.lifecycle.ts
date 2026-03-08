// connector.lifecycle.ts
import {
    Injectable,
    Logger,
    forwardRef,
    Inject,
    OnModuleInit,
    OnModuleDestroy,
} from '@nestjs/common';
import {
    ConnectorType,
    MarketType,
    SubscriptionType,
    TimeFrame,
    Symbol,
    ALL_CANDLE_INTERVALS,
} from '@barfinex/types';
import { ConfigService } from '@barfinex/config';

import { ConnectorRegistry } from './connector.registry';
import { ConnectorBuilder } from './connector.builder';
import { ConnectorSubscriptionService } from './connector.subscription.service';
import { DetectorService } from '../detector/detector.service';
import { KeyService } from '@barfinex/key';
import { AccountService } from '../account/account.service';

@Injectable()
export class ConnectorLifecycle
    implements OnModuleInit, OnModuleDestroy {

    private readonly logger = new Logger(ConnectorLifecycle.name);

    constructor(
        private readonly keyService: KeyService,

        // private readonly accountService: AccountService,

        @Inject(forwardRef(() => DetectorService))
        private readonly detectorService: DetectorService,

        @Inject(forwardRef(() => AccountService))
        private readonly accountService: AccountService,

        private readonly builder: ConnectorBuilder,
        private readonly subscriptionService: ConnectorSubscriptionService,
        private readonly configService: ConfigService,
    ) { }

    // =========================================================================
    // 🔹 MODULE INIT
    // =========================================================================

    private initialized = false;
    private destroyed = false;
    private destroyInFlight: Promise<void> | null = null;

    async onModuleInit(): Promise<void> {
        if (this.initialized) {
            this.logger.warn('ConnectorLifecycle already initialized — skip');
            return;
        }

        this.logger.log('ModuleInit start');

        try {
            // =========================================================================
            // 1) ИНИЦИАЛИЗАЦИЯ КЛЮЧА
            // =========================================================================
            this.keyService.initializeKey();
            ConnectorRegistry.key = this.keyService.key;
            this.logger.debug(`Initialized key: ${ConnectorRegistry.key}`);

            // =========================================================================
            // 2) ЗАГРУЗКА АККАУНТОВ (КРИТИЧЕСКИ ВАЖНО)
            // =========================================================================
            this.logger.log('Loading accounts...');
            await this.accountService.getAll(); // ⬅️ ЕДИНСТВЕННОЕ МЕСТО
            this.logger.log('Accounts loaded');

            // =========================================================================
            // 3) ПОСТРОЕНИЕ CONNECTORS (ИЗ АККАУНТОВ)
            // =========================================================================
            const connectors = await this.builder.getConnectorsList();
            this.logger.debug(`Initial connectors count: ${connectors.length}`);

            ConnectorRegistry.connectors = {};

            connectors.forEach((connector) => {
                for (const market of connector.markets ?? []) {
                    ConnectorRegistry.setConnector({
                        connectorType: connector.connectorType,
                        marketType: market.marketType,
                        connector,
                    });
                }

                this.logger.log(
                    `Registered connector: ${connector.connectorType}, markets=${connector.markets?.length ?? 0}`,
                );
            });

            // =========================================================================
            // 4) ИНТЕРВАЛЫ (из конфига candleSync.intervals или все по умолчанию)
            // =========================================================================
            const fromConfig = this.configService.getConfig()?.provider?.candleSync?.intervals;
            const intervals: TimeFrame[] =
                Array.isArray(fromConfig) && fromConfig.length > 0
                    ? (fromConfig as TimeFrame[])
                    : [...ALL_CANDLE_INTERVALS];
            this.logger.debug(`Intervals: ${intervals.join(', ')}`);

            // =========================================================================
            // 5) ЗАГРУЗКА ДЕТЕКТОРОВ
            // =========================================================================
            ConnectorRegistry.setDetectors(
                await this.detectorService.getAllDetectorsByProviderKey(
                    ConnectorRegistry.key,
                ),
            );

            this.logger.debug(
                `Detectors count: ${ConnectorRegistry.detectors?.length ?? 0}`,
            );

            // =========================================================================
            // 6) ПОДПИСКИ (accounts + detectors)
            // =========================================================================
            const allConnectors = Object.values(ConnectorRegistry.connectors);

            // 🔥 ДОБАВЛЕНО: дедуп по connectorType (НЕ УДАЛЯЕТ существующий код)
            const uniqueConnectorsMap = new Map<string, typeof allConnectors[number]>();
            for (const connector of allConnectors) {
                if (!uniqueConnectorsMap.has(connector.connectorType)) {
                    uniqueConnectorsMap.set(connector.connectorType, connector);
                }
            }
            const uniqueConnectors = Array.from(uniqueConnectorsMap.values());

            for (const connector of uniqueConnectors) {
                this.logger.log(
                    `Connector ${connector.connectorType}, markets=${connector.markets?.length ?? 0}`,
                );

                for (const market of connector.markets) {
                    const symbols: Symbol[] = [];

                    this.logger.log(
                        `Market: ${market.marketType}, symbols=${market.symbols?.length ?? 0}`,
                    );

                    // -----------------------------------------------------------------
                    // 6.1) SYMBOLS ИЗ АККАУНТОВ (ГЛАВНЫЙ ИСТОЧНИК)
                    // -----------------------------------------------------------------
                    market.symbols?.forEach((symbol) => {
                        if (!symbols.find((q) => q.name === symbol.name)) {
                            symbols.push(symbol);
                        }
                    });

                    // -----------------------------------------------------------------
                    // 6.2) SYMBOLS ИЗ ДЕТЕКТОРОВ
                    // -----------------------------------------------------------------
                    const detectorsCollection = ConnectorRegistry.detectors.filter(
                        (detector) =>
                            detector.providers?.some((provider) =>
                                provider.connectors?.some(
                                    (c) =>
                                        c.connectorType === connector.connectorType &&
                                        c.markets?.some(
                                            (m) =>
                                                m.marketType === market.marketType,
                                        ),
                                ),
                            ),
                    );

                    this.logger.debug(
                        `Detectors for ${market.marketType}: ${detectorsCollection.length}`,
                    );

                    detectorsCollection.forEach((detector) => {
                        detector.symbols.forEach((symbol) => {
                            if (!symbols.find((q) => q.name === symbol.name)) {
                                symbols.push(symbol);
                                this.logger.debug(
                                    `Added detector symbol: ${symbol.name} (detector ${detector.key})`,
                                );
                            }
                        });
                    });

                    // -----------------------------------------------------------------
                    // 6.3) SYMBOLS ИЗ КОНФИГУРАЦИИ ПОДПИСОК MARKET DATA
                    // -----------------------------------------------------------------
                    const configuredStreamSymbols = this.collectConfiguredMarketDataSymbols(
                        connector.connectorType,
                        market.marketType,
                    );
                    configuredStreamSymbols.forEach((symbolName) => {
                        if (!symbols.find((q) => q.name === symbolName)) {
                            symbols.push({ name: symbolName });
                            this.logger.debug(
                                `Added configured stream symbol: ${symbolName} (connector ${connector.connectorType})`,
                            );
                        }
                    });

                    // -----------------------------------------------------------------
                    // 6.4) DEFAULT SYMBOL (BTCUSDT)
                    // -----------------------------------------------------------------
                    const defaultSymbol = 'BTCUSDT';
                    if (!symbols.find((q) => q.name === defaultSymbol)) {
                        symbols.push({ name: defaultSymbol });
                        this.logger.warn(
                            `Added default symbol: ${defaultSymbol} (connector ${connector.connectorType})`,
                        );
                    }

                    // -----------------------------------------------------------------
                    // 6.5) ОБНОВЛЕНИЕ ПОДПИСОК
                    // -----------------------------------------------------------------
                    if (symbols.length > 0) {
                        const balanceStats = this.accountService.getBalanceStats(
                            connector.connectorType,
                            market.marketType,
                        );
                        this.logger.log(
                            `Updating subscription: connector=${connector.connectorType}, market=${market.marketType}, symbols=${symbols
                                .map((s) => s.name)
                                .join(', ')}`,
                        );

                        await this.subscriptionService.updateSubscribeCollection(
                            connector.connectorType,
                            market.marketType,
                            symbols,
                            intervals,
                            balanceStats,
                        );
                    }
                }
            }

            this.logger.log('ModuleInit complete');
        } catch (error) {
            this.logger.error('ConnectorLifecycle initialization failed', error);
            throw error;
        } finally {
            // 🔥 КРИТИЧЕСКИ ВАЖНО — ТОЛЬКО ЗДЕСЬ
            this.initialized = true;
        }
    }

    // =========================================================================
    // 🔹 MODULE DESTROY
    // =========================================================================

    async onModuleDestroy(): Promise<void> {
        if (this.destroyInFlight) {
            await this.destroyInFlight;
            return;
        }

        if (this.destroyed) {
            this.logger.warn('[ConnectorLifecycle] ModuleDestroy already executed; skip duplicate call');
            return;
        }
        this.destroyInFlight = (async () => {
            this.destroyed = true;
            this.logger.log('[ConnectorLifecycle] ModuleDestroy start');

            const allConnectors = Object.values(ConnectorRegistry.connectors);
            const intervals: TimeFrame[] = [TimeFrame.min1];

            this.logger.debug(`[ConnectorLifecycle] destroy intervals=${intervals.join(',')}`);

            ConnectorRegistry.setDetectors(
                await this.detectorService.getAllDetectorsByProviderKey(
                    ConnectorRegistry.key,
                ),
            );

            this.logger.debug(
                `[ConnectorLifecycle] destroy detectors=${JSON.stringify(
                    ConnectorRegistry.detectors.map((d) => ({
                        key: d.key,
                        symbols: d.symbols?.length,
                    })),
                )}`,
            );

            // ✅ GUARDED unsubscribe: один раз на connectorType
            const unsubscribed = new Set<ConnectorType>();

            allConnectors.forEach((connector) => {
                this.logger.debug(
                    `[ConnectorLifecycle] destroy connector=${connector.connectorType} markets=${connector.markets?.length}`,
                );

                connector.markets.forEach((market) => {
                    this.logger.debug(
                        `[ConnectorLifecycle] destroy marketType=${market.marketType} symbols=${market.symbols?.length}`,
                    );

                    if (market.symbols && market.symbols.length > 0) {
                        this.logger.debug(
                            `[ConnectorLifecycle] destroy unsubscribe connector=${connector.connectorType} source=market-symbols`,
                        );

                        if (!unsubscribed.has(connector.connectorType)) {
                            this.subscriptionService.unsubscribeCollection(
                                connector.connectorType,
                            );
                            unsubscribed.add(connector.connectorType);
                        }
                    }

                    ConnectorRegistry.detectors.forEach((detector) => {
                        const { symbols } = detector;

                        this.logger.debug(
                            `[ConnectorLifecycle] destroy detector=${detector.key} symbols=${symbols?.length}`,
                        );

                        if (symbols.length > 0) {
                            this.logger.debug(
                                `[ConnectorLifecycle] destroy unsubscribe connector=${connector.connectorType} source=detector-symbols`,
                            );

                            if (!unsubscribed.has(connector.connectorType)) {
                                this.subscriptionService.unsubscribeCollection(
                                    connector.connectorType,
                                );
                                unsubscribed.add(connector.connectorType);
                            }
                        }
                    });
                });
            });

            this.logger.log(
                `[ConnectorLifecycle] ModuleDestroy complete unsubscribed=${Array.from(unsubscribed).join(',') || 'none'}`,
            );
        })();

        await this.destroyInFlight;
    }

    private collectConfiguredMarketDataSymbols(
        connectorType: ConnectorType,
        marketType: MarketType,
    ): string[] {
        const runtimeConfig = this.configService.getConfig() as {
            provider?: {
                connectors?: Array<{
                    connectorType?: ConnectorType | string;
                    subscriptions?: Array<{
                        type?: SubscriptionType | string;
                        active?: boolean;
                        symbols?: string[];
                    }>;
                }>;
            };
        };
        const configuredConnector = (runtimeConfig.provider?.connectors ?? []).find(
            connector => String(connector?.connectorType || '').toLowerCase() === String(connectorType).toLowerCase(),
        );
        const streams = new Set<SubscriptionType | string>([
            SubscriptionType.PROVIDER_MARKETDATA_TRADE,
            SubscriptionType.PROVIDER_MARKETDATA_ORDERBOOK,
            SubscriptionType.PROVIDER_MARKETDATA_CANDLE,
            SubscriptionType.PROVIDER_SYMBOL_PRICES,
        ]);
        const collected = new Set<string>();
        for (const subscription of configuredConnector?.subscriptions ?? []) {
            if (!subscription?.active) continue;
            if (!streams.has(subscription.type || '')) continue;
            for (const rawSymbol of subscription.symbols ?? []) {
                const normalized = String(rawSymbol || '')
                    .trim()
                    .toUpperCase();
                if (!normalized) continue;
                collected.add(normalized);
            }
        }
        if (collected.size > 0) {
            this.logger.debug(
                `[ConnectorLifecycle] configured marketdata symbols market=${marketType} count=${collected.size}`,
            );
        }
        return Array.from(collected);
    }
}
