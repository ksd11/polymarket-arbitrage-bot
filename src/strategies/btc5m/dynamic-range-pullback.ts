import { Btc5mLeg, Btc5mStrategyDecision } from "./types";

export type Btc5mDynamicRangePullbackParams = {
    minContractPullback: number;
    minOrderNotional: number;
    orderShares: number;
    syntheticSell: boolean;
    dynamicSizing: boolean;
    maxPairUsdc: number;
    minLockedProfit: number;
    shareStep: number;
    minSecondsLeftToOpen: number;
    maxSecondsLeftToOpen: number;
    minDirectionalBtcMarginBps: number;
    maxBtcRetracementBps: number;
    maxSpread: number;
    entryConfirmSeconds: number;
    earlyPairCost: number;
    middlePairCost: number;
    latePairCost: number;
    earlyPairSecondsLeft: number;
    middlePairSecondsLeft: number;
    stopLossDelta: number;
    stopConfirmSeconds: number;
    maxNakedSeconds: number;
};

export type Btc5mDynamicRangePullbackState = {
    upPeakAsk?: number;
    downPeakAsk?: number;
    upPeakBtcPrice?: number;
    downPeakBtcPrice?: number;
    candidateLeg?: Btc5mLeg;
    candidateSinceMs?: number;
    entryLeg?: Btc5mLeg;
    entryPrice?: number;
    entryShares?: number;
    pairedShares?: number;
    plannedHedgePrice?: number;
    plannedHedgeShares?: number;
    plannedExitPrice?: number;
    plannedLockedProfit?: number;
    syntheticSell?: boolean;
    unhedgeable?: boolean;
    entryAtMs?: number;
    paired?: boolean;
    stopCandidateSinceMs?: number;
    exited?: boolean;
};

export type Btc5mDynamicRangePullbackInput = {
    timestampMs: number;
    endMs: number;
    btcPrice?: number;
    openPrice?: number;
    upAsk?: number;
    downAsk?: number;
    upBid?: number;
    downBid?: number;
    state: Btc5mDynamicRangePullbackState;
    params: Btc5mDynamicRangePullbackParams;
};

export type Btc5mDynamicRangePullbackDecision = Btc5mStrategyDecision & {
    state: Btc5mDynamicRangePullbackState;
    entryPlan?: Btc5mDynamicRangePairPlan;
};

export type Btc5mDynamicRangePairPlan = {
    mode: "opposite-buy" | "synthetic-sell";
    entryPrice: number;
    entryShares: number;
    hedgePrice: number;
    hedgeShares: number;
    exitPrice?: number;
    totalCost: number;
    entryWinsProfit: number;
    hedgeWinsProfit: number;
    lockedProfit: number;
};

export function buildBtc5mDynamicRangePullbackOrders(input: Btc5mDynamicRangePullbackInput): Btc5mDynamicRangePullbackDecision {
    const state = updatePeaks(input);
    if (state.exited) return { quotes: [], state, reason: "dynamic-range-pullback exited" };
    if (state.paired) return { quotes: [], state, reason: "dynamic-range-pullback pair locked" };
    const secondsLeft = Math.max(0, (input.endMs - input.timestampMs) / 1000);
    if (state.entryLeg) return buildPositionDecision(input, state, secondsLeft);
    if (secondsLeft < input.params.minSecondsLeftToOpen || secondsLeft > input.params.maxSecondsLeftToOpen) {
        return { quotes: [], state: resetCandidate(state), reason: "dynamic-range-pullback outside entry window" };
    }
    const candidate = selectTrend(input, state);
    if (!candidate) return { quotes: [], state: resetCandidate(state), reason: "dynamic-range-pullback waiting for trend pullback" };
    const candidateSinceMs = state.candidateLeg === candidate ? state.candidateSinceMs ?? input.timestampMs : input.timestampMs;
    const confirmedSeconds = (input.timestampMs - candidateSinceMs) / 1000;
    const nextState = { ...state, candidateLeg: candidate, candidateSinceMs };
    const ask = candidate === "UP" ? input.upAsk : input.downAsk;
    const peakAsk = candidate === "UP" ? state.upPeakAsk : state.downPeakAsk;
    const contractPullback = ask === undefined || peakAsk === undefined ? 0 : peakAsk - ask;
    if (confirmedSeconds < input.params.entryConfirmSeconds || contractPullback < input.params.minContractPullback) {
        return { quotes: [], state: nextState, reason: `dynamic-range-pullback confirming ${candidate} ${confirmedSeconds.toFixed(1)}s` };
    }
    if (ask === undefined || ask <= 0 || ask >= input.params.latePairCost) return { quotes: [], state: nextState, reason: "dynamic-range-pullback entry cannot fit pair budget" };
    const maxPairCost = pairCostForSeconds(secondsLeft, input.params);
    const plannedHedgePrice = floorToTick(maxPairCost - ask, 0.01);
    const entryPlan = input.params.syntheticSell
        ? buildDynamicRangeSyntheticSellPlan(ask, plannedHedgePrice, input.params)
        : buildDynamicRangePairPlan(ask, plannedHedgePrice, input.params);
    if (!entryPlan) return { quotes: [], state: nextState, reason: "dynamic-range-pullback skipped: no executable profitable pair within budget" };
    const exitDescription = entryPlan.mode === "synthetic-sell"
        ? `sell=${entryPlan.entryShares.toFixed(4)}@${entryPlan.exitPrice!.toFixed(2)}`
        : `hedge=${entryPlan.hedgeShares.toFixed(4)}@${entryPlan.hedgePrice.toFixed(2)}`;
    return {
        quotes: [{ key: `${candidate}:BUY`, leg: candidate, side: "BUY", price: ask, size: entryPlan.entryShares, note: `dynamic-range-pullback entry ${ask.toFixed(2)} pullback=${contractPullback.toFixed(2)} ${exitDescription} profit>=${entryPlan.lockedProfit.toFixed(4)}` }],
        state: nextState,
        entryPlan,
        reason: `dynamic-range-pullback ${candidate} entry`,
    };
}

