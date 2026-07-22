import { Btc5mLeg, Btc5mStrategyDecision } from "./types";

export type Btc5mTrendPullbackParams = {
    triggerPrice: number;
    entryPrice: number;
    orderUsdc: number;
    maxUsdcPerLeg: number;
    minSecondsLeftToTrigger: number;
    minSecondsLeftToFill: number;
    triggerConfirmSeconds: number;
    maxOrderAgeSeconds: number;
    maxBtcReversalBps: number;
    postFillStopLossPrice: number;
    postFillTakeProfitPrice: number;
    postFillMaxBtcReversalBps: number;
};

export type Btc5mTrendPullbackState = {
    triggeredLeg?: Btc5mLeg;
    triggeredAtMs?: number;
    triggeredBtcPrice?: number;
    candidateLeg?: Btc5mLeg;
    candidateSinceMs?: number;
    filled?: boolean;
    filledAtMs?: number;
    fillPrice?: number;
    filledShares?: number;
    exited?: boolean;
    cancelled?: boolean;
};

export type Btc5mTrendPullbackInput = {
    timestampMs: number;
    endMs: number;
    upAsk?: number;
    downAsk?: number;
    upBid?: number;
    downBid?: number;
    btcPrice?: number;
    spentUp: number;
    spentDown: number;
    state: Btc5mTrendPullbackState;
    params: Btc5mTrendPullbackParams;
};

export type Btc5mTrendPullbackDecision = Btc5mStrategyDecision & {
    state: Btc5mTrendPullbackState;
};

export function buildBtc5mTrendPullbackOrders(input: Btc5mTrendPullbackInput): Btc5mTrendPullbackDecision {
    if (input.state.filled) {
        return buildPostFillDecision(input);
    }
    if (input.state.cancelled) {
        return { quotes: [], state: input.state, reason: "trend-pullback cancelled" };
    }

    const secondsLeft = Math.max(0, (input.endMs - input.timestampMs) / 1000);
    let state = input.state;
    if (!state.triggeredLeg) {
        if (secondsLeft < input.params.minSecondsLeftToTrigger) {
            return { quotes: [], state, reason: "trend-pullback skip: too late to trigger" };
        }

        const candidateLeg = selectTriggeredLeg(input.upAsk, input.downAsk, input.params.triggerPrice);
        if (!candidateLeg) {
            return {
                quotes: [],
                state: { ...state, candidateLeg: undefined, candidateSinceMs: undefined },
                reason: "trend-pullback waiting for trigger",
            };
        }

        const candidateSinceMs = state.candidateLeg === candidateLeg && state.candidateSinceMs !== undefined
            ? state.candidateSinceMs
            : input.timestampMs;
        const confirmedSeconds = (input.timestampMs - candidateSinceMs) / 1000;
        if (confirmedSeconds < input.params.triggerConfirmSeconds) {
            return {
                quotes: [],
                state: { ...state, candidateLeg, candidateSinceMs },
                reason: `trend-pullback confirming ${candidateLeg}`,
            };
        }
        state = {
            triggeredLeg: candidateLeg,
            triggeredAtMs: input.timestampMs,
            triggeredBtcPrice: input.btcPrice,
            filled: false,
        };
    }

    const leg = state.triggeredLeg;
    if (!leg) return { quotes: [], state, reason: "trend-pullback waiting for trigger" };
    if (secondsLeft < input.params.minSecondsLeftToFill) {
        state = { ...state, cancelled: true };
        return { quotes: [], state, reason: "trend-pullback cancelled: too late to fill" };
    }
    const orderAgeSeconds = state.triggeredAtMs === undefined ? 0 : (input.timestampMs - state.triggeredAtMs) / 1000;
    if (input.params.maxOrderAgeSeconds > 0 && orderAgeSeconds > input.params.maxOrderAgeSeconds) {
        state = { ...state, cancelled: true };
        return { quotes: [], state, reason: "trend-pullback cancelled: order expired" };
    }
    const btcReversalBps = calculateBtcReversalBps(leg, state.triggeredBtcPrice, input.btcPrice);
    if (input.params.maxBtcReversalBps > 0 && btcReversalBps > input.params.maxBtcReversalBps) {
        state = { ...state, cancelled: true };
        return { quotes: [], state, reason: `trend-pullback cancelled: BTC reversed ${btcReversalBps.toFixed(2)}bps` };
    }
    const spent = leg === "UP" ? input.spentUp : input.spentDown;
    const budgetLeft = input.params.maxUsdcPerLeg > 0
        ? Math.max(0, input.params.maxUsdcPerLeg - spent)
        : input.params.orderUsdc;
    const cost = Math.min(input.params.orderUsdc, budgetLeft);
    if (cost <= 0) {
        return { quotes: [], state, reason: "trend-pullback max exposure reached" };
    }

    return {
        quotes: [{
            key: `${leg}:BUY`,
            leg,
            side: "BUY",
            price: input.params.entryPrice,
            size: cost / input.params.entryPrice,
            note: `trend-pullback ${input.params.triggerPrice.toFixed(2)}->${input.params.entryPrice.toFixed(2)}`,
        }],
        state,
        reason: `trend-pullback ${leg} pending at ${input.params.entryPrice.toFixed(2)}`,
    };
}

