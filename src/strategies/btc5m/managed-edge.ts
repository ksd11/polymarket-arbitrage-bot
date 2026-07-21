import { Btc5mLeg, Btc5mPrice, Btc5mStrategyDecision, Btc5mStrategyQuote } from "./types";
import { Btc5mEdgeParams, fairUpProbability } from "./edge";

export type Btc5mManagedEdgeParams = Btc5mEdgeParams & {
    minSecondsLeftToOpen: number;
    maxSecondsLeftToOpen: number;
    noCheapBuySecondsLeft: number;
    minCheapPrice: number;
    minEntryPrice: number;
    takeProfitPct: number;
    takeProfitSellRatio: number;
    stopLossPct: number;
    forceExitSecondsLeft: number;
    minExitPrice: number;
};

export type Btc5mManagedEdgePosition = {
    shares: number;
    cost: number;
    tookProfit?: boolean;
};

export type Btc5mManagedEdgeInput = {
    timestampMs: number;
    endMs: number;
    btcPrice?: number;
    openPrice?: number;
    up: Btc5mPrice;
    down: Btc5mPrice;
    positions: Record<Btc5mLeg, Btc5mManagedEdgePosition>;
    params: Btc5mManagedEdgeParams;
};

export function buildBtc5mManagedEdgeOrders(input: Btc5mManagedEdgeInput): Btc5mStrategyDecision {
    if (input.btcPrice === undefined || input.openPrice === undefined) {
        return { quotes: [], reason: "managed-edge skip: missing btc/open price" };
    }

    const secondsLeft = Math.max(0, (input.endMs - input.timestampMs) / 1000);
    const fairUp = fairUpProbability(input.btcPrice, input.openPrice, input.endMs - input.timestampMs, input.params);
    const fairDown = 1 - fairUp;
    const quotes: Btc5mStrategyQuote[] = [];

    addExitQuotes(quotes, "UP", input.up.bestBid ?? undefined, fairUp, input.positions.UP, secondsLeft, input.params);
    addExitQuotes(quotes, "DOWN", input.down.bestBid ?? undefined, fairDown, input.positions.DOWN, secondsLeft, input.params);

    const canOpen = secondsLeft >= input.params.minSecondsLeftToOpen && secondsLeft <= input.params.maxSecondsLeftToOpen;
    if (!canOpen) return { quotes, fairUp, fairDown, reason: "managed-edge manage-only: outside open window" };

    addEntryQuote(quotes, "UP", input.up.bestAsk ?? undefined, fairUp, input.positions.UP, secondsLeft, input.params);
    addEntryQuote(quotes, "DOWN", input.down.bestAsk ?? undefined, fairDown, input.positions.DOWN, secondsLeft, input.params);

    return { quotes, fairUp, fairDown };
}

function addEntryQuote(
    quotes: Btc5mStrategyQuote[],
    leg: Btc5mLeg,
    ask: number | undefined,
    fair: number,
    position: Btc5mManagedEdgePosition,
    secondsLeft: number,
    params: Btc5mManagedEdgeParams,
): void {
    if (position.tookProfit) return;
    if (ask === undefined || !(ask > 0 && ask <= params.maxPrice)) return;
    if (ask < params.minEntryPrice) return;
    if (secondsLeft < params.noCheapBuySecondsLeft && ask < params.minCheapPrice) return;
    const edge = fair - ask;
    if (edge < params.minEdge) return;
    const budgetLeft = params.maxUsdcPerLeg > 0 ? Math.max(0, params.maxUsdcPerLeg - position.cost) : params.orderUsdc;
    const cost = Math.min(params.orderUsdc, budgetLeft);
    if (cost <= 0) return;
    quotes.push({ key: `${leg}:BUY`, leg, side: "BUY", price: ask, size: cost / ask, fair, edge });
}

function addExitQuotes(
    quotes: Btc5mStrategyQuote[],
    leg: Btc5mLeg,
    bid: number | undefined,
    fair: number,
    position: Btc5mManagedEdgePosition,
    secondsLeft: number,
    params: Btc5mManagedEdgeParams,
): void {
    if (bid === undefined || bid <= 0 || position.shares <= 0) return;
    const avgCost = position.cost / position.shares;
    const pnlPct = avgCost > 0 ? (bid - avgCost) / avgCost : 0;
    const edge = fair - bid;

    if (secondsLeft <= params.forceExitSecondsLeft && bid >= params.minExitPrice) {
        quotes.push({ key: `${leg}:SELL`, leg, side: "SELL", price: bid, size: position.shares, fair, edge });
        return;
    }

    if (!position.tookProfit && pnlPct >= params.takeProfitPct) {
        quotes.push({ key: `${leg}:SELL`, leg, side: "SELL", price: bid, size: Math.max(0, position.shares * params.takeProfitSellRatio), fair, edge });
        return;
    }

    if (pnlPct <= -params.stopLossPct && fair < bid) {
        quotes.push({ key: `${leg}:SELL`, leg, side: "SELL", price: bid, size: position.shares, fair, edge });
    }
}
