import { Controller, Get, Param } from '@nestjs/common';
import { Instrument, MarketType, ConnectorType } from '@barfinex/types';
import { InstrumentService } from './instrument.service';
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
export class InstrumentController {
  constructor(private instrumentService: InstrumentService) {}

  @Get(':connectorType/:marketType')
  @ApiOperation({
    summary: 'Get symbols by connector and market',
    description:
      'Returns all trading symbols for the given connector type and market type.',
  })
  @ApiParam({ name: 'connectorType', example: 'BINANCE' })
  @ApiParam({ name: 'marketType', example: 'SPOT' })
  @ApiOkResponse({ description: 'List of Symbol' })
  async getInstrumentInfo(
    @Param('connectorType') connectorType: ConnectorType,
    @Param('marketType') marketType: MarketType,
  ): Promise<Instrument[]> {
    return await this.instrumentService.getAllSymbols(connectorType, marketType);
  }
}
