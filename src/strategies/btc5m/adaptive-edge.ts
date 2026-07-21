import { Btc5mLeg, Btc5mPrice, Btc5mStrategyDecision, Btc5mStrategyQuote } from "./types";
import { Btc5mEdgeParams, fairUpProbability } from "./edge";
import { Btc5mRegimeMetrics, Btc5mRegimeParams, Btc5mRegimeSnapshot, calculateRegimeMetrics } from "./regime";

export type Btc5mAdaptiveEdgeParams = Btc5mEdgeParams & Btc5mRegimeParams & {
    panicMaxBtcMoveBps: number;
    panicMinDiscount: number;
    panicMinAsk: number;
    panicMaxAsk: number;
    undervalueScoreThreshold: number;
    maxRequiredSigma: number;
    momentumMinBps: number;
    fairMarketWeight: number;
    fairAskWeight: number;
    percentileWeight: number;
    momentumDivergenceBonus: number;
    panicDiscountBonus: number;
    requiredSigmaPenalty: number;
    lateTimePenalty: number;
    scalpProfitPrice: number;
    scalpProfitPct: number;
    takeProfitPct: number;
    takeProfitSellRatio: number;
    stopLossPct: number;
    forceExitSecondsLeft: number;
    minExitPrice: number;
    minSecondsLeftToOpen: number;
    maxSecondsLeftToOpen: number;
    minEntryPrice: number;
    noCheapBuySecondsLeft: number;
    minCheapPrice: number;
};

export type Btc5mAdaptiveEdgePosition = {
    shares: number;
    cost: number;
    tookProfit?: boolean;
};

export type Btc5mAdaptiveEdgeInput = {
    timestampMs: number;
    endMs: number;
    btcPrice?: number;
    openPrice?: number;
    up: Btc5mPrice;
    down: Btc5mPrice;
    positions: Record<Btc5mLeg, Btc5mAdaptiveEdgePosition>;
    history: Btc5mRegimeSnapshot[];
    params: Btc5mAdaptiveEdgeParams;
};

export type Btc5mAdaptiveEdgeDecision = Btc5mStrategyDecision & {
    metrics?: Btc5mRegimeMetrics;
};

type UndervalueSignal = {
    score: number;
    fairMarketEdge: number;
    fairAskEdge: number;
    marketProb: number;
    requiredSigma: number;
    askPercentile: number;
    momentumDivergence: boolean;
    panicDiscount: boolean;
};

export function buildBtc5mAdaptiveEdgeOrders(input: Btc5mAdaptiveEdgeInput): Btc5mAdaptiveEdgeDecision {
    if (input.btcPrice === undefined || input.openPrice === undefined) {
        return { quotes: [], reason: "adaptive-edge skip: missing btc/open price" };
    }

    const secondsLeft = Math.max(0, (input.endMs - input.timestampMs) / 1000);
    const fairUp = fairUpProbability(input.btcPrice, input.openPrice, input.endMs - input.timestampMs, input.params);
    const fairDown = 1 - fairUp;
    const metrics = calculateRegimeMetrics(input.history, input.timestampMs, input.openPrice, input.btcPrice, input.params);
    const quotes: Btc5mStrategyQuote[] = [];

    addExitQuote(quotes, "UP", input.up.bestBid ?? undefined, fairUp, input.positions.UP, secondsLeft, input.params);
    addExitQuote(quotes, "DOWN", input.down.bestBid ?? undefined, fairDown, input.positions.DOWN, secondsLeft, input.params);

    const canOpen = secondsLeft >= input.params.minSecondsLeftToOpen && secondsLeft <= input.params.maxSecondsLeftToOpen;
    if (!canOpen) return { quotes, fairUp, fairDown, metrics, reason: `adaptive-edge ${metrics.regime}: manage-only` };

    if (metrics.regime === "trending") {
        const direction: Btc5mLeg = input.btcPrice >= input.openPrice ? "UP" : "DOWN";
        const ask = direction === "UP" ? input.up.bestAsk ?? undefined : input.down.bestAsk ?? undefined;
        const fair = direction === "UP" ? fairUp : fairDown;
        const signal = calculateUndervalueSignal(direction, ask, fair, input, secondsLeft, metrics);
        addBuyQuote(quotes, direction, ask, fair, input.positions[direction], secondsLeft, input.params.minEdge + 0.05, input.params, signal, "trend");
        return { quotes, fairUp, fairDown, metrics, reason: `adaptive-edge trending ${direction}` };
    }

    const panicQuotesBefore = quotes.length;
    addUndervalueBuy(quotes, "UP", input.up.bestAsk ?? undefined, fairUp, input.positions.UP, input, secondsLeft, metrics);
    addUndervalueBuy(quotes, "DOWN", input.down.bestAsk ?? undefined, fairDown, input.positions.DOWN, input, secondsLeft, metrics);
    if (quotes.length > panicQuotesBefore) {
        return { quotes, fairUp, fairDown, metrics, reason: "adaptive-edge undervalue" };
    }

    if (metrics.regime === "oscillating") return { quotes, fairUp, fairDown, metrics, reason: "adaptive-edge oscillating: wait for panic discount" };

    return { quotes, fairUp, fairDown, metrics, reason: `adaptive-edge ${metrics.regime}: skip` };
}

