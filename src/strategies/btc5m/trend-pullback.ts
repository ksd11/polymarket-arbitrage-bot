import { Btc5mLeg, Btc5mStrategyDecision } from "./types";
import { Btc5mRegimeSnapshot } from "./regime";
import { calculateBtcActivity, calculateBtcTrendQuality } from "./trend-quality";

export type Btc5mTrendPullbackParams = {
    triggerPrice: number;
    entryPrice: number;
    orderUsdc: number;
    maxUsdcPerLeg: number;
    minSecondsLeftToTrigger: number;
    maxSecondsLeftToTrigger: number;
    minSecondsLeftToFill: number;
    triggerConfirmSeconds: number;
    maxOrderAgeSeconds: number;
    maxBtcReversalBps: number;
    btcDirectionRequired: boolean;
    trendAtrLookbackSeconds: number;
    trendAtrFloorUsd: number;
    trendMinGapSafety: number;
    trendMinPeakGapRatio: number;
    trendMaxSpread: number;
    minBtcRangeUsd: number;
    minBtcUniquePrices: number;
    maxBtcUnchangedSeconds: number;
    waitForPullbackTouch: boolean;
    maxTouchDrop: number;
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
    openPrice?: number;
    history?: Btc5mRegimeSnapshot[];
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
        if (secondsLeft > input.params.maxSecondsLeftToTrigger) {
            return { quotes: [], state, reason: "trend-pullback waiting for entry window" };
        }

        const candidateLeg = selectTriggeredLeg(input.upAsk, input.downAsk, input.params.triggerPrice);
        if (!candidateLeg) {
            return {
                quotes: [],
                state: { ...state, candidateLeg: undefined, candidateSinceMs: undefined },
                reason: "trend-pullback waiting for trigger",
            };
        }
        const quality = calculateBtcTrendQuality({ timestampMs: input.timestampMs, leg: candidateLeg, openPrice: input.openPrice, btcPrice: input.btcPrice, history: input.history, atrLookbackSeconds: input.params.trendAtrLookbackSeconds, atrFloorUsd: input.params.trendAtrFloorUsd });
        const activity = calculateBtcActivity(input.history, input.timestampMs, input.params.trendAtrLookbackSeconds);
        const bid = candidateLeg === "UP" ? input.upBid : input.downBid;
        const ask = candidateLeg === "UP" ? input.upAsk : input.downAsk;
        const spread = bid === undefined || ask === undefined ? Number.POSITIVE_INFINITY : ask - bid;
        const rejectedReason = input.params.minBtcRangeUsd > 0 && activity.rangeUsd < input.params.minBtcRangeUsd
            ? `BTC range ${activity.rangeUsd.toFixed(2)} below ${input.params.minBtcRangeUsd.toFixed(2)}`
            : input.params.minBtcUniquePrices > 0 && activity.uniquePrices < input.params.minBtcUniquePrices
                ? `BTC unique prices ${activity.uniquePrices} below ${input.params.minBtcUniquePrices}`
                : input.params.maxBtcUnchangedSeconds > 0 && activity.unchangedSeconds > input.params.maxBtcUnchangedSeconds
                    ? `BTC unchanged ${activity.unchangedSeconds.toFixed(1)}s`
                    : input.params.btcDirectionRequired && quality.directionalGap <= 0
            ? "BTC direction disagrees"
            : input.params.trendMinGapSafety > 0 && quality.gapSafety < input.params.trendMinGapSafety
                ? `gap safety ${quality.gapSafety.toFixed(2)} below ${input.params.trendMinGapSafety.toFixed(2)}`
                : input.params.trendMinPeakGapRatio > 0 && quality.peakGapRatio < input.params.trendMinPeakGapRatio
                    ? `peak ratio ${quality.peakGapRatio.toFixed(2)} below ${input.params.trendMinPeakGapRatio.toFixed(2)}`
                    : input.params.trendMaxSpread > 0 && spread > input.params.trendMaxSpread
                        ? `spread ${spread.toFixed(3)} above ${input.params.trendMaxSpread.toFixed(3)}`
                        : undefined;
        if (rejectedReason) {
            return { quotes: [], state: { ...state, candidateLeg: undefined, candidateSinceMs: undefined }, reason: `trend-pullback waiting: ${rejectedReason}` };
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
    const quality = calculateBtcTrendQuality({ timestampMs: input.timestampMs, leg, openPrice: input.openPrice, btcPrice: input.btcPrice, history: input.history, atrLookbackSeconds: input.params.trendAtrLookbackSeconds, atrFloorUsd: input.params.trendAtrFloorUsd });
    if (input.params.btcDirectionRequired && quality.directionalGap <= 0) {
        state = { ...state, cancelled: true };
        return { quotes: [], state, reason: "trend-pullback cancelled: BTC direction reversed" };
    }
    if (input.params.trendMinPeakGapRatio > 0 && quality.peakGapRatio < input.params.trendMinPeakGapRatio) {
        state = { ...state, cancelled: true };
        return { quotes: [], state, reason: `trend-pullback cancelled: peak ratio ${quality.peakGapRatio.toFixed(2)}` };
    }
    const ask = leg === "UP" ? input.upAsk : input.downAsk;
    if (ask === undefined) return { quotes: [], state, reason: "trend-pullback waiting for ask" };
    if (input.params.waitForPullbackTouch && ask > input.params.entryPrice) {
        return { quotes: [], state, reason: `trend-pullback armed: waiting for ask<=${input.params.entryPrice.toFixed(2)}` };
    }
    const activity = calculateBtcActivity(input.history, input.timestampMs, input.params.trendAtrLookbackSeconds);
    if ((input.params.minBtcRangeUsd > 0 && activity.rangeUsd < input.params.minBtcRangeUsd)
        || (input.params.minBtcUniquePrices > 0 && activity.uniquePrices < input.params.minBtcUniquePrices)
        || (input.params.maxBtcUnchangedSeconds > 0 && activity.unchangedSeconds > input.params.maxBtcUnchangedSeconds)) {
        if (input.params.waitForPullbackTouch) {
            return { quotes: [], state, reason: `trend-pullback touch rejected: inactive BTC range=${activity.rangeUsd.toFixed(2)} unique=${activity.uniquePrices} unchanged=${activity.unchangedSeconds.toFixed(1)}s` };
        }
        state = { ...state, cancelled: true };
        return { quotes: [], state, reason: `trend-pullback cancelled: inactive BTC range=${activity.rangeUsd.toFixed(2)} unique=${activity.uniquePrices} unchanged=${activity.unchangedSeconds.toFixed(1)}s` };
    }
    if (input.params.waitForPullbackTouch && input.params.maxTouchDrop > 0) {
        const previous = [...(input.history ?? [])].reverse().find((point) => point.t < input.timestampMs);
        const previousAsk = leg === "UP" ? previous?.upAsk : previous?.downAsk;
        const touchDrop = previousAsk === undefined ? 0 : previousAsk - ask;
        if (touchDrop > input.params.maxTouchDrop) {
            state = { ...state, cancelled: true };
            return { quotes: [], state, reason: `trend-pullback cancelled: ask dropped ${touchDrop.toFixed(2)} in one tick` };
        }
    }
    const spent = leg === "UP" ? input.spentUp : input.spentDown;
    const budgetLeft = input.params.maxUsdcPerLeg > 0
        ? Math.max(0, input.params.maxUsdcPerLeg - spent)
        : input.params.orderUsdc;
    const cost = Math.min(input.params.orderUsdc, budgetLeft);
    if (cost <= 0) {
        return { quotes: [], state, reason: "trend-pullback max exposure reached" };
    }

    const executionPrice = input.params.waitForPullbackTouch ? Math.min(input.params.entryPrice, ask) : input.params.entryPrice;
    return {
        quotes: [{
            key: `${leg}:BUY`,
            leg,
            side: "BUY",
            price: executionPrice,
            size: cost / executionPrice,
            note: `trend-pullback ${input.params.triggerPrice.toFixed(2)}->${executionPrice.toFixed(2)} gapSafety=${quality.gapSafety.toFixed(2)} peakRatio=${quality.peakGapRatio.toFixed(2)} btcRange=${activity.rangeUsd.toFixed(2)}`,
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