function updatePeaks(input: Btc5mDynamicRangePullbackInput): Btc5mDynamicRangePullbackState {
    let state = input.state;
    if (input.upAsk !== undefined && (state.upPeakAsk === undefined || input.upAsk > state.upPeakAsk)) {
        state = { ...state, upPeakAsk: input.upAsk, upPeakBtcPrice: input.btcPrice };
    }
    if (input.downAsk !== undefined && (state.downPeakAsk === undefined || input.downAsk > state.downPeakAsk)) {
        state = { ...state, downPeakAsk: input.downAsk, downPeakBtcPrice: input.btcPrice };
    }
    return state;
}

function selectTrend(input: Btc5mDynamicRangePullbackInput, state: Btc5mDynamicRangePullbackState): Btc5mLeg | undefined {
    const up = qualifiesTrend("UP", input, state);
    const down = qualifiesTrend("DOWN", input, state);
    if (up && down) return directionalMarginBps("UP", input.openPrice, input.btcPrice) >= 0 ? "UP" : "DOWN";
    return up ? "UP" : down ? "DOWN" : undefined;
}

function qualifiesTrend(leg: Btc5mLeg, input: Btc5mDynamicRangePullbackInput, state: Btc5mDynamicRangePullbackState): boolean {
    const ask = leg === "UP" ? input.upAsk : input.downAsk;
    const bid = leg === "UP" ? input.upBid : input.downBid;
    const peakBtc = leg === "UP" ? state.upPeakBtcPrice : state.downPeakBtcPrice;
    if (ask === undefined || bid === undefined) return false;
    if (ask - bid > input.params.maxSpread) return false;
    if (directionalMarginBps(leg, input.openPrice, input.btcPrice) < input.params.minDirectionalBtcMarginBps) return false;
    return directionalRetracementBps(leg, peakBtc, input.btcPrice) <= input.params.maxBtcRetracementBps;
}

