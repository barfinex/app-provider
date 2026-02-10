import { Inject, Injectable, OnModuleInit, forwardRef } from '@nestjs/common';
import {
    Account,
    ConnectorType,
    MarketType,
    Asset,
    Position,
    Connector,
    Order,
    Symbol,
} from '@barfinex/types';
import { ConnectorService } from '../connector/connector.service';
import { BinanceClientService } from
    '../connector/datasource/binance/core/binance.client';

@Injectable()
export class AccountService {

    private readyResolver!: () => void;
    private ready = new Promise<void>((resolve) => {
        this.readyResolver = resolve;
    });



    private readonly DAY = 86400000;

    constructor(
        @Inject(forwardRef(() => ConnectorService))
        private readonly connectorService: ConnectorService,
        private readonly binanceClient: BinanceClientService,
    ) { }



    // async onModuleInit() {
    //     console.log('🔥 AccountService onModuleInit');
    //     await this.getAll();

    // }


    async whenReady(): Promise<void> {
        return this.ready;
    }

    // =========================================================================
    // 🔹 SINGLE ACCOUNT
    // =========================================================================

    async getAccountInfo(
        connectorType: ConnectorType,
        marketType: MarketType,
    ): Promise<Account> {

        let account: Account = {
            connectorType,
            marketType,
            assets: [],
            positions: [],
            orders: [],
            symbols: [],
            isActive: false,
        };

        await this.binanceClient.ensureReady();

        account = await this.connectorService.getAccountInfo(
            connectorType,
            marketType,
        );

        if (account && account.isActive) {
            const orders: Order[] =
                await this.connectorService.getAllOpenOrders({
                    connectorType,
                    marketType,
                });

            if (orders?.length) {
                account.orders = orders;
            }
        }

        // =========================================================================
        // 🔥 ВАЖНО: ЗАПОЛНЯЕМ SYMBOLS (утраченная логика)
        // =========================================================================

        const symbolsMap = new Map<string, Symbol>();

        // 1️⃣ Из позиций
        account.positions?.forEach((position) => {
            if (position.symbol?.name) {
                symbolsMap.set(position.symbol.name, {
                    name: position.symbol.name,
                    connectorType,
                    marketType,
                });
            }
        });

        // 2️⃣ Из активов (asset + USDT)
        const exchangeCurrency = 'USDT';

        account.assets?.forEach((asset) => {
            const base = asset.symbol?.name;
            if (!base) return;

            const symbolName =
                base === exchangeCurrency
                    ? exchangeCurrency
                    : `${base}${exchangeCurrency}`;

            symbolsMap.set(symbolName, {
                name: symbolName,
                connectorType,
                marketType,
            });
        });

        // 3️⃣ Гарантируем BTCUSDT
        if (!symbolsMap.has('BTCUSDT')) {
            symbolsMap.set('BTCUSDT', {
                name: 'BTCUSDT',
                connectorType,
                marketType,
            });
        }

        account.symbols = Array.from(symbolsMap.values());

        return account;
    }

    // =========================================================================
    // 🔹 LEVERAGE
    // =========================================================================

    async changeLeverage(
        connectorType: ConnectorType,
        symbol: Symbol,
        newLeverage: number,
    ): Promise<Symbol> {
        return await this.connectorService.changeLeverage(
            connectorType,
            symbol,
            newLeverage,
        );
    }

    // =========================================================================
    // 🔹 ASSETS INFO (MULTI-MARKET)
    // =========================================================================

    async getAssetsInfo(options: Connector): Promise<{
        assets: Asset[];
        positions: Position[];
    }> {

        const result: { assets: Asset[]; positions: Position[] } = {
            assets: [],
            positions: [],
        };

        const promises = options.markets.map(async (market) => {
            const assetsInfo =
                await this.connectorService.getAssetsInfo(
                    options.connectorType,
                    market.marketType,
                );

            return {
                assets: assetsInfo.assets,
                positions: assetsInfo.positions,
            };
        });

        const results = await Promise.all(promises);

        results.forEach((assetsInfo) => {
            result.assets.push(...assetsInfo.assets);
            result.positions.push(...assetsInfo.positions);
        });

        return result;
    }

    // =========================================================================
    // 🔹 ALL ACCOUNTS
    // =========================================================================

    async getAll(): Promise<Account[]> {
        const accounts: Account[] = [];


        const connectorTypes = Object.values(ConnectorType);
        const marketTypes = Object.values(MarketType);

        // console.log('ConnectorTypes:', connectorTypes);
        // console.log('MarketTypes:', marketTypes);

        for (const connectorType of connectorTypes) {
            for (const marketType of marketTypes) {

                // console.log('ConnectorTypes:', connectorTypes);
                // console.log('MarketTypes:', marketTypes);

                const account =
                    await this.getAccountInfo(connectorType, marketType);

                if (account?.isActive) {
                    accounts.push(account);
                }
            }
        }

        ConnectorService.setAccounts(accounts);

        // console.log("accounts:", accounts)

        this.readyResolver();

        return accounts;
    }
}
