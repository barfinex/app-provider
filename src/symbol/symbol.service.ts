import { Injectable } from '@nestjs/common';
import {
    Symbol,
    ConnectorType,
    MarketType
} from '@barfinex/types';
import { ConnectorService } from '../connector/connector.service';


@Injectable()
export class SymbolService {

    constructor(private readonly connectorService: ConnectorService) { }

    async getAllSymbols(connectorType: ConnectorType, marketType: MarketType): Promise<Symbol[]> {
        return this.connectorService.getSymbolsInfo(connectorType, marketType)
    }
}
