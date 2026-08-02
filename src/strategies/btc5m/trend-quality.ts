import { Btc5mRegimeSnapshot } from "./regime";
import { Btc5mLeg } from "./types";

export type Btc5mTrendQuality = {
    directionalGap: number;
    gapSafety: number;
    peakGapRatio: number;
};

export type Btc5mBtcActivity = {
    rangeUsd: number;
    uniquePrices: number;
    unchangedSeconds: number;
};

export function calculateBtcTrendQuality(input: {
    timestampMs: number;
    leg: Btc5mLeg;
    openPrice?: number;
    btcPrice?: number;
    history?: Btc5mRegimeSnapshot[];
    atrLookbackSeconds: number;
    atrFloorUsd?: number;
}): Btc5mTrendQuality {
    if (!input.openPrice || !input.btcPrice) return { directionalGap: 0, gapSafety: 0, peakGapRatio: 0 };
    const direction = input.leg === "UP" ? 1 : -1;
    const directionalGap = (input.btcPrice - input.openPrice) * direction;
    const cutoff = input.timestampMs - input.atrLookbackSeconds * 1000;
    const prices = (input.history ?? [])
        .filter((point) => point.t >= cutoff && point.t <= input.timestampMs && point.btcPrice !== undefined)
        .sort((left, right) => left.t - right.t);
    const buckets = new Map<number, Btc5mRegimeSnapshot>();
    for (const point of prices) buckets.set(Math.floor(point.t / 1000), point);
    const sampled = Array.from(buckets.values());
    const moves: number[] = [];
    for (let index = 1; index < sampled.length; index++) {
        moves.push(Math.abs(sampled[index].btcPrice! - sampled[index - 1].btcPrice!));
    }
    const atr = moves.length > 0 ? moves.reduce((sum, move) => sum + move, 0) / moves.length : 0;
    const effectiveAtr = Math.max(atr, input.atrFloorUsd ?? 0);
    const gapSafety = effectiveAtr > 0 ? directionalGap / effectiveAtr : 0;
    const peakGap = Math.max(directionalGap, ...(input.history ?? [])
        .filter((point) => point.t <= input.timestampMs && point.btcPrice !== undefined)
        .map((point) => (point.btcPrice! - input.openPrice!) * direction));
    const peakGapRatio = peakGap > 0 ? directionalGap / peakGap : 0;
    return { directionalGap, gapSafety, peakGapRatio };
}

export function calculateBtcActivity(history: Btc5mRegimeSnapshot[] | undefined, timestampMs: number, lookbackSeconds: number): Btc5mBtcActivity {
    const points = (history ?? [])
        .filter((point) => point.t >= timestampMs - lookbackSeconds * 1000 && point.t <= timestampMs && point.btcPrice !== undefined)
        .sort((left, right) => left.t - right.t);
    if (points.length === 0) return { rangeUsd: 0, uniquePrices: 0, unchangedSeconds: Number.POSITIVE_INFINITY };
    const prices = points.map((point) => point.btcPrice!);
    const current = prices[prices.length - 1];
    let lastDifferentIndex = prices.length - 2;
    while (lastDifferentIndex >= 0 && Math.abs(prices[lastDifferentIndex] - current) < 1e-9) lastDifferentIndex--;
    const unchangedSince = points[Math.max(0, lastDifferentIndex + 1)].t;
    return {
        rangeUsd: Math.max(...prices) - Math.min(...prices),
        uniquePrices: new Set(prices.map((price) => price.toFixed(2))).size,
        unchangedSeconds: Math.max(0, (timestampMs - unchangedSince) / 1000),
    };
}
