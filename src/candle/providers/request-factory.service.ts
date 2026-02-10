import { Injectable } from '@nestjs/common';
import { TimeFrame, MarketType, ConnectorType, Candle } from '@barfinex/types';
import { createRequestBinance, requestAlpaca } from '@barfinex/connectors';
import { AppError, ErrorEnvironment } from '../../error';

@Injectable()
export class RequestFactoryService {
    create(connectorType: ConnectorType, marketType: MarketType) {
        switch (connectorType) {
            case 'binance':
                return async (from: number, to: number, symbol: string, tf: TimeFrame) =>
                    createRequestBinance(marketType)(from, to, symbol, tf);

            case 'alpaca':
                return async (from: number, to: number, symbol: string, tf: TimeFrame) =>
                    requestAlpaca(from, to, symbol, tf);

            default:
                throw new AppError(
                    ErrorEnvironment.History,
                    `Unsupported connectorType: ${connectorType}`,
                );
        }
    }
}
