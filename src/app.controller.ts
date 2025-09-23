import { Controller, Get } from '@nestjs/common';
import { ConnectorService } from './connector/connector.service';
import { ApiTags } from '@nestjs/swagger';
import { Provider } from '@barfinex/types';

@ApiTags('Options')
@Controller('options')
export class AppController {
    constructor(
        private connectorService: ConnectorService
    ) { }

    @Get()
    async key(): Promise<Provider> {
        const connectors = this.connectorService.getAllConnectors();
        const detectors = this.connectorService.getAllDetectors();
        const accounts = this.connectorService.getAllAccounts();

        const provider: Provider = {
            key: this.connectorService.key,
            restApiUrl: null,
            // restApiToken: process.env.PROVIDER_API_TOKEN,
            // restApiUrl: '',
            // key: null,
            restApiToken: null,


            connectors,
            detectors,
            accounts,

            isAvailable: true,

            studioGuid: '',
            studioName: '',
            studioDescription: '',
            studioSocketApiUrl: '',
        };

        return provider;
    }
}
