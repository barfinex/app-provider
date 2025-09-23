import { Inject, Injectable } from '@nestjs/common';
import {
    Asset,
    ConnectorType,
    MarketType,
    Position,
    Connector,
} from '@barfinex/types';
import { AccountService } from '../account/account.service';
import { ConnectorService } from '../connector/connector.service';

@Injectable()
export class AssetService {

    private readonly DAY = 86400000;


    // @Inject(ConnectorService)
    // private readonly connectorService: ConnectorService

    // @Inject(AccountService)
    // private readonly accountService: AccountService

    constructor(
        private readonly accountService: AccountService,
        private readonly connectorService: ConnectorService
        // @InjectModel(OrderEntity.name) private readonly orderEntity: Model<OrderEntityDocument>,
    ) { }


    // async getConnector(connectorType: ConnectorType, marketType: MarketType): Promise<Connector> {

    //     return await this.connectorService.get(connectorType, marketType)
    // }

    async getAllAsset(connectorType: ConnectorType, marketType: MarketType): Promise<any> {
        const connector = await this.connectorService.get({ connectorType, marketType })
        return await this.accountService.getAssetsInfo(connector)
    }

    async getAll(): Promise<string[]> {

        const result = [];

        const connectorTypes = Object.keys(ConnectorType);
        const marketTypes = Object.keys(MarketType);


        for (let i = 0; i < connectorTypes.length; i++) {
            const connectorType = connectorTypes[i];

            for (let j = 0; j < marketTypes.length; j++) {
                const marketType = marketTypes[j];

                //const details = await this.getAllAsset(ConnectorType[connectorType], MarketType[marketType])

                result.push({
                    connectorType,
                    marketType,
                    //details
                });

            }

        }

        // connectorTypes.forEach(connector => {

        //     marketTypes.forEach(market => {



        //     });
        // });
        return result.filter(q => q.details.totals.symbolsCost.USD.current != 0);
    }

}
