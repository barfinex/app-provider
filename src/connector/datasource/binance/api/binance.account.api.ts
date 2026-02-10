import { Injectable, InternalServerErrorException } from '@nestjs/common';
import moment from 'moment';

import {
    Account,
    Asset,
    Position,
    TradeSide,
    Order,
    OrderType,
    OrderSide,
    OrderSourceType,
    Symbol,
    MarketType,
    ConnectorType,
    AccountDailyProfitDetail,
} from '@barfinex/types';

import { ConfigService } from '@barfinex/config';
import { FuturesIncomeResult } from 'binance-api-node';

import { BinanceClientService } from '../core/binance.client';

@Injectable()
export class BinanceAccountApi {
    private readonly connectorType = ConnectorType.binance;

    constructor(
        private readonly client: BinanceClientService,
        private readonly configService: ConfigService,
    ) { }

    async getAssetsInfo(
        marketType: MarketType,
    ): Promise<{ assets: Asset[]; positions: Position[] }> {
        await this.client.ensureReady();

        const api = this.client.api;
        const currency = 'USDT';

        const result: { assets: Asset[]; positions: Position[] } = {
            assets: [],
            positions: [],
        };

        switch (marketType) {
            case MarketType.spot: {
                const pricesSpot = await api.prices();
                const accountInfoSpot = (await api.accountInfo()).balances.filter(
                    q => parseFloat(q.free) !== 0 || parseFloat(q.locked),
                );

                accountInfoSpot.forEach(element => {
                    result.assets.push({
                        connectorType: this.connectorType,
                        marketType,
                        symbol: { name: element.asset },
                        walletBalance:
                            parseFloat(element.free) + parseFloat(element.locked),
                        availableBalance: parseFloat(element.free),
                        price: [
                            {
                                currency,
                                value:
                                    element.asset === currency
                                        ? 1
                                        : parseFloat(pricesSpot[element.asset + currency]),
                            },
                        ],
                    });
                });
                break;
            }

            case MarketType.futures: {
                const pricesFutures = await api.futuresPrices();
                const accountInfoFutures = await api.futuresAccountInfo();

                const assets = accountInfoFutures.assets.filter(
                    q =>
                        parseFloat(q.walletBalance) !== 0 ||
                        parseFloat(q.availableBalance) !== 0,
                );

                assets.forEach(element => {
                    result.assets.push({
                        connectorType: this.connectorType,
                        marketType,
                        symbol: { name: element.asset },
                        walletBalance: parseFloat(element.walletBalance),
                        availableBalance: parseFloat(element.availableBalance),
                        price: [
                            {
                                currency,
                                value:
                                    element.asset === currency
                                        ? 1
                                        : parseFloat(pricesFutures[element.asset + currency]),
                            },
                        ],
                    });
                });

                const positions = accountInfoFutures.positions.filter(
                    q => parseFloat(q.positionAmt) !== 0,
                );

                positions.forEach(element => {
                    result.positions.push({
                        connectorType: this.connectorType,
                        marketType,
                        symbol: { name: element.symbol },
                        quantity: parseFloat(element.positionAmt),
                        entryPrice: parseFloat(element.entryPrice),
                        initialMargin: parseFloat(element.initialMargin),
                        leverage: parseFloat(element.leverage),
                        side:
                            parseFloat(element.positionAmt) > 0
                                ? TradeSide.LONG
                                : TradeSide.SHORT,
                        lastPrice: Number(pricesFutures[element.symbol]),
                    });
                });
                break;
            }
        }

        return result;
    }

