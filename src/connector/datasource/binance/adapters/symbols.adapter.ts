import { MarketType, TradingSymbol } from '@barfinex/types';

export function createSymbolsAdapter(deps: {
  context: any;
  marketType: MarketType;
  handler: (marketType: MarketType, symbols: TradingSymbol[]) => Promise<void>;
}) {
  const { context, marketType, handler } = deps;

  return async (rawSymbols: any[]): Promise<void> => {
    if (!Array.isArray(rawSymbols)) {
      context.logger.warn(
        `SymbolsAdapter received invalid data: ${JSON.stringify(rawSymbols)}`,
      );
      return;
    }

    const symbols: TradingSymbol[] = rawSymbols.map((s) => ({
      name: s.symbol ?? s.s ?? s.name,
      baseAsset: s.baseAsset ?? s.base ?? undefined,
      quoteAsset: s.quoteAsset ?? s.quote ?? undefined,
      status: s.status ?? undefined,
      minPrice: s.filters?.find(
        (f: { filterType: string }) => f.filterType === 'PRICE_FILTER',
      )?.minPrice,
      maxPrice: s.filters?.find(
        (f: { filterType: string }) => f.filterType === 'PRICE_FILTER',
      )?.maxPrice,
      tickSize: s.filters?.find(
        (f: { filterType: string }) => f.filterType === 'PRICE_FILTER',
      )?.tickSize,
      minQuantity: s.filters?.find(
        (f: { filterType: string }) => f.filterType === 'LOT_SIZE',
      )?.minQty,
      stepSize: s.filters?.find(
        (f: { filterType: string }) => f.filterType === 'LOT_SIZE',
      )?.stepSize,
      isSpotTradingAllowed: s.isSpotTradingAllowed ?? undefined,
      isMarginTradingAllowed: s.isMarginTradingAllowed ?? undefined,
      connectorType: context.connectorType,
      marketType,
    }));

    await handler.call(context, marketType, symbols);
  };
}
