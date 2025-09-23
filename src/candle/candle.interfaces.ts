import { Candle, TimeFrame } from '@barfinex/types';
export type RequestMarketData = (from: number, to: number, ticker: string, interval: TimeFrame) => Promise<Candle[]>;