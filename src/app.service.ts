import { Injectable } from '@nestjs/common';
import { ConfigService } from '@barfinex/config';

@Injectable()
export class AppService {
    constructor(
        //private readonly configService: ConfigService

    ) { }
    // getInspectorApiPort(): number {
    //   return this.configService.getConfig().inspector.general.apiPort;
    // }
    // getDetectorApiPort(): number {
    //   return this.configService.getConfig().detector.general.apiPort;
    // }
    // getProviderApiToken(): string {
    //   return this.configService.getConfig().provider.restApiToken;
    // }
}