function buildPositionDecision(input: Btc5mDynamicRangePullbackInput, state: Btc5mDynamicRangePullbackState, secondsLeft: number): Btc5mDynamicRangePullbackDecision {
    const entryLeg = state.entryLeg!;
    const hedgeLeg: Btc5mLeg = entryLeg === "UP" ? "DOWN" : "UP";
    const maxPairCost = pairCostForSeconds(secondsLeft, input.params);
    const hedgePrice = state.plannedHedgePrice ?? floorToTick(maxPairCost - (state.entryPrice ?? 0), 0.01);
    const bid = entryLeg === "UP" ? input.upBid : input.downBid;
    const crossedStrike = directionalMarginBps(entryLeg, input.openPrice, input.btcPrice) <= 0;
    const stopPrice = Math.max(0.01, (state.entryPrice ?? 0) - input.params.stopLossDelta);
    const stopSignal = bid !== undefined && bid <= stopPrice && crossedStrike;
    const stopCandidateSinceMs = stopSignal ? state.stopCandidateSinceMs ?? input.timestampMs : undefined;
    const stopConfirmed = stopCandidateSinceMs !== undefined && (input.timestampMs - stopCandidateSinceMs) / 1000 >= input.params.stopConfirmSeconds;
    const nakedSeconds = state.entryAtMs === undefined ? 0 : (input.timestampMs - state.entryAtMs) / 1000;
    const timedOut = input.params.maxNakedSeconds > 0 && nakedSeconds >= input.params.maxNakedSeconds;
    const nextState = { ...state, stopCandidateSinceMs };
    if (state.unhedgeable && bid !== undefined && bid > 0) {
        return {
            quotes: [{ key: `${entryLeg}:SELL`, leg: entryLeg, side: "SELL", price: bid, size: state.entryShares ?? input.params.orderShares, note: "dynamic-range-pullback partial entry cannot be safely hedged" }],
            state: nextState,
            reason: "dynamic-range-pullback exiting unhedgeable partial entry",
        };
    }
    if ((stopConfirmed || timedOut) && bid !== undefined && bid > 0) {
        return {
            quotes: [{ key: `${entryLeg}:SELL`, leg: entryLeg, side: "SELL", price: bid, size: state.entryShares ?? input.params.orderShares, note: stopConfirmed ? "dynamic-range-pullback stop-loss" : "dynamic-range-pullback naked-timeout" }],
            state: nextState,
            reason: stopConfirmed ? "dynamic-range-pullback BTC confirmed stop" : "dynamic-range-pullback naked timeout",
        };
    }
    if (state.syntheticSell) {
        const exitPrice = state.plannedExitPrice;
        if (exitPrice !== undefined && exitPrice > (state.entryPrice ?? 1) && exitPrice < 1) {
            return {
                quotes: [{ key: `${entryLeg}:SELL`, leg: entryLeg, side: "SELL", price: exitPrice, size: state.entryShares ?? input.params.orderShares, note: `dynamic-range-pullback synthetic take-profit versus hedge@${hedgePrice.toFixed(2)}` }],
                state: nextState,
                reason: `dynamic-range-pullback resting synthetic sell ${entryLeg}>=${exitPrice.toFixed(2)}`,
            };
        }
        return { quotes: [], state: nextState, reason: "dynamic-range-pullback invalid synthetic sell target" };
    }
    if (hedgePrice > 0) {
        const targetHedgeShares = state.plannedHedgeShares ?? state.entryShares ?? input.params.orderShares;
        const remainingShares = Math.max(0, targetHedgeShares - (state.pairedShares ?? 0));
        if (remainingShares <= 1e-9) return { quotes: [], state: { ...nextState, paired: true }, reason: "dynamic-range-pullback pair locked" };
        if (hedgePrice * remainingShares < input.params.minOrderNotional) return { quotes: [], state: nextState, reason: "dynamic-range-pullback hedge below minimum notional" };
        return {
            quotes: [{ key: `${hedgeLeg}:BUY`, leg: hedgeLeg, side: "BUY", price: hedgePrice, size: remainingShares, note: `dynamic-range-pullback hedge total<=${input.params.maxPairUsdc.toFixed(2)} locked>=${(state.plannedLockedProfit ?? input.params.minLockedProfit).toFixed(4)}` }],
            state: nextState,
            reason: `dynamic-range-pullback resting hedge ${hedgeLeg}<=${hedgePrice.toFixed(2)}`,
        };
    }
    return { quotes: [], state: nextState, reason: `dynamic-range-pullback waiting hedge<=${Math.max(0, hedgePrice).toFixed(2)}` };
}

export function buildDynamicRangePairPlan(entryPrice: number, hedgePrice: number, params: Btc5mDynamicRangePullbackParams): Btc5mDynamicRangePairPlan | undefined {
    if (!(entryPrice > 0 && entryPrice < 1 && hedgePrice > 0 && hedgePrice < 1 && entryPrice + hedgePrice < 1)) return undefined;
    let entryShares = Math.max(params.orderShares, params.minOrderNotional / entryPrice);
    let hedgeShares = Math.max(params.orderShares, params.minOrderNotional / hedgePrice);
    if (params.dynamicSizing) {
        for (let iteration = 0; iteration < 32; iteration++) {
            const previousEntryShares = entryShares;
            const previousHedgeShares = hedgeShares;
            entryShares = Math.max(entryShares, (hedgePrice * hedgeShares + params.minLockedProfit) / (1 - entryPrice));
            hedgeShares = Math.max(hedgeShares, (entryPrice * entryShares + params.minLockedProfit) / (1 - hedgePrice));
            if (Math.abs(entryShares - previousEntryShares) < 1e-10 && Math.abs(hedgeShares - previousHedgeShares) < 1e-10) break;
        }
    } else {
        entryShares = params.orderShares;
        hedgeShares = params.orderShares;
    }
    entryShares = ceilToStep(entryShares, params.shareStep);
    hedgeShares = ceilToStep(hedgeShares, params.shareStep);
    const totalCost = entryPrice * entryShares + hedgePrice * hedgeShares;
    const entryWinsProfit = entryShares - totalCost;
    const hedgeWinsProfit = hedgeShares - totalCost;
    const lockedProfit = Math.min(entryWinsProfit, hedgeWinsProfit);
    const epsilon = 1e-8;
    if (entryPrice * entryShares + epsilon < params.minOrderNotional || hedgePrice * hedgeShares + epsilon < params.minOrderNotional) return undefined;
    if (totalCost > params.maxPairUsdc + epsilon || lockedProfit + epsilon < params.minLockedProfit) return undefined;
    return { mode: "opposite-buy", entryPrice, entryShares, hedgePrice, hedgeShares, totalCost, entryWinsProfit, hedgeWinsProfit, lockedProfit };
}

