import { Btc5mStrategyDecision } from "./types";
import { buildBtc5mEdgeOrders, Btc5mEdgeParams } from "./edge";
import { buildBtc5mRangeArbOrders, Btc5mRangeArbParams } from "./range-arb";

export type Btc5mHybridParams = {
    // Regime detection
    lookbackSeconds: number;        // How far back to look for regime detection (e.g. 60-120s)
    oscillationThreshold: number;   // Number of mid-crossing events to classify as oscillating
    rangeThreshold: number;         // If upAsk range > this within lookback, consider it volatile/oscillating
    trendThreshold: number;         // If |upAsk - 0.5| avg > this, consider it trending

    // Edge params
    edge: Btc5mEdgeParams;

    // Range-Arb params
    rangeArb: Btc5mRangeArbParams;
};

export type Btc5mHybridInput = {
    timestampMs: number;
    endMs: number;
    btcPrice?: number;
    openPrice?: number;
    upAsk: number;
    downAsk: number;
    spentUp: number;
    spentDown: number;
    hasUpPosition: boolean;
    hasDownPosition: boolean;
    params: Btc5mHybridParams;
    // Price history for regime detection
    priceHistory: PriceSnapshot[];
};

export type PriceSnapshot = {
    t: number;
    upAsk: number;
};

export type MarketRegime = "oscillating" | "trending" | "unknown";

/**
 * Detect whether the market is oscillating (good for range-arb) or trending (good for edge).
 *
 * Oscillating: price crosses the midpoint (0.5) multiple times, and stays within a range.
 * Trending: price is persistently on one side or has a clear drift.
 */
export function detectRegime(history: PriceSnapshot[], params: Btc5mHybridParams, currentTs: number): MarketRegime {
    const cutoff = currentTs - params.lookbackSeconds * 1000;
    const recent = history.filter((p) => p.t >= cutoff);

    if (recent.length < 5) return "unknown";

    // Count mid-crossings (how many times upAsk crosses 0.5)
    let crossings = 0;
    for (let i = 1; i < recent.length; i++) {
        const prev = recent[i - 1].upAsk;
        const curr = recent[i].upAsk;
        if ((prev < 0.5 && curr >= 0.5) || (prev >= 0.5 && curr < 0.5)) {
            crossings++;
        }
    }

    // Calculate range (max - min of upAsk)
    const values = recent.map((p) => p.upAsk);
    const range = Math.max(...values) - Math.min(...values);

    // Calculate average distance from 0.5 (trend strength)
    const avgDeviation = values.reduce((sum, v) => sum + Math.abs(v - 0.5), 0) / values.length;

    // Classification logic:
    // Oscillating: many crossings OR range is large + crossings exist
    if (crossings >= params.oscillationThreshold) {
        return "oscillating";
    }

    // Also oscillating if price range is wide (both sides being explored)
    if (range >= params.rangeThreshold && crossings >= 1) {
        return "oscillating";
    }

    // Trending: price persistently on one side
    if (avgDeviation >= params.trendThreshold) {
        return "trending";
    }

    // Default: if range is narrow and few crossings, treat as trending
    // (edge strategy handles directional bias better)
    return "trending";
}

/**
 * Hybrid strategy: uses Range Arb when oscillating, Edge when trending.
 */
export function buildBtc5mHybridOrders(input: Btc5mHybridInput): Btc5mStrategyDecision & { regime: MarketRegime } {
    const regime = detectRegime(input.priceHistory, input.params, input.timestampMs);

    if (regime === "oscillating") {
        // Use Range Arb strategy in oscillating markets
        const decision = buildBtc5mRangeArbOrders({
            upAsk: input.upAsk,
            downAsk: input.downAsk,
            hasUpPosition: input.hasUpPosition,
            hasDownPosition: input.hasDownPosition,
            params: input.params.rangeArb,
        });
        return { ...decision, regime, reason: `regime=oscillating → range-arb` };
    }

    if (regime === "trending" && input.btcPrice !== undefined && input.openPrice !== undefined) {
        // Use Edge strategy in trending markets
        const decision = buildBtc5mEdgeOrders({
            timestampMs: input.timestampMs,
            endMs: input.endMs,
            btcPrice: input.btcPrice,
            openPrice: input.openPrice,
            upAsk: input.upAsk,
            downAsk: input.downAsk,
            spentUp: input.spentUp,
            spentDown: input.spentDown,
            params: input.params.edge,
        });
        return { ...decision, regime, reason: `regime=trending → edge` };
    }

    return { quotes: [], regime, reason: `regime=${regime} → skip` };
}
