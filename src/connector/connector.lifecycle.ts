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
    TimeFrame,
    Symbol,
} from '@barfinex/types';

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
    ) { }

    // =========================================================================
    // 🔹 MODULE INIT
    // =========================================================================

    private initialized = false;

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
            // 4) ИНТЕРВАЛЫ
            // =========================================================================
            const intervals: TimeFrame[] = [TimeFrame.min1];
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
                    // 6.3) DEFAULT SYMBOL (BTCUSDT)
                    // -----------------------------------------------------------------
                    const defaultSymbol = 'BTCUSDT';
                    if (!symbols.find((q) => q.name === defaultSymbol)) {
                        symbols.push({ name: defaultSymbol });
                        this.logger.warn(
                            `Added default symbol: ${defaultSymbol} (connector ${connector.connectorType})`,
                        );
                    }

                    // -----------------------------------------------------------------
                    // 6.4) ОБНОВЛЕНИЕ ПОДПИСОК
                    // -----------------------------------------------------------------
                    if (symbols.length > 0) {
                        this.logger.log(
                            `Updating subscription: connector=${connector.connectorType}, market=${market.marketType}, symbols=${symbols
                                .map((s) => s.name)
                                .join(', ')}`,
                        );

                        this.subscriptionService.updateSubscribeCollection(
                            connector.connectorType,
                            market.marketType,
                            symbols,
                            intervals,
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
        console.log(`[${this.constructor.name}] ModuleDestroy start`);

        const allConnectors = Object.values(ConnectorRegistry.connectors);
        const intervals: TimeFrame[] = [TimeFrame.min1];

        console.log(`[${this.constructor.name}] intervals:`, intervals);

        ConnectorRegistry.setDetectors(
            await this.detectorService.getAllDetectorsByProviderKey(
                ConnectorRegistry.key,
            ),
        );

        console.log(
            `[${this.constructor.name}] detectors:`,
            ConnectorRegistry.detectors.map((d) => ({
                key: d.key,
                symbols: d.symbols?.length,
            })),
        );

        // ✅ GUARDED unsubscribe: один раз на connectorType
        const unsubscribed = new Set<ConnectorType>();

        allConnectors.forEach((connector) => {
            console.log(
                `[${this.constructor.name}] connector: ${connector.connectorType}, markets: ${connector.markets?.length}`,
            );

            connector.markets.forEach((market) => {
                console.log(
                    `[${this.constructor.name}] marketType: ${market.marketType}, symbols=${market.symbols?.length}`,
                );

                if (market.symbols && market.symbols.length > 0) {
                    console.log(
                        `[${this.constructor.name}] unsubscribeCollection(${connector.connectorType}) (market.symbols > 0)`,
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

                    console.log(
                        `[${this.constructor.name}] detector ${detector.key} symbols: ${symbols?.length}`,
                    );

                    if (symbols.length > 0) {
                        console.log(
                            `[${this.constructor.name}] unsubscribeCollection(${connector.connectorType}) (detector.symbols > 0)`,
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

        console.log(
            `[${this.constructor.name}] unsubscribed connectors:`,
            Array.from(unsubscribed),
        );

        console.log(`[${this.constructor.name}] ModuleDestroy complete`);
    }
}
