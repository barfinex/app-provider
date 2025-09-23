import { Controller, Get, Inject, Param } from '@nestjs/common';
import { Asset, Position, MarketType, ConnectorType } from '@barfinex/types';
import { AssetService, } from './asset.service';
import { ApiTags } from '@nestjs/swagger';
import { ConnectorService } from '../connector/connector.service';

@ApiTags('Assets')
@Controller('assets')
export class AssetController {

    // @Inject(ConnectorService)
    // private readonly connectorService: ConnectorService

    constructor(private assetSecvice: AssetService) { }

    @Get(':connectorType/:marketType')
    async getAssetInfo(@Param('connectorType') connectorType: ConnectorType, @Param('marketType') marketType: MarketType): Promise<{ assets: Asset[], positions: Position[] }> {
        // const connector = await this.connectorService.get(connectorType, marketType)
        return await this.assetSecvice.getAllAsset(connectorType, marketType);
    }

    // @Get()
    // async all() {
    //     return this.symbolsecvice.getAll();
    // }


}
