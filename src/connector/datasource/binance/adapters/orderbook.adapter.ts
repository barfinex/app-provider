import {
    BidDepth as BinanceBidDepth,
    Depth as BinanceDepth,
} from 'binance-api-node';
import {
    MarketType,
    OrderBookHandler,
    DepthOrder,
    Symbol,
} from '@barfinex/types';

export function createOrderBookAdapter(context: any) {
    return function orderBookAdapter(
        marketType: MarketType,
        handler: OrderBookHandler,
    ) {
        const self = context;

        function migrateData(
            value: BinanceBidDepth,
            result: DepthOrder[],
        ) {
            const price = parseFloat(value.price);
            const qty = parseFloat(value.quantity);
            if (qty !== 0) result.push({ price, volume: qty });
        }

        return (msg: BinanceDepth) => {
            const bids: DepthOrder[] = [];
            const asks: DepthOrder[] = [];
            const symbol: Symbol = { name: msg.symbol };
            const time = msg.eventTime;

            msg.bidDepth.forEach((item) => migrateData(item, bids));
            msg.askDepth.forEach((item) => migrateData(item, asks));

            handler.call(
                self,
                marketType,
                { bids, asks, symbol, time },
            );
        };
    };
}
