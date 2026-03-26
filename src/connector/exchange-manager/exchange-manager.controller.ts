import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiOkResponse,
  ApiBearerAuth,
  ApiSecurity,
} from '@nestjs/swagger';
import {
  ConnectorType,
  ActivateExchangeDto,
  DeactivateExchangeDto,
  UpdateExchangeCredentialsDto,
} from '@barfinex/types';
import { ExchangeManagerService } from './exchange-manager.service';

@ApiTags('Exchanges')
@ApiBearerAuth('ProviderApiToken')
@ApiSecurity('x-api-token')
@Controller('exchanges')
export class ExchangeManagerController {
  constructor(private readonly manager: ExchangeManagerService) {}

  // ─── Catalog ───

  @Get('catalog')
  @ApiOperation({
    summary: 'Get exchange catalog',
    description:
      'Returns all available exchanges/brokers grouped by market segment. Each entry includes display name, supported markets, and required credentials fields.',
  })
  @ApiOkResponse({ description: 'Grouped exchange catalog' })
  getCatalog() {
    return this.manager.getCatalogGrouped();
  }

  @Get('catalog/flat')
  @ApiOperation({
    summary: 'Get flat exchange catalog',
    description: 'Returns all available exchanges as a flat list (no grouping).',
  })
  @ApiOkResponse({ description: 'Flat exchange catalog' })
  getCatalogFlat() {
    return this.manager.getCatalog();
  }

  // ─── Active instances ───

  @Get('active')
  @ApiOperation({
    summary: 'Get active exchange instances',
    description:
      'Returns all currently active exchange connector instances with their status, subscription count, and instrument count.',
  })
  @ApiOkResponse({ description: 'List of active exchange instances' })
  getActiveInstances() {
    return this.manager.getActiveInstances();
  }

  @Get('active/:connectorType/:marketType')
  @ApiOperation({
    summary: 'Get single exchange instance',
    description: 'Returns status of a specific exchange connector instance.',
  })
  @ApiParam({ name: 'connectorType', description: 'Connector type (e.g., binance, kraken)' })
  @ApiParam({ name: 'marketType', description: 'Market type (spot, futures, margin)' })
  @ApiOkResponse({ description: 'Exchange instance details or null' })
  getInstance(
    @Param('connectorType') connectorType: ConnectorType,
    @Param('marketType') marketType: string,
  ) {
    return this.manager.getInstance(connectorType, marketType as any);
  }

  // ─── Activate / Deactivate ───

  @Post('activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Activate exchange connector',
    description:
      'Starts a new exchange connector instance for the specified markets. Credentials can be provided in the same request or set beforehand.',
  })
  @ApiBody({
    description: 'Activation parameters',
    schema: {
      type: 'object',
      required: ['connectorType', 'marketTypes'],
      properties: {
        connectorType: { type: 'string', example: 'kraken' },
        marketTypes: {
          type: 'array',
          items: { type: 'string' },
          example: ['spot', 'futures'],
        },
        credentials: {
          type: 'object',
          additionalProperties: { type: 'string' },
          example: { apiKey: '...', apiSecret: '...' },
        },
      },
    },
  })
  @ApiOkResponse({ description: 'List of activated instances' })
  async activate(@Body() dto: ActivateExchangeDto) {
    return this.manager.activate(dto);
  }

  @Post('deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate exchange connector',
    description:
      'Stops exchange connector instances. If marketTypes omitted, stops all markets for the connector.',
  })
  @ApiBody({
    description: 'Deactivation parameters',
    schema: {
      type: 'object',
      required: ['connectorType'],
      properties: {
        connectorType: { type: 'string', example: 'kraken' },
        marketTypes: {
          type: 'array',
          items: { type: 'string' },
          example: ['spot'],
        },
      },
    },
  })
  @ApiOkResponse({ description: 'Deactivation complete' })
  async deactivate(@Body() dto: DeactivateExchangeDto) {
    await this.manager.deactivate(dto);
    return { success: true };
  }

  // ─── Credentials ───

  @Put(':connectorType/credentials')
  @ApiOperation({
    summary: 'Set or update exchange credentials',
    description:
      'Stores API keys / secrets for a given connector type. Credentials are held in-memory (not persisted to disk). If the connector is already active, it will use the new credentials on next reconnect.',
  })
  @ApiParam({ name: 'connectorType', description: 'Connector type' })
  @ApiBody({
    description: 'Credentials key-value map',
    schema: {
      type: 'object',
      required: ['credentials'],
      properties: {
        credentials: {
          type: 'object',
          additionalProperties: { type: 'string' },
          example: { apiKey: '...', apiSecret: '...' },
        },
      },
    },
  })
  @ApiOkResponse({ description: 'Credentials updated' })
  setCredentials(
    @Param('connectorType') connectorType: ConnectorType,
    @Body() dto: UpdateExchangeCredentialsDto,
  ) {
    this.manager.setCredentials(connectorType, dto.credentials);
    return { success: true, connectorType };
  }

  @Delete(':connectorType/credentials')
  @ApiOperation({
    summary: 'Remove exchange credentials',
    description:
      'Deletes stored credentials for a connector type. Active instances will be deactivated.',
  })
  @ApiParam({ name: 'connectorType', description: 'Connector type' })
  @ApiOkResponse({ description: 'Credentials removed' })
  async removeCredentials(@Param('connectorType') connectorType: ConnectorType) {
    await this.manager.deactivate({ connectorType });
    this.manager.setCredentials(connectorType, {});
    return { success: true, connectorType };
  }
}
