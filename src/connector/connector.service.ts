import { BadRequestException, Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import {
    Asset,
    Connector,
    Order,
    TimeFrame,
    Position,
    ConnectorType,
    MarketType,
    Detector,
    Account,
    Subscription,
    SubscriptionType,
    OrderSource,
    Symbol,
    SubscriptionValue,
    ConnectorMarket,
} from '@barfinex/types';
import { makeConnectorKey } from './connector-key.util';
import { ClientProxy } from '@nestjs/microservices';
import { BinanceService, TinkoffService, AlpacaService, TestnetBinanceFuturesService } from './datasource';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DetectorService } from '../detector/detector.service';
import { AccountService } from '../account/account.service';
import { SymbolEntity } from '../symbol/symbol.entity';
import { KeyService } from '@barfinex/key';

@Injectable()
export class ConnectorService {

    public key: string

    private readonly logger = new Logger(ConnectorService.name);

    private readonly isEmitToRedisEnabled = true

    static connectorsList: Connector[] = []

    public getAllConnectors(): Connector[] {
        return ConnectorService.connectorsList
    }

    static connectors: { [key: string]: Connector } = {}
    static key: string;

    static getConnector(options: { connectorType: ConnectorType; marketType?: MarketType }): Connector | undefined {
        if (!options.marketType) {
            console.warn(`No marketType provided for connector ${options.connectorType}`);
            return undefined;
        }

        const key = makeConnectorKey(options.connectorType, options.marketType);
        return this.connectors[key];
    }

    static setConnector(options: { connectorType: ConnectorType, marketType: MarketType, connector: Connector }): void {
        const key = makeConnectorKey(options.connectorType, options.marketType);
        this.connectors[key] = options.connector
    }

    static accounts: Account[]

    public getAllAccounts(): Account[] {
        return ConnectorService.accounts
    }

    static setAccounts(accounts: Account[]): void {
        this.accounts = accounts
    }

    static getAccount(connectorType: ConnectorType, marketType: MarketType): Account {
        const account = this.accounts.find(
            q => q.connectorType === connectorType && q.marketType === marketType
        );

        if (!account) {
            throw new Error(`Account not found for ${connectorType}/${marketType}`);
        }

        return account;
    }

    static setAccount(account: Account): void {
        const index = this.accounts.findIndex(q => q.connectorType == account.connectorType && q.marketType == account.marketType)
        if (index > -1) this.accounts[index] = account
        else this.accounts.push(account)
    }

    static detectors: Detector[]

    public getAllDetectors(): Detector[] {
        return ConnectorService.detectors
    }

    static setDetectors(detectors: Detector[]): void {
        this.detectors = detectors
    }


    static addSubscription(options: { connectorType: ConnectorType, marketType: MarketType, subscription: Subscription }): void {

        const key = makeConnectorKey(options.connectorType, options.marketType);

        if (!this.connectors[key]?.subscriptions) this.connectors[key].subscriptions = []

        const subscriptionIndex = this.connectors[key]?.subscriptions?.findIndex(q => q.type === options.subscription.type)

        if (subscriptionIndex == -1) {
            this.connectors[key].subscriptions.push(options.subscription);
        }
        else {
            this.connectors[key].subscriptions[subscriptionIndex] = options.subscription
        }

    }

    static getSubscription(options: {
        connectorType: ConnectorType;
        marketType: MarketType;
        subscriptionType: SubscriptionType;
    }): Subscription {
        const key = makeConnectorKey(options.connectorType, options.marketType);
        const connector = this.connectors[key];

        if (!connector) {
            throw new Error(`[ConnectorService] Connector not found: ${key}`);
        }

        if (!connector.subscriptions || connector.subscriptions.length === 0) {
            throw new Error(`[ConnectorService] No subscriptions for connector: ${key}`);
        }

        const subscription = connector.subscriptions.find(
            q => q.type === options.subscriptionType
        );

        if (!subscription) {
            throw new Error(
                `[ConnectorService] Subscription not found for ${options.subscriptionType} on ${key}`
            );
        }

        return subscription;
    }





    async createMessage(content: string) {

        const newMessage = content

        // const newMessage = await this.messagesRepository.create({ content });
        // await this.messagesRepository.save(newMessage);
        return newMessage;
    }

    private readonly DAY = 86400000;

