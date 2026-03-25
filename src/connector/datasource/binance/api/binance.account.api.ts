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
  TradingSymbol,
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
  private readonly accountPayloadLogThrottleMs = Math.max(
    1_000,
    Number(process.env.ACCOUNT_PAYLOAD_LOG_THROTTLE_MS || 5_000),
  );
  private lastFuturesPayloadLogAt = 0;

  constructor(
    private readonly client: BinanceClientService,
    private readonly configService: ConfigService,
  ) {}

  private toFiniteNumber(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  private filterActiveFuturesPositions<
    T extends { positionAmt?: string | number },
  >(positions: T[]): T[] {
    return positions.filter(
      (position) => Math.abs(this.toFiniteNumber(position.positionAmt)) > 0,
    );
  }

  private filterActiveFuturesAssets<
    T extends {
      walletBalance?: string | number;
      availableBalance?: string | number;
      crossWalletBalance?: string | number;
    },
  >(assets: T[]): T[] {
    return assets.filter((asset) => {
      const walletBalance = this.toFiniteNumber(asset.walletBalance);
      const availableBalance = this.toFiniteNumber(asset.availableBalance);
      const crossWalletBalance = this.toFiniteNumber(asset.crossWalletBalance);
      return (
        Math.abs(walletBalance) > 0 ||
        Math.abs(availableBalance) > 0 ||
        Math.abs(crossWalletBalance) > 0
      );
    });
  }

  private logAccountPayloadSnapshot(
    marketType: MarketType,
    rawPositions: number,
    activePositions: number,
    rawAssets: number,
    activeAssets: number,
  ): void {
    const now = Date.now();
    if (now - this.lastFuturesPayloadLogAt < this.accountPayloadLogThrottleMs)
      return;
    this.lastFuturesPayloadLogAt = now;
    console.log(
      `[AccountPayload] market=${marketType} raw_positions=${rawPositions} active_positions=${activePositions} raw_assets=${rawAssets} active_assets=${activeAssets}`,
    );
  }

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
          (q) => parseFloat(q.free) !== 0 || parseFloat(q.locked),
        );

        accountInfoSpot.forEach((element) => {
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

        const assets = this.filterActiveFuturesAssets(
          accountInfoFutures.assets,
        );

        assets.forEach((element) => {
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

        const positions = this.filterActiveFuturesPositions(
          accountInfoFutures.positions,
        );

        positions.forEach((element) => {
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
        this.logAccountPayloadSnapshot(
          marketType,
          accountInfoFutures.positions.length,
          positions.length,
          accountInfoFutures.assets.length,
          assets.length,
        );
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
    console.log(`[Account] ✓ client ready | connector=${this.connectorType}`);

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
    const resultMeta = result as unknown as Record<string, unknown>;

    let startIncomeTime = Number(moment.utc().subtract(1, 'days').format('x'));
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
            (q) => parseFloat(q.free) !== 0 || parseFloat(q.locked) !== 0,
          );

          console.log(
            `[Account][SPOT] non-zero balances count=${balances.length}`,
          );
          resultMeta.__rawSpotBalancesCount = accountInfo.balances.length;
          resultMeta.__nonZeroSpotBalancesCount = balances.length;
          resultMeta.__rawAssetsCount = accountInfo.balances.length;
          resultMeta.__activeAssetsCount = balances.length;

          balances.forEach((element) => {
            const price =
              element.asset === currency
                ? 1
                : Number(pricesSpot[element.asset + currency] ?? 0);

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

          const activeAssets = this.filterActiveFuturesAssets(
            accountInfo.assets,
          );
          activeAssets.forEach((element) => {
            const price =
              element.asset === currency
                ? 1
                : Number(pricesFutures[element.asset + currency] ?? 0);

            result.assets.push({
              connectorType: this.connectorType,
              marketType,
              symbol: { name: element.asset },
              walletBalance: parseFloat(element.walletBalance),
              availableBalance: parseFloat(element.availableBalance),
              price: [
                {
                  currency,
                  value: price,
                },
              ],
            });
          });
          resultMeta.__rawFuturesAssetsCount = accountInfo.assets.length;
          resultMeta.__nonZeroFuturesAssetsCount = result.assets.length;
          resultMeta.__rawAssetsCount = accountInfo.assets.length;
          resultMeta.__activeAssetsCount = result.assets.length;

          console.log(
            `[Account][FUTURES] assets after filter=${result.assets.length}`,
          );

          const activePositions = this.filterActiveFuturesPositions(
            accountInfo.positions,
          );
          activePositions.forEach((element) => {
            if (!result.symbols.find((s) => s.name === element.symbol)) {
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
              lastPrice: Number(pricesFutures[element.symbol] ?? 0),
            });
          });
          this.logAccountPayloadSnapshot(
            marketType,
            accountInfo.positions.length,
            activePositions.length,
            accountInfo.assets.length,
            activeAssets.length,
          );

          console.log(
            `[Account][FUTURES] positions=${result.positions.length}, symbols=${result.symbols.length}`,
          );

          const futuresIncome: FuturesIncomeResult[] = await api.futuresIncome({
            startTime: startIncomeTime,
          });

          console.log(
            `[Account][FUTURES] income records=${futuresIncome.length}`,
          );

          let income = 0;
          const details: AccountDailyProfitDetail[] = [];

          futuresIncome.forEach((el, i) => {
            if (i === 0)
              startIncomeTime = Number(moment.utc(el.time).format('x'));

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

  async changeLeverage(symbol: TradingSymbol, leverage: number): Promise<TradingSymbol> {
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
