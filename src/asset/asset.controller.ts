import { Controller, Get, Inject, Param } from '@nestjs/common';
import { Asset, Position, MarketType, ConnectorType } from '@barfinex/types';
import { AssetService } from './asset.service';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiOkResponse,
} from '@nestjs/swagger';
import { ConnectorService } from '../connector/connector.service';

@ApiTags('Assets')
@Controller('assets')
export class AssetController {
  // @Inject(ConnectorService)
  // private readonly connectorService: ConnectorService

  constructor(private assetSecvice: AssetService) {}

  @Get(':connectorType/:marketType')
  @ApiOperation({
    summary: 'Get assets and positions',
    description:
      'Returns assets and positions for the given connector type and market type. Used for account/portfolio views.',
  })
  @ApiParam({
    name: 'connectorType',
    example: 'BINANCE',
    description: 'Connector type',
  })
  @ApiParam({
    name: 'marketType',
    example: 'FUTURES',
    description: 'Market type',
  })
  @ApiOkResponse({ description: '{ assets: Asset[], positions: Position[] }' })
  async getAssetInfo(
    @Param('connectorType') connectorType: ConnectorType,
    @Param('marketType') marketType: MarketType,
  ): Promise<{ assets: Asset[]; positions: Position[] }> {
    // const connector = await this.connectorService.get(connectorType, marketType)
    return await this.assetSecvice.getAllAsset(connectorType, marketType);
  }

  // @Get()
  // async all() {
  //     return this.symbolsecvice.getAll();
  // }
}
