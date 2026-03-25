import { Controller, Get, InternalServerErrorException } from '@nestjs/common';
import { ConnectorService } from './connector/connector.service';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { Provider } from '@barfinex/types';

@ApiTags('Options')
@Controller('options')
export class AppController {
  constructor(private readonly connectorService: ConnectorService) {}

  @Get()
  @ApiOperation({
    summary: 'Get provider options',
    description:
      'Returns the current Provider key, connectors, detectors, accounts, and availability. Used by Studio and clients to discover Provider config.',
  })
  @ApiOkResponse({
    description:
      'Provider object (key, connectors, detectors, accounts, isAvailable, studioGuid, etc.)',
  })
  async key(): Promise<Provider> {
    const key = this.connectorService.key;

    if (!key) {
      throw new InternalServerErrorException(
        'Provider key not initialized yet',
      );
    }

    const connectors = this.connectorService.getAllConnectors();
    const detectors = this.connectorService.getAllDetectors();
    const accounts = this.connectorService.getAllAccounts();

    const provider: Provider = {
      key,
      connectors,
      detectors,
      accounts,
      isAvailable: true,
      studioGuid: '',
      studioName: '',
      studioDescription: '',
      studioSocketApiUrl: '',
      apiToken: '',
      restApiUrl: '',
    };

    return provider;
  }
}
