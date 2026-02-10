import { Injectable } from '@nestjs/common';
import {
    ConnectorType,
    MarketType,
    Symbol,
    TimeFrame,
} from '@barfinex/types';

// import {
//     AlpacaService,
//     TinkoffService,
//     TestnetBinanceFuturesService,
// } from './datasource';
import { BinanceService } from './datasource/binance/binance.service';


@Injectable()
export class ConnectorSubscriptionService {
    constructor(
        private readonly binanceService: BinanceService,
        // private readonly alpacaService: AlpacaService,
        // private readonly tinkoffService: TinkoffService,
        // private readonly testnetBinanceFuturesService: TestnetBinanceFuturesService,
    ) { }

    // =========================================================================
    // 🔹 SUBSCRIBE
    // =========================================================================

    async subscribeCollection(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbols: Symbol[],
        intervals: TimeFrame[],
    ): Promise<any> {
        console.log('subscribeCollection');

        switch (connectorType) {
            case ConnectorType.binance:
                await this.binanceService.subscribe(
                    marketType,
                    symbols,
                    intervals,
                );
                break;

            case ConnectorType.alpaca:
                break;

            case ConnectorType.tinkoff:
                break;

            // case ConnectorType.testnetBinanceFutures:
            //     return await this.testnetBinanceFuturesService.subscribe(marketType, symbols, intervals);
            //     break;
        }
    }

    // =========================================================================
    // 🔹 UNSUBSCRIBE
    // =========================================================================

    async unsubscribeCollection(
        connectorType: ConnectorType,
    ): Promise<any> {
        switch (connectorType) {
            case ConnectorType.binance:
                await this.binanceService.unsubscribe();
                break;

            case ConnectorType.alpaca:
                break;

            case ConnectorType.tinkoff:
                break;

            // case ConnectorType.testnetBinanceFutures:
            //     return await this.testnetBinanceFuturesService.unsubscribe();
            //     break;
        }
    }

    // =========================================================================
    // 🔹 UPDATE SUBSCRIPTIONS
    // =========================================================================

    async updateSubscribeCollection(
        connectorType: ConnectorType,
        marketType: MarketType,
        symbols: Symbol[],
        intervals?: TimeFrame[],
    ): Promise<void> {
        switch (connectorType) {
            case ConnectorType.binance:
                await this.binanceService.updateSubscribeCollection(
                    marketType,
                    symbols,
                    intervals,
                );
                break;

            // case ConnectorType.testnetBinanceFutures:
            //     await this.testnetBinanceFuturesService.updateSubscribeCollection(marketType, symbols, intervals);
            //     break;

            case ConnectorType.alpaca:
                break;

            case ConnectorType.tinkoff:
                break;
        }
    }
}