    async getAccountInfo(marketType: MarketType): Promise<Account> {
        console.log(
            `[Account] ▶ getAccountInfo start | connector=${this.connectorType} | market=${marketType}`,
        );

        // ---------------------------------------------------------------------
        // CLIENT READY
        // ---------------------------------------------------------------------
        await this.client.ensureReady();
        console.log(
            `[Account] ✓ client ready | connector=${this.connectorType}`,
        );

        const api = this.client.api;
        const currency = 'USDT';

        const result: Account = {
            connectorType: this.connectorType,
            marketType,
            assets: [],
            positions: [],
            orders: [],
            symbols: [],
            isActive: false,
        };

        let startIncomeTime = Number(
            moment.utc().subtract(1, 'days').format('x'),
        );
        let endIncomeTime = Number(moment.utc().format('x'));

        try {
            switch (marketType) {
                // =============================================================
                // SPOT
                // =============================================================
                case MarketType.spot: {
                    console.log(
                        `[Account][SPOT] loading prices & balances | connector=${this.connectorType}`,
                    );

                    const pricesSpot = await api.prices();
                    const accountInfo = await api.accountInfo();

                    console.log(
                        `[Account][SPOT] raw balances count=${accountInfo.balances.length}`,
                    );

                    const balances = accountInfo.balances.filter(
                        q => parseFloat(q.free) !== 0 || parseFloat(q.locked) !== 0,
                    );

                    console.log(
                        `[Account][SPOT] non-zero balances count=${balances.length}`,
                    );

                    balances.forEach(element => {
                        const price =
                            element.asset === currency
                                ? 1
                                : Number(pricesSpot[element.asset + currency] ?? 0);

                        result.assets.push({
                            connectorType: this.connectorType,
                            marketType,
                            symbol: { name: element.asset },
                            walletBalance:
                                parseFloat(element.free) +
                                parseFloat(element.locked),
                            availableBalance: parseFloat(element.free),
                            price: [
                                {
                                    currency,
                                    value: price,
                                },
                            ],
                        });
                    });

                    result.dailyProfit = {
                        value: 0,
                        startTime: startIncomeTime,
                        endTime: endIncomeTime,
                        details: [],
                    };

                    break;
                }

                // =============================================================
                // FUTURES
                // =============================================================
                case MarketType.futures: {
                    console.log(
                        `[Account][FUTURES] loading prices & account info | connector=${this.connectorType}`,
                    );

                    const pricesFutures = await api.futuresPrices();
                    const accountInfo = await api.futuresAccountInfo();

                    console.log(
                        `[Account][FUTURES] raw assets=${accountInfo.assets.length}, positions=${accountInfo.positions.length}`,
                    );

                    accountInfo.assets
                        .filter(
                            q =>
                                Number(q.walletBalance) !== 0 ||
                                Number(q.availableBalance) !== 0,
                        )
                        .forEach(element => {
                            const price =
                                element.asset === currency
                                    ? 1
                                    : Number(
                                        pricesFutures[element.asset + currency] ??
                                        0,
                                    );

                            result.assets.push({
                                connectorType: this.connectorType,
                                marketType,
                                symbol: { name: element.asset },
                                walletBalance: parseFloat(element.walletBalance),
                                availableBalance: parseFloat(
                                    element.availableBalance,
                                ),
                                price: [
                                    {
                                        currency,
                                        value: price,
                                    },
                                ],
                            });
                        });

                    console.log(
                        `[Account][FUTURES] assets after filter=${result.assets.length}`,
                    );

                    accountInfo.positions
                        .filter(q => parseFloat(q.positionAmt) !== 0)
                        .forEach(element => {
                            if (!result.symbols.find(s => s.name === element.symbol)) {
                                result.symbols.push({ name: element.symbol });
                            }

                            result.positions.push({
                                connectorType: this.connectorType,
                                marketType,
                                symbol: { name: element.symbol },
                                quantity: parseFloat(element.positionAmt),
                                entryPrice: parseFloat(element.entryPrice),
                                initialMargin: parseFloat(element.initialMargin),
                                leverage: parseFloat(element.leverage),
                                side:
                                    parseFloat(element.positionAmt) > 0
                                        ? TradeSide.LONG
                                        : TradeSide.SHORT,
                                lastPrice: Number(
                                    pricesFutures[element.symbol] ?? 0,
                                ),
                            });
                        });

                    console.log(
                        `[Account][FUTURES] positions=${result.positions.length}, symbols=${result.symbols.length}`,
                    );

                    const futuresIncome: FuturesIncomeResult[] =
                        await api.futuresIncome({
                            startTime: startIncomeTime,
                        });

                    console.log(
                        `[Account][FUTURES] income records=${futuresIncome.length}`,
                    );

                    let income = 0;
                    const details: AccountDailyProfitDetail[] = [];

                    futuresIncome.forEach((el, i) => {
                        if (i === 0)
                            startIncomeTime = Number(
                                moment.utc(el.time).format('x'),
                            );

                        endIncomeTime = Number(moment.utc(el.time).format('x'));
                        income += Number(el.income);

                        details.push({
                            symbol: { name: el.symbol },
                            incomeType: el.incomeType,
                            income: el.income,
                            asset: el.asset,
                            info: el.info,
                            time: el.time,
                        });
                    });

                    result.dailyProfit = {
                        value: income,
                        startTime: startIncomeTime,
                        endTime: endIncomeTime,
                        details,
                    };

                    break;
                }
            }
        } catch (err) {
            console.error(
                `[Account] ❌ getAccountInfo error | connector=${this.connectorType} | market=${marketType}`,
                err,
            );
        }

        // ---------------------------------------------------------------------
        // FINAL STATE
        // ---------------------------------------------------------------------
        if (result.assets.length > 0) {
            result.isActive = true;
        }

        console.log(
            `[Account] ◀ getAccountInfo done | connector=${this.connectorType} | market=${marketType} | assets=${result.assets.length} | positions=${result.positions.length} | active=${result.isActive}`,
        );

        return result;
    }


    async changeLeverage(symbol: Symbol, leverage: number): Promise<Symbol> {
        await this.client.ensureReady();

        const res = await this.client.api.futuresLeverage({
            symbol: symbol.name,
            leverage,
        });

        return {
            name: symbol.name,
            leverage: res.leverage,
        };
    }
}
