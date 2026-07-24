import { Btc5mLeg, Btc5mStrategyDecision } from "./types";

export type Btc5mLatencyScalpParams = {
    minSignalPrice: number;
    triggerConfirmSeconds: number;
    signalLookbackSeconds: number;
    minContractMomentum: number;
    minBtcMomentumBps: number;
    entryPrice: number;
    takeProfitPrice: number;
    orderUsdc: number;
    maxSecondsLeftToTrigger: number;
    minSecondsLeftToTrigger: number;
    maxEntryOrderAgeSeconds: number;
    maxHoldSeconds: number;
    minBtcMoveBps: number;
    maxBtcReversalBps: number;
    stopLossPrice: number;
    forceExitSecondsLeft: number;
};

export type Btc5mLatencyScalpState = {
    candidateLeg?: Btc5mLeg;
    candidateSinceMs?: number;
    candidateAsk?: number;
    candidateBtcPrice?: number;
    triggeredLeg?: Btc5mLeg;
    triggeredAtMs?: number;
    triggerBtcPrice?: number;
    filled?: boolean;
    filledAtMs?: number;
    fillBtcPrice?: number;
    filledShares?: number;
    cancelled?: boolean;
    exited?: boolean;
};

export type Btc5mLatencyScalpInput = {
    timestampMs: number;
    endMs: number;
    upAsk?: number;
    downAsk?: number;
    upBid?: number;
    downBid?: number;
    btcPrice?: number;
    openPrice?: number;
    state: Btc5mLatencyScalpState;
    params: Btc5mLatencyScalpParams;
};

export type Btc5mLatencyScalpDecision = Btc5mStrategyDecision & {
    state: Btc5mLatencyScalpState;
};

export function buildBtc5mLatencyScalpOrders(input: Btc5mLatencyScalpInput): Btc5mLatencyScalpDecision {
    if (input.state.exited) return { quotes: [], state: input.state, reason: "latency-scalp exited" };
    if (input.state.cancelled) return { quotes: [], state: input.state, reason: "latency-scalp cancelled" };

    const secondsLeft = Math.max(0, (input.endMs - input.timestampMs) / 1000);
    if (input.state.filled) return buildExitDecision(input, secondsLeft);

    let state = input.state;
    if (!state.triggeredLeg) {
        if (input.params.maxSecondsLeftToTrigger > 0 && secondsLeft > input.params.maxSecondsLeftToTrigger) {
            return { quotes: [], state: resetCandidate(state), reason: "latency-scalp waiting for entry window" };
        }
        if (secondsLeft < input.params.minSecondsLeftToTrigger) {
            return { quotes: [], state: { ...resetCandidate(state), cancelled: true }, reason: "latency-scalp cancelled: too late" };
        }

        const candidateLeg = selectCandidate(input, input.params);
        if (!candidateLeg) return { quotes: [], state: resetCandidate(state), reason: "latency-scalp waiting for aligned trend" };
        const sameCandidate = state.candidateLeg === candidateLeg && state.candidateSinceMs !== undefined
            && (input.timestampMs - state.candidateSinceMs) / 1000 <= input.params.signalLookbackSeconds;
        const candidateSinceMs = sameCandidate
            ? state.candidateSinceMs
            : input.timestampMs;
        const candidateAsk = sameCandidate ? state.candidateAsk : askForLeg(candidateLeg, input);
        const candidateBtcPrice = sameCandidate ? state.candidateBtcPrice : input.btcPrice;
        const confirmedSeconds = (input.timestampMs - candidateSinceMs) / 1000;
        const contractMomentum = (askForLeg(candidateLeg, input) ?? 0) - (candidateAsk ?? 0);
        const btcMomentumBps = directionalBtcMoveBps(candidateLeg, candidateBtcPrice, input.btcPrice);
        if (confirmedSeconds < input.params.triggerConfirmSeconds || contractMomentum < input.params.minContractMomentum || btcMomentumBps < input.params.minBtcMomentumBps) {
            return {
                quotes: [],
                state: { ...state, candidateLeg, candidateSinceMs, candidateAsk, candidateBtcPrice },
                reason: `latency-scalp confirming ${candidateLeg} ${confirmedSeconds.toFixed(1)}s contract=${contractMomentum.toFixed(3)} btc=${btcMomentumBps.toFixed(2)}bps`,
            };
        }
        state = {
            triggeredLeg: candidateLeg,
            triggeredAtMs: input.timestampMs,
            triggerBtcPrice: input.btcPrice,
        };
    }

    const orderAgeSeconds = state.triggeredAtMs === undefined ? 0 : (input.timestampMs - state.triggeredAtMs) / 1000;
    if (orderAgeSeconds > input.params.maxEntryOrderAgeSeconds) {
        return { quotes: [], state: { ...state, cancelled: true }, reason: "latency-scalp cancelled: entry expired" };
    }
    if (hasReversed(state.triggeredLeg, state.triggerBtcPrice, input.btcPrice, input.params.maxBtcReversalBps)) {
        return { quotes: [], state: { ...state, cancelled: true }, reason: "latency-scalp cancelled: BTC reversed before fill" };
    }

    const leg = state.triggeredLeg;
    if (!leg) return { quotes: [], state, reason: "latency-scalp waiting" };
    return {
        quotes: [{
            key: `${leg}:BUY`,
            leg,
            side: "BUY",
            price: input.params.entryPrice,
            size: input.params.orderUsdc / input.params.entryPrice,
            note: `latency-scalp entry ${input.params.entryPrice.toFixed(2)}`,
        }],
        state,
        reason: `latency-scalp ${leg} entry pending`,
    };
}

