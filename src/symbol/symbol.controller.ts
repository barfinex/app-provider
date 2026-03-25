import { Controller, Get, Param } from '@nestjs/common';
import { TradingSymbol, MarketType, ConnectorType } from '@barfinex/types';
import { SymbolService } from './symbol.service';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiOkResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';

@ApiTags('Symbols')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('symbols')
export class SymbolController {
  constructor(private symbolSecvice: SymbolService) {}

  @Get(':connectorType/:marketType')
  @ApiOperation({
    summary: 'Get symbols by connector and market',
    description:
      'Returns all trading symbols for the given connector type and market type.',
  })
  @ApiParam({ name: 'connectorType', example: 'BINANCE' })
  @ApiParam({ name: 'marketType', example: 'SPOT' })
  @ApiOkResponse({ description: 'List of Symbol' })
  async getSymbolInfo(
    @Param('connectorType') connectorType: ConnectorType,
    @Param('marketType') marketType: MarketType,
  ): Promise<TradingSymbol[]> {
    return await this.symbolSecvice.getAllSymbols(connectorType, marketType);
  }
}
