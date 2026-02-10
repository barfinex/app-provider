import { AggregatedTrade as BinanceAggregatedTrade } from 'binance-api-node';
import { MarketType, TradeHandler, TradeSide } from '@barfinex/types';

export function createTradeAdapter(context: any) {
    return function tradeAdapter(
        marketType: MarketType,
        handler: TradeHandler,
    ) {
        return (msg: BinanceAggregatedTrade) => {
            handler.call(
                context,
                marketType,
                {
                    symbol: { name: msg.symbol },
                    side: msg.isBuyerMaker ? TradeSide.SHORT : TradeSide.LONG,
                    price: parseFloat(msg.price),
                    volume: parseFloat(msg.quantity),
                    time: msg.timestamp,
                },
            );
        };
    };
}
