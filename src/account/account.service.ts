import { Inject, Injectable, forwardRef } from '@nestjs/common';
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

@Injectable()
export class AccountService {

    private readonly DAY = 86400000;


    // @Inject(ConnectorService)
    // private readonly connectorService: ConnectorService

    constructor(
        // @InjectModel(OrderEntity.name) private readonly orderEntity: Model<OrderEntityDocument>,
        // private detectorService: DetectorService
        @Inject(forwardRef(() => ConnectorService))
        private readonly connectorService: ConnectorService
    ) { }




    async getAccountInfo(connectorType: ConnectorType, marketType: MarketType): Promise<Account> {

        let account: Account = {
            connectorType,
            marketType,
            assets: [],
            positions: [],
            orders: [],
            symbols: [],
            isActive: false
        }

        account = await this.connectorService.getAccountInfo(connectorType, marketType)

        //console.log('>>>>>account:', account);

        if (account && account.isActive) {

            let orders: Order[] = await this.connectorService.getAllOpenOrders({ connectorType, marketType })
            if (orders && orders.length > 0) account.orders = orders
        }

        return account
    }


    async changeLeverage(connectorType: ConnectorType, symbol: Symbol, newLeverage: number): Promise<Symbol> {

        return await this.connectorService.changeLeverage(connectorType, symbol, newLeverage)
    }



    async getAssetsInfo(options: Connector): Promise<any> {

        let result: { assets: Asset[], positions: Position[] } = {
            assets: [],
            positions: []
        }

        const promises = options.markets.map(async (market) => {
            const assetsInfo = await this.connectorService.getAssetsInfo(options.connectorType, market.marketType);
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

        return result
    }


    async getAll(): Promise<Account[]> {

        const accounts = [];

        const connectorTypes = Object.keys(ConnectorType);
        const marketTypes = Object.keys(MarketType);

        for (let i = 0; i < connectorTypes.length; i++) {
            const connectorType = ConnectorType[connectorTypes[i]];

            for (let j = 0; j < marketTypes.length; j++) {
                const marketType = MarketType[marketTypes[j]];

                const account = await this.getAccountInfo(connectorType, marketType)

                // if (account.marketType != MarketType.margin) console.log('account:', account);

                if (account && account.isActive) accounts.push(account);
            }
        }

        ConnectorService.setAccounts(accounts)

        return accounts;
    }

}
