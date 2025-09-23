import { ConnectorType, MarketType } from '@barfinex/types';

/**
 * Генерирует уникальный ключ для коннектора из типа и рынка.
 * Например: makeConnectorKey('binance', 'spot') → 'binance-spot'
 */
export function makeConnectorKey(connectorType: ConnectorType, marketType: MarketType): string {
    return `${connectorType}-${marketType}`;
}
