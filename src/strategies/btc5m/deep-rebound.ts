import { buildBtc5mAdaptiveEdgeOrders, Btc5mAdaptiveEdgePosition } from "./adaptive-edge";
import { Btc5mRegimeSnapshot } from "./regime";
import { Btc5mLeg, Btc5mPrice, Btc5mStrategyDecision } from "./types";

export type Btc5mDeepReboundParams = {
    intervalMinutes: number;
    volPerInterval: number;
    minEntryPrice: number;
    maxEntryPrice: number;
    orderUsdc: number;
    maxUsdcPerLeg: number;
    scoreThreshold: number;
    minDiscount: number;
    takeProfitPrice: number;
    stopLossPct: number;
    minSecondsLeftToOpen: number;
    maxSecondsLeftToOpen: number;
    forceExitSecondsLeft: number;
};

export type Btc5mDeepReboundInput = {
    timestampMs: number;
    endMs: number;
    btcPrice?: number;
    openPrice?: number;
    up: Btc5mPrice;
    down: Btc5mPrice;
    positions: Record<Btc5mLeg, Btc5mAdaptiveEdgePosition>;
    history: Btc5mRegimeSnapshot[];
    params: Btc5mDeepReboundParams;
    emitRestingTakeProfit?: boolean;
};

export function buildBtc5mDeepReboundOrders(input: Btc5mDeepReboundInput): Btc5mStrategyDecision {
    const decision = buildBtc5mAdaptiveEdgeOrders({
        ...input,
        params: {
            intervalMinutes: input.params.intervalMinutes,
            volPerInterval: input.params.volPerInterval,
            minEdge: input.params.minDiscount,
            minMoveBps: 0,
            minElapsedSeconds: 0,
            orderUsdc: input.params.orderUsdc,
            maxUsdcPerLeg: input.params.maxUsdcPerLeg,
            maxPrice: input.params.maxEntryPrice,
            lookbackSeconds: 60,
            minHistoryPoints: 8,
            oscillationCrossCount: 2,
            oscillationChoppiness: 3,
            oscillationMaxBtcMoveBps: 8,
            trendMinBtcMoveBps: 5,
            trendMaxChoppiness: 8,
            panicMaxBtcMoveBps: 5,
            panicMinDiscount: input.params.minDiscount,
            panicMinAsk: input.params.minEntryPrice,
            panicMaxAsk: input.params.maxEntryPrice,
            undervalueScoreThreshold: input.params.scoreThreshold,
            maxRequiredSigma: 1.2,
            momentumMinBps: 2,
            fairMarketWeight: 0.35,
            fairAskWeight: 0.20,
            percentileWeight: 0.04,
            momentumDivergenceBonus: 0.04,
            panicDiscountBonus: 0.03,
            requiredSigmaPenalty: 0.10,
            lateTimePenalty: 0.05,
            scalpProfitPrice: input.params.takeProfitPrice,
            scalpProfitPct: 9,
            takeProfitPct: 9,
            takeProfitSellRatio: 1,
            stopLossPct: input.params.stopLossPct,
            forceExitSecondsLeft: input.params.forceExitSecondsLeft,
            minExitPrice: 0.05,
            minSecondsLeftToOpen: input.params.minSecondsLeftToOpen,
            maxSecondsLeftToOpen: input.params.maxSecondsLeftToOpen,
            minEntryPrice: input.params.minEntryPrice,
            noCheapBuySecondsLeft: 90,
            minCheapPrice: 0.20,
        },
    });

    const quotes = decision.quotes.flatMap((quote) => {
        if (quote.side === "BUY") {
            if (quote.price < input.params.minEntryPrice || quote.price > input.params.maxEntryPrice) return [];
            if (!quote.note?.includes("undervalue") && !quote.note?.includes("panic")) return [];
        }
        if (quote.side === "SELL") {
            const position = input.positions[quote.leg];
            const averagePrice = position.shares > 0 ? position.cost / position.shares : 0;
            const takeProfit = quote.price + 1e-9 >= averagePrice + input.params.takeProfitPrice;
            return [{ ...quote, note: takeProfit ? "deep-rebound take profit" : "deep-rebound risk exit" }];
        }
        return [{ ...quote, note: (quote.note ?? "adaptive-edge").replace("adaptive-edge", "deep-rebound") }];
    });
    if (input.emitRestingTakeProfit && !quotes.some((quote) => quote.side === "SELL")) {
        for (const leg of ["UP", "DOWN"] as const) {
            const position = input.positions[leg];
            if (position.shares <= 0) continue;
            const averagePrice = position.cost / position.shares;
            quotes.push({ key: `${leg}:SELL`, leg, side: "SELL", price: Math.min(0.99, averagePrice + input.params.takeProfitPrice), size: position.shares, note: "deep-rebound take profit" });
        }
    }
    return { quotes, fairUp: decision.fairUp, fairDown: decision.fairDown, reason: quotes.length ? "deep-rebound signal" : "deep-rebound waiting" };
}
