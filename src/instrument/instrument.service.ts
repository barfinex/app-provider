import { Injectable } from '@nestjs/common';
import { Instrument, ConnectorType, MarketType } from '@barfinex/types';
import { ConnectorService } from '../connector/connector.service';

@Injectable()
export class InstrumentService {
  constructor(private readonly connectorService: ConnectorService) {}

  async getAllSymbols(
    connectorType: ConnectorType,
    marketType: MarketType,
  ): Promise<Instrument[]> {
    return this.connectorService.getInstrumentsInfo(connectorType, marketType);
  }
}
