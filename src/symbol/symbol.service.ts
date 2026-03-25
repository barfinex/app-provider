import { Injectable } from '@nestjs/common';
import { TradingSymbol, ConnectorType, MarketType } from '@barfinex/types';
import { ConnectorService } from '../connector/connector.service';

@Injectable()
export class SymbolService {
  constructor(private readonly connectorService: ConnectorService) {}

  async getAllSymbols(
    connectorType: ConnectorType,
    marketType: MarketType,
  ): Promise<TradingSymbol[]> {
    return this.connectorService.getSymbolsInfo(connectorType, marketType);
  }
}