    constructor(

        private readonly binanceService: BinanceService,
        private readonly alpacaService: AlpacaService,
        private readonly tinkoffService: TinkoffService,
        private readonly testnetBinanceFuturesService: TestnetBinanceFuturesService,

        protected readonly keyService: KeyService,

        @Inject(forwardRef(() => AccountService))
        private readonly accountService: AccountService,

        @Inject(forwardRef(() => DetectorService))
        private readonly detectorService: DetectorService,
        @Inject('PROVIDER_SERVICE') private readonly client: ClientProxy,

        @InjectRepository(SymbolEntity)
        private readonly symbolRepository: Repository<SymbolEntity>,

    ) {


    }


    async changeLeverage(
        connectorType: ConnectorType,
        symbol: Symbol,
        newLeverage: number
    ): Promise<Symbol> {
        switch (connectorType) {
            case ConnectorType.binance:
                return await this.binanceService.changeLeverage(symbol, newLeverage);

            case ConnectorType.testnetBinanceFutures:
                return await this.testnetBinanceFuturesService.changeLeverage(symbol, newLeverage);

            default:
                throw new Error(`[ConnectorService] Unsupported connector type: ${connectorType}`);
        }
    }


    async getAssetsInfo(
        connectorType: ConnectorType,
        marketType: MarketType
    ): Promise<{ assets: Asset[]; positions: Position[] }> {
        switch (connectorType) {
            case ConnectorType.binance:
                return await this.binanceService.getAssetsInfo(marketType);

            case ConnectorType.testnetBinanceFutures:
                return await this.testnetBinanceFuturesService.getAssetsInfo(marketType);

            default:
                this.logger.error(`[ConnectorService] Unsupported connector: ${connectorType}`);
                throw new BadRequestException(`Unsupported connector type: ${connectorType}`);
        }
    }


    async getSymbolsInfo(connectorType: ConnectorType, marketType: MarketType): Promise<Symbol[]> {
        const symbols = await this.symbolRepository.find({ where: { connectorType, marketType } });
        return symbols.map((record) => ({
            name: record.symbol, // <-- главное исправление
            baseAsset: record.baseAsset,
            quoteAsset: record.quoteAsset,
            status: record.status,
            connectorType: record.connectorType as ConnectorType,
            marketType: record.marketType as MarketType,
        }));
    }


    async getAccountInfo(connectorType: ConnectorType, marketType: MarketType): Promise<Account> {

        switch (connectorType) {
            case ConnectorType.binance:
                return await this.binanceService.getAccountInfo(marketType)
                break;
            case ConnectorType.testnetBinanceFutures:
                return await this.testnetBinanceFuturesService.getAccountInfo(marketType)
                break;
            default:
                return {
                    connectorType,
                    marketType,
                    assets: [],
                    positions: [],
                    orders: [],
                    symbols: [],
                    isActive: false
                }
                break;
        }
    }


    async getPrices(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbols: Symbol[]
    ): Promise<{ [index: string]: { value: number; moment: number } }> {
        switch (connectorType) {
            case ConnectorType.binance:
                return await this.binanceService.getPrices(marketType, symbols);

            case ConnectorType.testnetBinanceFutures:
                return await this.testnetBinanceFuturesService.getPrices(marketType, symbols);

            default:
                this.logger.error(`[ConnectorService] Unsupported connector: ${connectorType}`);
                throw new BadRequestException(`Unsupported connector type: ${connectorType}`);
        }
    }

    public async getAllOpenOrders(options: {
        connectorType: ConnectorType;
        marketType: MarketType;
    }): Promise<Order[]> {
        switch (options.connectorType) {
            case ConnectorType.binance:
                return await this.binanceService.getOpenOrders({ marketType: options.marketType });

            case ConnectorType.testnetBinanceFutures:
                return await this.testnetBinanceFuturesService.getOpenOrders({ marketType: options.marketType });

            default:
                this.logger.error(`[ConnectorService] Unsupported connector type: ${options.connectorType}`);
                throw new BadRequestException(`Unsupported connector type: ${options.connectorType}`);
        }
    }

