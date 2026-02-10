import { Injectable } from '@nestjs/common';
import { EventSinkRepository } from '../event-sink/event-sink.repository';

/**
 * Level in the order book
 */
export interface OrderBookLevel {
    price: number;
    volume: number;
}

/**
 * Full snapshot of order book state
 */
export interface OrderBookSnapshot {
    symbol: string;
    connectorType: string;
    marketType: string;
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    timestamp: number;
}

@Injectable()
export class OrderBookSamplingService {
    private lastSnapshot: OrderBookSnapshot | null = null;
    private lastSnapshotTime = 0;

    constructor(
        private readonly sink: EventSinkRepository,   // ← корректная зависимость
    ) { }

    /**
     * Handles incoming raw order book data, computes snapshots and deltas.
     */
    handleRawOrderBook(book: OrderBookSnapshot) {
        const now = Date.now();

        // 1) Первый стакан — это snapshot
        if (!this.lastSnapshot) {
            this.saveSnapshot(book);
            return;
        }

        // 2) Snapshot каждые 1 сек
        if (now - this.lastSnapshotTime >= 1000) {
            this.saveSnapshot(book);
        }

        // 3) Вычисление дельт
        const delta = this.getDelta(this.lastSnapshot, book);
        if (delta.bids.length > 0 || delta.asks.length > 0) {
            this.saveDelta(book, delta);
        }

        this.lastSnapshot = book;
    }

    /**
     * Writes a full snapshot to EventSink
     */
    private saveSnapshot(book: OrderBookSnapshot) {
        this.lastSnapshot = book;
        this.lastSnapshotTime = Date.now();

        this.sink.emit('orderbook', {
            category: 'orderbook',
            action: 'snapshot',
            symbol: book.symbol,
            connectorType: book.connectorType,
            marketType: book.marketType,
            timestamp: Date.now(),
            data: book,
        });
    }

    /**
     * Writes changed levels to EventSink
     */
    private saveDelta(
        book: OrderBookSnapshot,
        delta: { bids: OrderBookLevel[]; asks: OrderBookLevel[] },
    ) {
        this.sink.emit('orderbook', {
            category: 'orderbook',
            action: 'delta',
            symbol: book.symbol,
            connectorType: book.connectorType,
            marketType: book.marketType,
            timestamp: Date.now(),
            data: delta,
        });
    }

    /**
     * Computes bid/ask deltas between two snapshots.
     */
    private getDelta(prev: OrderBookSnapshot, next: OrderBookSnapshot) {
        const bids: OrderBookLevel[] = [];
        const asks: OrderBookLevel[] = [];

        const thresholdPrice = 0.0001;
        const thresholdVolume = 0.0001;

        const diff = (
            a: OrderBookLevel[],
            b: OrderBookLevel[],
            out: OrderBookLevel[],
        ) => {
            const len = Math.min(a.length, b.length);

            for (let i = 0; i < len; i++) {
                const p = a[i];
                const n = b[i];

                if (
                    Math.abs(p.price - n.price) > thresholdPrice ||
                    Math.abs(p.volume - n.volume) > thresholdVolume
                ) {
                    out.push(n);
                }
            }
        };

        diff(prev.bids, next.bids, bids);
        diff(prev.asks, next.asks, asks);

        return { bids, asks };
    }
}
