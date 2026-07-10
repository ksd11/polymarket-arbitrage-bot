export type Btc5mLeg = "UP" | "DOWN";
export type Btc5mQuoteSide = "BUY" | "SELL";
export type Btc5mOrderKey = `${Btc5mLeg}:${Btc5mQuoteSide}`;

export type Btc5mPrice = {
    bestBid?: number | null;
    bestAsk?: number | null;
    mid?: number | null;
};

export type Btc5mStrategyQuote = {
    key: Btc5mOrderKey;
    leg: Btc5mLeg;
    side: Btc5mQuoteSide;
    price: number;
    size: number;
    tokenId?: string;
    fair?: number;
    edge?: number;
};

export type Btc5mStrategyDecision = {
    quotes: Btc5mStrategyQuote[];
    fairUp?: number;
    fairDown?: number;
    bidCost?: number;
    reason?: string;
};

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function midFromPrice(price: Btc5mPrice | null | undefined): number | undefined {
    const bid = price?.bestBid ?? undefined;
    const ask = price?.bestAsk ?? undefined;
    const mid = price?.mid ?? undefined;
    if (mid !== undefined && Number.isFinite(mid)) return mid;
    if (bid !== undefined && ask !== undefined) return (bid + ask) / 2;
    return bid ?? ask;
}