export function buildDynamicRangeSyntheticSellPlan(entryPrice: number, hedgePrice: number, params: Btc5mDynamicRangePullbackParams): Btc5mDynamicRangePairPlan | undefined {
    if (!(entryPrice > 0 && entryPrice < 1 && hedgePrice > 0 && hedgePrice < 1 && entryPrice + hedgePrice < 1)) return undefined;
    const entryShares = ceilToStep(Math.max(params.orderShares, params.minOrderNotional / entryPrice), params.shareStep);
    const exitPrice = ceilToTick(1 - hedgePrice, 0.01);
    const totalCost = entryPrice * entryShares;
    const lockedProfit = (exitPrice - entryPrice) * entryShares;
    if (!(exitPrice > entryPrice && exitPrice < 1)) return undefined;
    if (totalCost > params.maxPairUsdc + 1e-8 || lockedProfit + 1e-8 < params.minLockedProfit) return undefined;
    return {
        mode: "synthetic-sell",
        entryPrice,
        entryShares,
        hedgePrice,
        hedgeShares: 0,
        exitPrice,
        totalCost,
        entryWinsProfit: lockedProfit,
        hedgeWinsProfit: lockedProfit,
        lockedProfit,
    };
}

export function buildDynamicRangeHedgePlan(entryPrice: number, entryShares: number, hedgePrice: number, params: Btc5mDynamicRangePullbackParams): Btc5mDynamicRangePairPlan | undefined {
    if (!(entryPrice > 0 && entryPrice < 1 && entryShares > 0 && hedgePrice > 0 && hedgePrice < 1 && entryPrice + hedgePrice < 1)) return undefined;
    const minimumHedgeShares = Math.max(
        params.orderShares,
        params.minOrderNotional / hedgePrice,
        (entryPrice * entryShares + params.minLockedProfit) / (1 - hedgePrice),
    );
    const maximumHedgeShares = ((1 - entryPrice) * entryShares - params.minLockedProfit) / hedgePrice;
    const hedgeShares = ceilToStep(minimumHedgeShares, params.shareStep);
    if (hedgeShares > maximumHedgeShares + 1e-8) return undefined;
    const totalCost = entryPrice * entryShares + hedgePrice * hedgeShares;
    const entryWinsProfit = entryShares - totalCost;
    const hedgeWinsProfit = hedgeShares - totalCost;
    const lockedProfit = Math.min(entryWinsProfit, hedgeWinsProfit);
    if (totalCost > params.maxPairUsdc + 1e-8 || lockedProfit + 1e-8 < params.minLockedProfit) return undefined;
    return { mode: "opposite-buy", entryPrice, entryShares, hedgePrice, hedgeShares, totalCost, entryWinsProfit, hedgeWinsProfit, lockedProfit };
}

function directionalMarginBps(leg: Btc5mLeg, openPrice?: number, currentPrice?: number): number {
    if (!openPrice || !currentPrice) return Number.NEGATIVE_INFINITY;
    const move = (currentPrice / openPrice - 1) * 10_000;
    return leg === "UP" ? move : -move;
}

function directionalRetracementBps(leg: Btc5mLeg, peakPrice?: number, currentPrice?: number): number {
    if (!peakPrice || !currentPrice) return Number.POSITIVE_INFINITY;
    const move = (currentPrice / peakPrice - 1) * 10_000;
    return leg === "UP" ? -move : move;
}

function resetCandidate(state: Btc5mDynamicRangePullbackState): Btc5mDynamicRangePullbackState {
    return { ...state, candidateLeg: undefined, candidateSinceMs: undefined };
}

function floorToTick(value: number, tick: number): number {
    return Math.floor((value + 1e-9) / tick) * tick;
}

function ceilToStep(value: number, step: number): number {
    return Math.ceil((value - 1e-12) / step) * step;
}

function ceilToTick(value: number, tick: number): number {
    return Math.ceil((value - 1e-9) / tick) * tick;
}

function pairCostForSeconds(secondsLeft: number, params: Btc5mDynamicRangePullbackParams): number {
    return secondsLeft > params.earlyPairSecondsLeft
        ? params.earlyPairCost
        : secondsLeft > params.middlePairSecondsLeft
            ? params.middlePairCost
            : params.latePairCost;
}
