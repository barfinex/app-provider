export type EventCategory =
    | 'candle'
    | 'order'
    | 'orderbook'
    | 'trade'
    | 'connector'
    | 'detector'
    | 'analytics'
    | 'inspector'
    | 'system'
    | 'symbol'
    | 'error';

export interface EventSinkPayload<T = any> {
    category: EventCategory;
    action: string;          // save / update / signal / depth / error / etc
    symbol?: string;
    connectorType?: string;
    marketType?: string;
    timestamp?: number;
    data: T;
}