function addBuyQuote(quotes: Btc5mStrategyQuote[], leg: Btc5mLeg, ask: number | undefined, fair: number, position: Btc5mAdaptiveEdgePosition, secondsLeft: number, minEdge: number, params: Btc5mAdaptiveEdgeParams, signal: UndervalueSignal | undefined, tag: string): void {
    if (position.tookProfit) return;
    if (ask === undefined || ask <= 0 || ask > params.maxPrice || ask < params.minEntryPrice) return;
    if (secondsLeft < params.noCheapBuySecondsLeft && ask < params.minCheapPrice) return;
    const edge = fair - ask;
    if (edge < minEdge) return;
    if (signal) {
        if (signal.requiredSigma > params.maxRequiredSigma) return;
        if (signal.score < params.undervalueScoreThreshold) return;
    }
    const budgetLeft = params.maxUsdcPerLeg > 0 ? Math.max(0, params.maxUsdcPerLeg - position.cost) : params.orderUsdc;
    const cost = Math.min(params.orderUsdc, budgetLeft);
    if (cost <= 0) return;
    quotes.push({ key: `${leg}:BUY`, leg, side: "BUY", price: ask, size: cost / ask, fair, edge, note: signalNote(tag, signal) });
}

function addUndervalueBuy(quotes: Btc5mStrategyQuote[], leg: Btc5mLeg, ask: number | undefined, fair: number, position: Btc5mAdaptiveEdgePosition, input: Btc5mAdaptiveEdgeInput, secondsLeft: number, metrics: Btc5mRegimeMetrics): void {
    if (ask === undefined || ask < input.params.panicMinAsk || ask > input.params.panicMaxAsk) return;
    const signal = calculateUndervalueSignal(leg, ask, fair, input, secondsLeft, metrics);
    addBuyQuote(quotes, leg, ask, fair, position, secondsLeft, input.params.panicMinDiscount, input.params, signal, signal.panicDiscount ? "panic-discount" : "undervalue");
}

function addExitQuote(quotes: Btc5mStrategyQuote[], leg: Btc5mLeg, bid: number | undefined, fair: number, position: Btc5mAdaptiveEdgePosition, secondsLeft: number, params: Btc5mAdaptiveEdgeParams): void {
    if (bid === undefined || bid <= 0 || position.shares <= 0) return;
    const avgCost = position.cost / position.shares;
    const pnlPct = avgCost > 0 ? (bid - avgCost) / avgCost : 0;
    const edge = fair - bid;

    if (secondsLeft <= params.forceExitSecondsLeft && bid >= params.minExitPrice) {
        quotes.push({ key: `${leg}:SELL`, leg, side: "SELL", price: bid, size: position.shares, fair, edge });
        return;
    }

    if (!position.tookProfit && (bid >= avgCost + params.scalpProfitPrice || pnlPct >= params.scalpProfitPct || pnlPct >= params.takeProfitPct)) {
        quotes.push({ key: `${leg}:SELL`, leg, side: "SELL", price: bid, size: position.shares * params.takeProfitSellRatio, fair, edge });
        return;
    }

    if (pnlPct <= -params.stopLossPct && fair < bid) {
        quotes.push({ key: `${leg}:SELL`, leg, side: "SELL", price: bid, size: position.shares, fair, edge });
    }
}