function buildPostFillDecision(input: Btc5mTrendPullbackInput): Btc5mTrendPullbackDecision {
    const state = input.state;
    if (state.exited) return { quotes: [], state, reason: "trend-pullback exited" };
    const leg = state.triggeredLeg;
    const shares = state.filledShares ?? 0;
    if (!leg || shares <= 0) return { quotes: [], state, reason: "trend-pullback filled" };
    const bid = leg === "UP" ? input.upBid : input.downBid;
    if (bid === undefined || bid <= 0) return { quotes: [], state, reason: "trend-pullback filled: waiting for bid" };

    let exitReason: string | undefined;
    if (input.params.postFillTakeProfitPrice > 0 && bid >= input.params.postFillTakeProfitPrice) {
        exitReason = `take-profit ${bid.toFixed(2)}`;
    } else if (input.params.postFillStopLossPrice > 0 && bid <= input.params.postFillStopLossPrice) {
        exitReason = `stop-loss ${bid.toFixed(2)}`;
    } else {
        const reversalBps = calculateBtcReversalBps(leg, state.triggeredBtcPrice, input.btcPrice);
        if (input.params.postFillMaxBtcReversalBps > 0 && reversalBps > input.params.postFillMaxBtcReversalBps) {
            exitReason = `BTC reversal ${reversalBps.toFixed(2)}bps`;
        }
    }
    if (!exitReason) return { quotes: [], state, reason: "trend-pullback holding" };

    return {
        quotes: [{
            key: `${leg}:SELL`,
            leg,
            side: "SELL",
            price: bid,
            size: shares,
            note: `trend-pullback ${exitReason}`,
        }],
        state,
        reason: `trend-pullback exit: ${exitReason}`,
    };
}

function calculateBtcReversalBps(leg: Btc5mLeg, triggerBtcPrice: number | undefined, btcPrice: number | undefined): number {
    if (triggerBtcPrice === undefined || btcPrice === undefined || triggerBtcPrice <= 0) return 0;
    const directionalMoveBps = (leg === "UP" ? 1 : -1) * (btcPrice - triggerBtcPrice) / triggerBtcPrice * 10_000;
    return Math.max(0, -directionalMoveBps);
}

function selectTriggeredLeg(upAsk: number | undefined, downAsk: number | undefined, triggerPrice: number): Btc5mLeg | undefined {
    const upTriggered = upAsk !== undefined && upAsk >= triggerPrice;
    const downTriggered = downAsk !== undefined && downAsk >= triggerPrice;
    if (!upTriggered && !downTriggered) return undefined;
    if (upTriggered && downTriggered) return (upAsk ?? 0) >= (downAsk ?? 0) ? "UP" : "DOWN";
    return upTriggered ? "UP" : "DOWN";
}
