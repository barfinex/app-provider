export interface ReplayOptions {
    from: number;         // timestamp start
    to: number;           // timestamp end
    speed?: number;       // 1x, 2x, 10x, 50x
    symbols?: string[];   // optional filtering
}

export type ReplayEvent = {
    ts: number;
    category: string;
    action: string;
    payload: Record<string, unknown>;
};
