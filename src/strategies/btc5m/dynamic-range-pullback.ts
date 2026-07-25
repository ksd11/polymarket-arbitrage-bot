import { Btc5mLeg, Btc5mStrategyDecision } from "./types";

export type Btc5mDynamicRangePullbackParams = {
    minContractPullback: number;
    orderShares: number;
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
    return {
        quotes: [{ key: `${candidate}:BUY`, leg: candidate, side: "BUY", price: ask, size: input.params.orderShares, note: `dynamic-range-pullback entry ${ask.toFixed(2)} pullback=${contractPullback.toFixed(2)}` }],
        state: nextState,
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
    const maxPairCost = secondsLeft > input.params.earlyPairSecondsLeft
        ? input.params.earlyPairCost
        : secondsLeft > input.params.middlePairSecondsLeft
            ? input.params.middlePairCost
            : input.params.latePairCost;
    const hedgePrice = floorToTick(maxPairCost - (state.entryPrice ?? 0), 0.01);
    const bid = entryLeg === "UP" ? input.upBid : input.downBid;
    const crossedStrike = directionalMarginBps(entryLeg, input.openPrice, input.btcPrice) <= 0;
    const stopPrice = Math.max(0.01, (state.entryPrice ?? 0) - input.params.stopLossDelta);
    const stopSignal = bid !== undefined && bid <= stopPrice && crossedStrike;
    const stopCandidateSinceMs = stopSignal ? state.stopCandidateSinceMs ?? input.timestampMs : undefined;
    const stopConfirmed = stopCandidateSinceMs !== undefined && (input.timestampMs - stopCandidateSinceMs) / 1000 >= input.params.stopConfirmSeconds;
    const nakedSeconds = state.entryAtMs === undefined ? 0 : (input.timestampMs - state.entryAtMs) / 1000;
    const timedOut = input.params.maxNakedSeconds > 0 && nakedSeconds >= input.params.maxNakedSeconds;
    const nextState = { ...state, stopCandidateSinceMs };
    if ((stopConfirmed || timedOut) && bid !== undefined && bid > 0) {
        return {
            quotes: [{ key: `${entryLeg}:SELL`, leg: entryLeg, side: "SELL", price: bid, size: state.entryShares ?? input.params.orderShares, note: stopConfirmed ? "dynamic-range-pullback stop-loss" : "dynamic-range-pullback naked-timeout" }],
            state: nextState,
            reason: stopConfirmed ? "dynamic-range-pullback BTC confirmed stop" : "dynamic-range-pullback naked timeout",
        };
    }
    if (hedgePrice > 0) {
        const remainingShares = Math.max(0, (state.entryShares ?? input.params.orderShares) - (state.pairedShares ?? 0));
        if (remainingShares <= 1e-9) return { quotes: [], state: { ...nextState, paired: true }, reason: "dynamic-range-pullback pair locked" };
        return {
            quotes: [{ key: `${hedgeLeg}:BUY`, leg: hedgeLeg, side: "BUY", price: hedgePrice, size: remainingShares, note: `dynamic-range-pullback hedge pair<=${maxPairCost.toFixed(2)}` }],
            state: nextState,
            reason: `dynamic-range-pullback resting hedge ${hedgeLeg}<=${hedgePrice.toFixed(2)}`,
        };
    }
    return { quotes: [], state: nextState, reason: `dynamic-range-pullback waiting hedge<=${Math.max(0, hedgePrice).toFixed(2)}` };
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
