import { AggregatedTrade as BinanceAggregatedTrade } from 'binance-api-node';
import { MarketType, TradeHandler, TradeSide } from '@barfinex/types';

export function createTradeAdapter(context: any) {
  return function tradeAdapter(marketType: MarketType, handler: TradeHandler) {
    return (msg: BinanceAggregatedTrade) => {
      const tradeId =
        (msg as any).lastTradeId != null
          ? String((msg as any).lastTradeId)
          : (msg as any).firstTradeId != null
          ? String((msg as any).firstTradeId)
          : undefined;
      handler.call(context, marketType, {
        symbol: { name: msg.symbol },
        side: msg.isBuyerMaker ? TradeSide.SHORT : TradeSide.LONG,
        price: parseFloat(msg.price),
        volume: parseFloat(msg.quantity),
        time: msg.timestamp,
        tradeId,
        isBuyerMaker: msg.isBuyerMaker,
      });
    };
  };
}
