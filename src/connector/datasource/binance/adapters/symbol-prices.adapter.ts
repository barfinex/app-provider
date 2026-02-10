import { MarketType, SymbolPrice } from '@barfinex/types';

export function createSymbolPricesAdapter(context: any) {
    return function symbolPricesAdapter(
        marketType: MarketType,
        handler: (marketType: MarketType, symbolPrice: SymbolPrice) => void,
    ) {
        return (msg: any) => {
            const data: SymbolPrice = msg.data ?? msg;

            if (!data || !data.s || !data.c) {
                context.logger.warn(
                    `Invalid symbol price message received: ${JSON.stringify(msg)}`,
                );
                return;
            }

            handler.call(context, marketType, data);
        };
    };
}
