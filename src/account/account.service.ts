import { Inject, Injectable, OnModuleInit, forwardRef } from '@nestjs/common';
import {
  Account,
  ConnectorType,
  MarketType,
  Asset,
  Position,
  Connector,
  Order,
  TradingSymbol,
} from '@barfinex/types';
import { ConnectorService } from '../connector/connector.service';
import { BinanceClientService } from '../connector/datasource/binance/core/binance.client';
import { normalizeTradingSymbol } from '../connector/utils/trading-symbol-sanitizer';

interface BalanceStatsSnapshot {
  rawAssetsCount: number;
  activeAssetsCount: number;
}

@Injectable()
export class AccountService {
  private readyResolver!: () => void;
  private ready = new Promise<void>((resolve) => {
    this.readyResolver = resolve;
  });

  private readonly DAY = 86400000;
  private readonly balanceStats = new Map<string, BalanceStatsSnapshot>();

  constructor(
    @Inject(forwardRef(() => ConnectorService))
    private readonly connectorService: ConnectorService,
    private readonly binanceClient: BinanceClientService,
  ) {}

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
      const orders: Order[] = await this.connectorService.getAllOpenOrders({
        connectorType,
        marketType,
      });

      if (orders?.length) {
        account.orders = orders;
      }
    }

    const accountAny = account as unknown as Record<string, unknown>;
    const rawAssetsCount = Number(
      accountAny.__rawAssetsCount ??
        accountAny.__rawSpotBalancesCount ??
        accountAny.__rawFuturesAssetsCount ??
        account.assets?.length ??
        0,
    );
    const activeAssetsCount = Number(
      accountAny.__activeAssetsCount ??
        accountAny.__nonZeroSpotBalancesCount ??
        accountAny.__nonZeroFuturesAssetsCount ??
        account.assets?.length ??
        0,
    );
    this.balanceStats.set(`${connectorType}:${marketType}`, {
      rawAssetsCount: Number.isFinite(rawAssetsCount) ? rawAssetsCount : 0,
      activeAssetsCount: Number.isFinite(activeAssetsCount)
        ? activeAssetsCount
        : 0,
    });

    // =========================================================================
    // 🔥 ВАЖНО: ЗАПОЛНЯЕМ SYMBOLS (утраченная логика)
    // =========================================================================

    const symbolsMap = new Map<string, TradingSymbol>();

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

    // 2️⃣ Из активов: только если это уже валидная торговая пара Binance.
    const candidateAssetSymbols = (account.assets ?? [])
      .map((asset) => normalizeTradingSymbol(asset.symbol?.name))
      .filter(Boolean);
    const { validSymbols: validAssetSymbols } =
      this.binanceClient.validateBinanceSymbols(
        marketType,
        candidateAssetSymbols,
      );
    validAssetSymbols.forEach((symbolName) => {
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

  getBalanceStats(
    connectorType: ConnectorType,
    marketType: MarketType,
  ): BalanceStatsSnapshot | undefined {
    return this.balanceStats.get(`${connectorType}:${marketType}`);
  }

  // =========================================================================
  // 🔹 LEVERAGE
  // =========================================================================

  async changeLeverage(
    connectorType: ConnectorType,
    symbol: TradingSymbol,
    newLeverage: number,
  ): Promise<TradingSymbol> {
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
      const assetsInfo = await this.connectorService.getAssetsInfo(
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

        const account = await this.getAccountInfo(connectorType, marketType);

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