    async onModuleInit() {
        this.logger.log('ModuleInit start');

        this.keyService.initializeKey();
        this.key = this.keyService.key;
        this.logger.debug(`Initialized key: ${this.key}`);

        const exchangeCurrency = 'USDT';
        this.logger.debug(`Exchange currency: ${exchangeCurrency}`);

        ConnectorService.connectorsList = await this.getConnectorsList();
        this.logger.debug(
            `connectorsList count: ${ConnectorService.connectorsList?.length ?? 0}`,
        );

        const intervals: TimeFrame[] = [TimeFrame.min1];
        this.logger.debug(`intervals: ${intervals.join(', ')}`);

        ConnectorService.setDetectors(
            await this.detectorService.getAllDetectorsByProviderKey(ConnectorService.key),
        );
        this.logger.debug(
            `detectors count: ${ConnectorService.detectors?.length ?? 0}`,
        );

        if (ConnectorService.connectorsList) {
            ConnectorService.connectorsList.forEach((connector) => {
                this.logger.log(
                    `Connector ${connector.connectorType}, assets=${connector.assets?.length ?? 0}, markets=${connector.markets?.length ?? 0}`,
                );

                const symbols: Symbol[] = [];

                if (connector.assets)
                    connector.assets.forEach((asset) => {
                        if (asset.symbol.name !== exchangeCurrency) {
                            symbols.push({ name: asset.symbol.name + exchangeCurrency });
                            this.logger.debug(
                                `Added asset symbol: ${asset.symbol.name + exchangeCurrency}`,
                            );
                        }
                    });

                connector.markets.forEach((market) => {
                    this.logger.log(
                        `Market: ${market.marketType}, symbols=${market.symbols?.length ?? 0}`,
                    );

                    const detectorsCollection = ConnectorService.detectors.filter((detector) =>
                        detector.providers?.some((provider) =>
                            provider.connectors?.some(
                                (c) =>
                                    c.connectorType === connector.connectorType &&
                                    c.markets?.some((m) => m.marketType === market.marketType),
                            ),
                        ),
                    );

                    this.logger.debug(
                        `detectorsCollection count for ${market.marketType}: ${detectorsCollection.length}`,
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

                    if (connector.positions)
                        connector.positions.forEach((position) => {
                            if (!symbols.find((q) => q === position.symbol)) {
                                symbols.push(position.symbol);
                                this.logger.debug(
                                    `Added position symbol: ${position.symbol.name}`,
                                );
                            }
                        });

                    const preparedConnector: Connector = {
                        connectorType: connector.connectorType,
                        markets: connector.markets,
                        currency: exchangeCurrency,
                        intervals: intervals,
                    };
                    this.logger.debug(
                        `Prepared connector for ${connector.connectorType} / ${market.marketType}`,
                    );

                    ConnectorService.setConnector({
                        connectorType: connector.connectorType,
                        marketType: market.marketType,
                        connector: preparedConnector,
                    });

                    if (connector.assets) {
                        const defaultSymbol = 'BTCUSDT';
                        if (!symbols.find((q) => q.name === defaultSymbol)) {
                            symbols.push({ name: defaultSymbol });
                            this.logger.warn(
                                `Added default symbol: ${defaultSymbol} (connector ${connector.connectorType})`,
                            );
                        }
                    }

                    if (symbols.length > 0) {
                        this.logger.log(
                            `Updating subscription: connector=${connector.connectorType}, market=${market.marketType}, symbols=${symbols.map((s) => s.name).join(', ')}`,
                        );
                        this.updateSubscribeCollection(
                            connector.connectorType,
                            market.marketType,
                            symbols,
                            intervals,
                        );
                    }
                });
            });
        }

        this.logger.log('ModuleInit complete');
    }



    async onModuleDestroy() {
        console.log(`[${this.constructor.name}] ModuleDestroy start`);

        // обновляем список коннекторов
        ConnectorService.connectorsList = await this.getConnectorsList();
        console.log(`[${this.constructor.name}] connectorsList:`, ConnectorService.connectorsList);

        const intervals: TimeFrame[] = [TimeFrame.min1];
        console.log(`[${this.constructor.name}] intervals:`, intervals);

        // загружаем детекторы
        ConnectorService.setDetectors(
            await this.detectorService.getAllDetectorsByProviderKey(ConnectorService.key),
        );
        console.log(
            `[${this.constructor.name}] detectors:`,
            ConnectorService.detectors.map(d => ({ key: d.key, symbols: d.symbols?.length })),
        );

        // пробегаем по коннекторам
        ConnectorService.connectorsList.forEach((connector) => {
            console.log(
                `[${this.constructor.name}] connector: ${connector.connectorType}, markets: ${connector.markets?.length}`,
            );

            connector.markets.forEach((market) => {
                console.log(
                    `[${this.constructor.name}] marketType: ${market.marketType}, symbols: ${market.symbols?.length}`,
                );

                if (market.symbols && market.symbols.length > 0) {
                    console.log(
                        `[${this.constructor.name}] unsubscribeCollection(${connector.connectorType}) (market.symbols > 0)`,
                    );
                    this.unsubscribeCollection(connector.connectorType);
                }

                ConnectorService.detectors.forEach((detector) => {
                    const { symbols } = detector;
                    console.log(
                        `[${this.constructor.name}] detector ${detector.key} symbols: ${symbols?.length}`,
                    );
                    if (symbols.length > 0) {
                        console.log(
                            `[${this.constructor.name}] unsubscribeCollection(${connector.connectorType}) (detector.symbols > 0)`,
                        );
                        this.unsubscribeCollection(connector.connectorType);
                    }
                });
            });
        });

        console.log(`[${this.constructor.name}] ModuleDestroy complete`);
    }







    async openOrder(order: Order): Promise<Order> {
        const subscriptionType = SubscriptionType.PROVIDER_ORDER_CREATE;
        const subscriptionValue: SubscriptionValue = {
            value: order,
            options: {
                connectorType: order.connectorType,
                marketType: order.marketType,
                key: this.key,
                updateMoment: Date.now(),
            },
        };

        let result: Order;

        switch (order.connectorType) {
            case ConnectorType.binance:
                result = await this.binanceService.openOrder(order);
                break;
            case ConnectorType.alpaca:
                result = await this.alpacaService.openOrder(order);
                break;
            case ConnectorType.tinkoff:
                result = await this.tinkoffService.openOrder(order);
                break;
            case ConnectorType.testnetBinanceFutures:
                result = await this.testnetBinanceFuturesService.openOrder(order);
                break;
            default:
                throw new BadRequestException(`Unsupported connector type: ${order.connectorType}`);
        }

        if (this.isEmitToRedisEnabled) {
            this.client.emit(subscriptionType, subscriptionValue);
        }

        return result;
    }




    async getOpenOrders(options: {
        symbol: Symbol;
        source: OrderSource;
        connectorType: ConnectorType;
        marketType: MarketType;
    }): Promise<Order[]> {
        const { symbol, source, connectorType, marketType } = options;

        switch (connectorType) {
            case ConnectorType.binance:
                return await this.binanceService.getOpenOrders({ symbol, marketType });

            case ConnectorType.alpaca:
                return [];

            case ConnectorType.tinkoff:
                return [];

            case ConnectorType.testnetBinanceFutures:
                return await this.testnetBinanceFuturesService.getOpenOrders({ symbol, marketType });

            default:
                throw new BadRequestException(`Unsupported connector type: ${connectorType}`);
        }
    }

    async closeOrder(order: Order): Promise<Order> {
        const { externalId, symbol, connectorType, marketType, source } = order;

        // строгая проверка входных данных
        if (!externalId) {
            throw new BadRequestException('Order.externalId is required to close order');
        }
        if (!symbol) {
            throw new BadRequestException('Order.symbol is required to close order');
        }

        let result: Order = {
            useSandbox: false,
            connectorType,
            marketType,
            source,
        };

        switch (connectorType) {
            case ConnectorType.binance:
                result = await this.binanceService.closeOrder({
                    id: externalId,
                    symbol,
                    marketType,
                });
                break;

            case ConnectorType.testnetBinanceFutures:
                result = await this.testnetBinanceFuturesService.closeOrder({
                    id: externalId,
                    symbol,
                    marketType,
                });
                break;

            case ConnectorType.alpaca:
            case ConnectorType.tinkoff:
                throw new BadRequestException(`closeOrder not supported for ${connectorType}`);

            default:
                throw new BadRequestException(`Unsupported connector type: ${connectorType}`);
        }

        const subscriptionValue: SubscriptionValue = {
            value: result,
            options: {
                connectorType: result.connectorType,
                marketType: result.marketType,
                key: this.key,
                updateMoment: Date.now(),
            },
        };

        if (this.isEmitToRedisEnabled) {
            this.client.emit(SubscriptionType.PROVIDER_ORDER_CLOSE, subscriptionValue);
        }

        return result;
    }

    async closeAllOrders(options: { symbol: Symbol, connectorType: ConnectorType, marketType: MarketType }): Promise<void> {

        const { symbol, connectorType, marketType } = options

        switch (connectorType) {
            case ConnectorType.binance:
                return await this.binanceService.closeAllOrders({ symbol, marketType })
                break;
            case ConnectorType.alpaca:
                return
                break;
            case ConnectorType.tinkoff:
                return
                break;
            case ConnectorType.testnetBinanceFutures:
                return await this.testnetBinanceFuturesService.closeAllOrders({ symbol, marketType })
                break;
        }
    }



    async subscribeCollection(connectorType: ConnectorType, marketType: MarketType, symbols: Symbol[], intervals: TimeFrame[]): Promise<any> {

        console.log('subscribeCollection');

        switch (connectorType) {
            case ConnectorType.binance:
                await this.binanceService.subscribe(marketType, symbols, intervals)
                break;
            case ConnectorType.alpaca:
                break;
            case ConnectorType.tinkoff:
                break;
            case ConnectorType.testnetBinanceFutures:
                return await this.testnetBinanceFuturesService.subscribe(marketType, symbols, intervals)
                break;
        }
    }


    async unsubscribeCollection(connectorType: ConnectorType): Promise<any> {
        switch (connectorType) {
            case ConnectorType.binance:
                await this.binanceService.unsubscribe()
                break;
            case ConnectorType.alpaca:
                break;
            case ConnectorType.tinkoff:
                break;
            case ConnectorType.testnetBinanceFutures:
                return await this.testnetBinanceFuturesService.unsubscribe()
                break;
        }
    }


    async updateSubscribeCollection(connectorType: ConnectorType, marketType: MarketType, symbols: Symbol[], intervals?: TimeFrame[]): Promise<void> {

        switch (connectorType) {
            case ConnectorType.binance:
                await this.binanceService.updateSubscribeCollection(marketType, symbols, intervals)
                break;
            case ConnectorType.testnetBinanceFutures:
                await this.testnetBinanceFuturesService.updateSubscribeCollection(marketType, symbols, intervals)
                break;
            case ConnectorType.alpaca:
                break;
            case ConnectorType.tinkoff:
                break;

        }
    }

    async all(): Promise<Connector[]> {

        let result: Connector[] = []

        Object.keys(ConnectorService.connectors).map((key: string) => {

            result.push(ConnectorService.connectors[key]);
        })

        return result
    }

    async get(options: { connectorType: ConnectorType; marketType?: MarketType }): Promise<Connector> {
        const { connectorType, marketType } = options;
        const connector = ConnectorService.getConnector({ connectorType, marketType });

        if (!connector) {
            throw new Error(`Connector not found for ${connectorType}${marketType ? ' ' + marketType : ''}`);
        }

        if (marketType) {
            connector.markets = connector.markets.filter(market => market.marketType === marketType);
        }

        return connector;
    }


    async getConnectorsList(): Promise<Connector[]> {
        const accounts = await this.accountService.getAll();
        const connectors: Connector[] = [];

        for (const account of accounts) {
            if (!account.connectorType) continue; // ⚙️ пропускаем, если не указан тип коннектора

            const connectorIndex = connectors.findIndex(
                (q) => q.connectorType === account.connectorType
            );

            if (!account.connectorType || !account.marketType) continue;

            const market: ConnectorMarket = {
                marketType: account.marketType,
                symbols: account.symbols ?? [],
            };

            if (connectorIndex > -1) {
                const connector = connectors[connectorIndex];

                // ⚙️ безопасно инициализируем опциональные массивы
                connector.assets ??= [];
                connector.positions ??= [];
                connector.orders ??= [];

                connector.assets.push(...(account.assets ?? []));
                connector.positions.push(...(account.positions ?? []));
                connector.orders.push(...(account.orders ?? []));

                const marketIndex = connector.markets.findIndex(
                    (m) => m.marketType === market.marketType
                );

                if (marketIndex > -1) {
                    const targetMarket = connector.markets[marketIndex];

                    // ✅ Добавляем только новые символы (без дубликатов)
                    const existingSymbols = new Set(targetMarket.symbols.map((s) => s.name));
                    const newSymbols = (market.symbols ?? []).filter(
                        (s) => !existingSymbols.has(s.name)
                    );

                    targetMarket.symbols.push(...newSymbols);
                } else {
                    connector.markets.push(market);
                }
            } else {
                // ✅ создаём новый connector строго по типу
                const connector: Connector = {
                    connectorType: account.connectorType,
                    markets: [market],
                    isActive: account.isActive ?? false,
                    assets: account.assets ?? [],
                    positions: account.positions ?? [],
                    orders: account.orders ?? [],
                    subscriptions: [],
                };

                connectors.push(connector);
            }
        }

        return connectors;
    }
}
