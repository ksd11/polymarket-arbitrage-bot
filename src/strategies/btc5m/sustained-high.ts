import { Btc5mLeg, Btc5mStrategyDecision } from "./types";

export type Btc5mSustainedHighParams = {
    triggerPrice: number;
    confirmSeconds: number;
    entryPrice: number;
    orderUsdc: number;
    maxSecondsLeftToTrigger: number;
    minSecondsLeftToTrigger: number;
    minSecondsLeftToFill: number;
    maxOrderAgeSeconds: number;
    minBtcMoveBps: number;
    maxBtcReversalBps: number;
};

export type Btc5mSustainedHighState = {
    candidateLeg?: Btc5mLeg;
    candidateSinceMs?: number;
    triggeredLeg?: Btc5mLeg;
    triggeredAtMs?: number;
    triggerBtcPrice?: number;
    filled?: boolean;
    cancelled?: boolean;
};

export type Btc5mSustainedHighInput = {
    timestampMs: number;
    endMs: number;
    upAsk?: number;
    downAsk?: number;
    btcPrice?: number;
    openPrice?: number;
    state: Btc5mSustainedHighState;
    params: Btc5mSustainedHighParams;
};

export type Btc5mSustainedHighDecision = Btc5mStrategyDecision & {
    state: Btc5mSustainedHighState;
};

export function buildBtc5mSustainedHighOrders(input: Btc5mSustainedHighInput): Btc5mSustainedHighDecision {
    if (input.state.filled) return { quotes: [], state: input.state, reason: "sustained-high filled" };
    if (input.state.cancelled) return { quotes: [], state: input.state, reason: "sustained-high cancelled" };

    const secondsLeft = Math.max(0, (input.endMs - input.timestampMs) / 1000);
    let state = input.state;
    if (!state.triggeredLeg) {
        if (input.params.maxSecondsLeftToTrigger > 0 && secondsLeft > input.params.maxSecondsLeftToTrigger) {
            return {
                quotes: [],
                state: { ...state, candidateLeg: undefined, candidateSinceMs: undefined },
                reason: "sustained-high waiting for entry window",
            };
        }
        if (secondsLeft < input.params.minSecondsLeftToTrigger) {
            return { quotes: [], state, reason: "sustained-high skip: too late to trigger" };
        }

        const candidateLeg = selectCandidate(input.upAsk, input.downAsk, input.btcPrice, input.openPrice, input.params.triggerPrice, input.params.minBtcMoveBps);
        if (!candidateLeg) {
            return {
                quotes: [],
                state: { ...state, candidateLeg: undefined, candidateSinceMs: undefined },
                reason: "sustained-high waiting for threshold",
            };
        }

        const candidateSinceMs = state.candidateLeg === candidateLeg && state.candidateSinceMs !== undefined
            ? state.candidateSinceMs
            : input.timestampMs;
        const confirmedSeconds = (input.timestampMs - candidateSinceMs) / 1000;
        if (confirmedSeconds < input.params.confirmSeconds) {
            return {
                quotes: [],
                state: { ...state, candidateLeg, candidateSinceMs },
                reason: `sustained-high confirming ${candidateLeg} ${confirmedSeconds.toFixed(1)}s`,
            };
        }

        state = {
            triggeredLeg: candidateLeg,
            triggeredAtMs: input.timestampMs,
            triggerBtcPrice: input.btcPrice,
            filled: false,
        };
    }

    const orderAgeSeconds = state.triggeredAtMs === undefined ? 0 : (input.timestampMs - state.triggeredAtMs) / 1000;
    if (hasReversed(state.triggeredLeg, state.triggerBtcPrice, input.btcPrice, input.params.maxBtcReversalBps)) {
        state = { ...state, cancelled: true };
        return { quotes: [], state, reason: "sustained-high cancelled: BTC reversed" };
    }
    if (secondsLeft < input.params.minSecondsLeftToFill) {
        state = { ...state, cancelled: true };
        return { quotes: [], state, reason: "sustained-high cancelled: too late to fill" };
    }
    if (input.params.maxOrderAgeSeconds > 0 && orderAgeSeconds > input.params.maxOrderAgeSeconds) {
        state = { ...state, cancelled: true };
        return { quotes: [], state, reason: "sustained-high cancelled: order expired" };
    }

    const leg = state.triggeredLeg;
    if (!leg) return { quotes: [], state, reason: "sustained-high waiting for trigger" };
    return {
        quotes: [{
            key: `${leg}:BUY`,
            leg,
            side: "BUY",
            price: input.params.entryPrice,
            size: input.params.orderUsdc / input.params.entryPrice,
            note: `sustained-high ${input.params.triggerPrice.toFixed(2)} for ${input.params.confirmSeconds}s -> ${input.params.entryPrice.toFixed(2)}`,
        }],
        state,
        reason: `sustained-high ${leg} pending at ${input.params.entryPrice.toFixed(2)}`,
    };
}

function selectCandidate(
    upAsk: number | undefined,
    downAsk: number | undefined,
    btcPrice: number | undefined,
    openPrice: number | undefined,
    triggerPrice: number,
    minBtcMoveBps: number,
): Btc5mLeg | undefined {
    const upTriggered = upAsk !== undefined && upAsk >= triggerPrice;
    const downTriggered = downAsk !== undefined && downAsk >= triggerPrice;
    const candidate = !upTriggered && !downTriggered
        ? undefined
        : upTriggered && downTriggered
            ? ((upAsk ?? 0) >= (downAsk ?? 0) ? "UP" : "DOWN")
            : (upTriggered ? "UP" : "DOWN");
    if (!candidate || minBtcMoveBps <= 0) return candidate;
    if (!btcPrice || !openPrice || openPrice <= 0) return undefined;
    const moveBps = (btcPrice / openPrice - 1) * 10_000;
    return candidate === "UP" && moveBps >= minBtcMoveBps || candidate === "DOWN" && moveBps <= -minBtcMoveBps
        ? candidate
        : undefined;
}

function hasReversed(leg: Btc5mLeg | undefined, triggerPrice: number | undefined, currentPrice: number | undefined, maxReversalBps: number): boolean {
    if (!leg || !triggerPrice || !currentPrice || maxReversalBps <= 0) return false;
    const moveBps = (currentPrice / triggerPrice - 1) * 10_000;
    return leg === "UP" ? moveBps <= -maxReversalBps : moveBps >= maxReversalBps;
}