function calculateUndervalueSignal(leg: Btc5mLeg, ask: number | undefined, fair: number, input: Btc5mAdaptiveEdgeInput, secondsLeft: number, metrics: Btc5mRegimeMetrics): UndervalueSignal {
    const upAsk = input.up.bestAsk ?? undefined;
    const downAsk = input.down.bestAsk ?? undefined;
    const askValue = ask ?? 1;
    const askSum = (upAsk ?? 0) + (downAsk ?? 0);
    const marketProb = askSum > 0 ? askValue / askSum : askValue;
    const fairMarketEdge = fair - marketProb;
    const fairAskEdge = fair - askValue;
    const requiredSigma = calculateRequiredSigma(leg, input.btcPrice!, input.openPrice!, secondsLeft, input.params);
    const askPercentile = calculateAskPercentile(leg, askValue, input.history);
    const askMomentum = leg === "UP" ? metrics.upAskMomentum : metrics.downAskMomentum;
    const btcMomentumAligned = leg === "UP" ? metrics.btcMomentumBps >= input.params.momentumMinBps : metrics.btcMomentumBps <= -input.params.momentumMinBps;
    const momentumDivergence = btcMomentumAligned && askMomentum <= 0;
    const panicDiscount = metrics.btcMoveBps <= input.params.panicMaxBtcMoveBps && fairAskEdge >= input.params.panicMinDiscount;
    const lateProgress = secondsLeft >= input.params.noCheapBuySecondsLeft ? 0 : 1 - secondsLeft / Math.max(1, input.params.noCheapBuySecondsLeft);
    const score = (
        input.params.fairMarketWeight * Math.max(0, fairMarketEdge)
        + input.params.fairAskWeight * Math.max(0, fairAskEdge)
        + input.params.percentileWeight * Math.max(0, 1 - askPercentile)
        + (momentumDivergence ? input.params.momentumDivergenceBonus : 0)
        + (panicDiscount ? input.params.panicDiscountBonus : 0)
        - input.params.requiredSigmaPenalty * Math.max(0, requiredSigma - 0.5)
        - input.params.lateTimePenalty * lateProgress
    );
    return { score, fairMarketEdge, fairAskEdge, marketProb, requiredSigma, askPercentile, momentumDivergence, panicDiscount };
}

function calculateRequiredSigma(leg: Btc5mLeg, btcPrice: number, openPrice: number, secondsLeft: number, params: Btc5mAdaptiveEdgeParams): number {
    const requiredMove = leg === "UP" ? Math.max(0, openPrice - btcPrice) : Math.max(0, btcPrice - openPrice);
    const intervalSeconds = params.intervalMinutes * 60;
    const expectedMove = openPrice * params.volPerInterval * Math.sqrt(Math.max(1, secondsLeft) / intervalSeconds);
    return expectedMove > 0 ? requiredMove / expectedMove : Number.POSITIVE_INFINITY;
}

function calculateAskPercentile(leg: Btc5mLeg, ask: number, history: Btc5mRegimeSnapshot[]): number {
    const values = history
        .map((point) => leg === "UP" ? point.upAsk : point.downAsk)
        .filter((value): value is number => value !== undefined && Number.isFinite(value));
    if (values.length === 0) return 0.5;
    const belowOrEqual = values.filter((value) => value <= ask).length;
    return belowOrEqual / values.length;
}

function signalNote(tag: string, signal: UndervalueSignal | undefined): string {
    if (!signal) return `adaptive-edge ${tag}`;
    return [
        `adaptive-edge ${tag}`,
        `score=${signal.score.toFixed(3)}`,
        `mktEdge=${signal.fairMarketEdge.toFixed(3)}`,
        `askEdge=${signal.fairAskEdge.toFixed(3)}`,
        `sigma=${signal.requiredSigma.toFixed(2)}`,
        `pct=${signal.askPercentile.toFixed(2)}`,
        signal.momentumDivergence ? "divergence" : "",
        signal.panicDiscount ? "panic" : "",
    ].filter(Boolean).join(" ");
}
