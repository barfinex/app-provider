import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ConnectorType,
  MarketType,
  Instrument,
  TimeFrame,
  Detector,
} from '@barfinex/types';
import { ConnectorService } from './connector.service';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiOkResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';

@ApiTags('Connectors')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('connectors')
export class ConnectorController {
  constructor(private connectorService: ConnectorService) {}

  @Get(':connectorType/:marketType')
  @ApiOperation({
    summary: 'Get connector by type and market',
    description:
      'Returns connector config and state for the given connector type and market type.',
  })
  @ApiParam({
    name: 'connectorType',
    example: 'BINANCE',
    description: 'Connector type',
  })
  @ApiParam({
    name: 'marketType',
    example: 'SPOT',
    description: 'Market type (SPOT, FUTURES)',
  })
  @ApiOkResponse({ description: 'Connector object' })
  async get(
    @Param('connectorType') connectorType: ConnectorType,
    @Param('marketType') marketType: MarketType,
  ) {
    return this.connectorService.get({ connectorType, marketType });
  }

  @Get()
  @ApiOperation({
    summary: 'List all connectors',
    description: 'Returns list of all connectors for this Provider.',
  })
  @ApiOkResponse({ description: 'List of connectors' })
  async getAll(@Query() query: Record<string, unknown>): Promise<unknown> {
    return this.connectorService.getConnectorsList();
  }

  @Get('availability')
  @ApiOperation({
    summary: 'Connector availability and detectors',
    description:
      'Returns endpoint availability and list of detectors registered with the Provider.',
  })
  @ApiOkResponse({ description: '{ endpoint: true, detectors: Detector[] }' })
  async availability(): Promise<{ endpoint: boolean; detectors: Detector[] }> {
    return {
      endpoint: true,
      detectors: await this.connectorService.getAllDetectors(),
    };
  }

  @Post()
  @ApiOperation({
    summary: 'Create message',
    description: 'Creates a message (content in body).',
  })
  @ApiBody({ description: 'content (string)' })
  @ApiOkResponse({ description: 'Created message' })
  async createMessage(@Body('content') content: string) {
    const newMessage = await this.connectorService.createMessage(content);
    return newMessage;
  }

  @Post('subscribes/update')
  @ApiOperation({
    summary: 'Update subscribe collection',
    description:
      'Updates symbol/interval subscription for a connector and market. Body: connectorType, marketType, symbols[], intervals[].',
  })
  @ApiBody({
    description:
      'connectorType, marketType, instruments (Instrument[]), intervals (TimeFrame[])',
    schema: {
      type: 'object',
      required: ['connectorType', 'marketType', 'symbols', 'intervals'],
      properties: {
        connectorType: { type: 'string', example: 'BINANCE' },
        marketType: { type: 'string', example: 'SPOT' },
        symbols: { type: 'array', items: { type: 'object' } },
        intervals: { type: 'array', items: { type: 'string' } },
      },
    },
  })
  @ApiOkResponse({ description: 'Update completed' })
  async updateSubscribes(
    @Body('content')
    content: {
      connectorType: ConnectorType;
      marketType: MarketType;
      instruments: Instrument[];
      intervals: TimeFrame[];
    },
  ) {
    const { connectorType, marketType, instruments, intervals } = content;
    await this.connectorService.updateSubscribeCollection(
      connectorType,
      marketType,
      instruments,
      intervals,
    );
  }
}