function buildExitDecision(input: Btc5mLatencyScalpInput, secondsLeft: number): Btc5mLatencyScalpDecision {
    const state = input.state;
    const leg = state.triggeredLeg;
    const shares = state.filledShares ?? 0;
    if (!leg || shares <= 0) return { quotes: [], state, reason: "latency-scalp filled without position" };
    const bid = leg === "UP" ? input.upBid : input.downBid;
    const holdSeconds = state.filledAtMs === undefined ? 0 : (input.timestampMs - state.filledAtMs) / 1000;
    const reversed = hasReversed(leg, state.fillBtcPrice, input.btcPrice, input.params.maxBtcReversalBps);
    const stopLoss = bid !== undefined && bid <= input.params.stopLossPrice;
    const forceExit = secondsLeft <= input.params.forceExitSecondsLeft || holdSeconds >= input.params.maxHoldSeconds || reversed || stopLoss;
    if (forceExit && bid !== undefined && bid > 0) {
        return {
            quotes: [{ key: `${leg}:SELL`, leg, side: "SELL", price: bid, size: shares, note: `latency-scalp risk exit bid=${bid.toFixed(2)}` }],
            state,
            reason: reversed ? "latency-scalp exit: BTC reversed" : stopLoss ? "latency-scalp exit: stop loss" : "latency-scalp exit: timeout",
        };
    }
    return {
        quotes: [{ key: `${leg}:SELL`, leg, side: "SELL", price: input.params.takeProfitPrice, size: shares, note: `latency-scalp take profit ${input.params.takeProfitPrice.toFixed(2)}` }],
        state,
        reason: `latency-scalp take-profit pending at ${input.params.takeProfitPrice.toFixed(2)}`,
    };
}

function selectCandidate(input: Btc5mLatencyScalpInput, params: Btc5mLatencyScalpParams): Btc5mLeg | undefined {
    if (!input.btcPrice || !input.openPrice || input.openPrice <= 0) return undefined;
    const moveBps = (input.btcPrice / input.openPrice - 1) * 10_000;
    const up = input.upAsk !== undefined && input.upAsk >= params.minSignalPrice && input.upAsk <= params.entryPrice && moveBps >= params.minBtcMoveBps;
    const down = input.downAsk !== undefined && input.downAsk >= params.minSignalPrice && input.downAsk <= params.entryPrice && moveBps <= -params.minBtcMoveBps;
    if (up && down) return Math.abs(moveBps) >= params.minBtcMoveBps ? (moveBps >= 0 ? "UP" : "DOWN") : undefined;
    return up ? "UP" : down ? "DOWN" : undefined;
}

function hasReversed(leg: Btc5mLeg | undefined, referencePrice: number | undefined, currentPrice: number | undefined, maxReversalBps: number): boolean {
    if (!leg || !referencePrice || !currentPrice || maxReversalBps <= 0) return false;
    const moveBps = (currentPrice / referencePrice - 1) * 10_000;
    return leg === "UP" ? moveBps <= -maxReversalBps : moveBps >= maxReversalBps;
}

function resetCandidate(state: Btc5mLatencyScalpState): Btc5mLatencyScalpState {
    return { ...state, candidateLeg: undefined, candidateSinceMs: undefined, candidateAsk: undefined, candidateBtcPrice: undefined };
}

function askForLeg(leg: Btc5mLeg, input: Btc5mLatencyScalpInput): number | undefined {
    return leg === "UP" ? input.upAsk : input.downAsk;
}

function directionalBtcMoveBps(leg: Btc5mLeg, start: number | undefined, current: number | undefined): number {
    if (!start || !current) return 0;
    const move = (current / start - 1) * 10_000;
    return leg === "UP" ? move : -move;
}
