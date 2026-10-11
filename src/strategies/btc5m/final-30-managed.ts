import { buildBtc5mFinal30HighOrders, Btc5mFinal30HighParams } from "./final-30-high";
import { Btc5mRegimeSnapshot } from "./regime";
import { calculateBtcTrendQuality } from "./trend-quality";
import { Btc5mLeg, Btc5mStrategyDecision } from "./types";

export type Btc5mFinal30ManagedPosition = {
    leg: Btc5mLeg;
    entryPrice: number;
    entryBtcPrice?: number;
    shares: number;
    exited: boolean;
    stopCandidateSinceMs?: number;
};

export type Btc5mFinal30ManagedParams = Btc5mFinal30HighParams & {
    earlyBtcMinMoveUsd: number;
    earlyBtcMinAsk: number;
    earlyBtcMaxSecondsLeftToOpen: number;
    btcDirectionRequired: boolean;
    trendAtrLookbackSeconds: number;
    trendMinGapSafety: number;
    trendMinPeakGapRatio: number;
    trendMaxSpread: number;
    timezoneOffsetHours: number;
    dayStartHour: number;
    dayEndHour: number;
    dayMinDirectionalMarginBps: number;
    nightMinDirectionalMarginBps: number;
    takeProfitDelta: number;
    stopLossDelta: number;
    /**
     * Optional ABSOLUTE stop price (0 = disabled). When > 0 it replaces the relative
     * `entryPrice - stopLossDelta` trigger, so a stop at a fixed level still fires after a
     * collapse fill: with only the relative form an entry at 0.55 would put the stop at 0.10,
     * i.e. no protection at all exactly when protection matters most.
     */
    stopLossPrice?: number;
    stopMinBtcReversalBps: number;
    stopConfirmSeconds: number;
    stopMaxDirectionalMarginBps: number;
    /**
     * Optional entry-quality gates (multi-factor value function, disabled by default):
     * require the BTC price to still be moving toward the traded leg (velocity, bps/s)
     * and/or to be accelerating (bps/s^2). Enabled only when the lookback is > 0.
     */
    entryVelocityLookbackSeconds?: number;
    entryMinBtcVelocityBpsPerSec?: number;
    entryAccelerationLookbackSeconds?: number;
    entryMinBtcAccelerationBpsPerSec2?: number;
};

export type Btc5mFinal30ManagedInput = {
    timestampMs: number;
    endMs: number;
    upAsk?: number;
    downAsk?: number;
    upBid?: number;
    downBid?: number;
    btcPrice?: number;
    openPrice?: number;
    history?: Btc5mRegimeSnapshot[];
    position?: Btc5mFinal30ManagedPosition;
    blocked: boolean;
    params: Btc5mFinal30ManagedParams;
};

export type Btc5mFinal30ManagedDecision = Btc5mStrategyDecision & {
    position?: Btc5mFinal30ManagedPosition;
};

export type Btc5mFinal30ManagedSession = {
    name: "day" | "night";
    localHour: number;
    minDirectionalMarginBps: number;
};

export function final30ManagedSession(timestampMs: number, params: Btc5mFinal30ManagedParams): Btc5mFinal30ManagedSession {
    const utcHour = new Date(timestampMs).getUTCHours();
    const localHour = ((utcHour + params.timezoneOffsetHours) % 24 + 24) % 24;
    const day = params.dayStartHour <= params.dayEndHour
        ? localHour >= params.dayStartHour && localHour < params.dayEndHour
        : localHour >= params.dayStartHour || localHour < params.dayEndHour;
    return {
        name: day ? "day" : "night",
        localHour,
        minDirectionalMarginBps: day ? params.dayMinDirectionalMarginBps : params.nightMinDirectionalMarginBps,
    };
}

export function final30ManagedDirectionalMarginBps(leg: Btc5mLeg, openPrice?: number, btcPrice?: number): number {
    if (!openPrice || !btcPrice) return 0;
    const moveBps = (btcPrice / openPrice - 1) * 10_000;
    return leg === "UP" ? moveBps : -moveBps;
}

export function buildBtc5mFinal30ManagedOrders(input: Btc5mFinal30ManagedInput): Btc5mFinal30ManagedDecision {
    if (!input.position) {
        const earlyDecision = buildEarlyBtcEntry(input);
        if (earlyDecision) return earlyDecision;
        const finalDecision = buildBtc5mFinal30HighOrders({
            timestampMs: input.timestampMs,
            endMs: input.endMs,
            upAsk: input.upAsk,
            downAsk: input.downAsk,
            entered: input.blocked,
            params: input.params,
        });
        return filterEntry(input, finalDecision, false);
    }
    if (input.position.exited) return { quotes: [], position: input.position, reason: "final-30-managed exited" };
    const bid = input.position.leg === "UP" ? input.upBid : input.downBid;
    if (bid === undefined || bid <= 0) return { quotes: [], position: input.position, reason: "final-30-managed waiting for bid" };
    const takeProfitPrice = Math.min(0.99, input.position.entryPrice + input.params.takeProfitDelta);
    if (input.params.takeProfitDelta > 0 && bid >= takeProfitPrice) {
        return {
            quotes: [{ key: `${input.position.leg}:SELL`, leg: input.position.leg, side: "SELL", price: takeProfitPrice, size: input.position.shares, note: `final-30-managed take-profit ${takeProfitPrice.toFixed(2)}` }],
            position: input.position,
            reason: "final-30-managed take profit",
        };
    }
    const absoluteStopPrice = input.params.stopLossPrice ?? 0;
    const stopLossPrice = absoluteStopPrice > 0
        ? absoluteStopPrice
        : input.position.entryPrice - input.params.stopLossDelta;
    const stopEnabled = absoluteStopPrice > 0 || input.params.stopLossDelta > 0;
    const contractStop = stopEnabled && bid <= stopLossPrice;
    const btcReversalBps = directionalBtcReversalBps(input.position.leg, input.position.entryBtcPrice, input.btcPrice);
    const directionalMarginBps = directionalBtcMarginBps(input.position.leg, input.openPrice, input.btcPrice);
    // NOTE: `stopMinBtcReversalBps` is a SIGNED threshold (positive = the underlying must have
    // moved AGAINST us). Setting it to 0 does NOT disable the gate -- `btcReversalBps >= 0` still
    // suppresses the stop whenever BTC is flat-to-favourable, which is exactly what happens in a
    // pure quote-driven collapse (live-measured: price 0.95 -> 0.01 while btcReversal stayed at
    // -0.01bps). Use a NEGATIVE value to truly bypass the BTC confirmation.
    const btcConfirmed = (input.params.stopMinBtcReversalBps < 0
            || btcReversalBps >= input.params.stopMinBtcReversalBps)
        && directionalMarginBps <= input.params.stopMaxDirectionalMarginBps;
    if (!contractStop || !btcConfirmed) {
        const position = input.position.stopCandidateSinceMs === undefined
            ? input.position
            : { ...input.position, stopCandidateSinceMs: undefined };
        return { quotes: [], position, reason: `final-30-managed holding tp=${input.params.takeProfitDelta > 0 ? takeProfitPrice.toFixed(2) : "off"} stop=${stopLossPrice.toFixed(2)} btcReversal=${btcReversalBps.toFixed(2)} margin=${directionalMarginBps.toFixed(2)}` };
    }
    const stopCandidateSinceMs = input.position.stopCandidateSinceMs ?? input.timestampMs;
    const confirmedSeconds = (input.timestampMs - stopCandidateSinceMs) / 1000;
    const position = { ...input.position, stopCandidateSinceMs };
    if (confirmedSeconds >= input.params.stopConfirmSeconds) {
        return {
            quotes: [{ key: `${input.position.leg}:SELL`, leg: input.position.leg, side: "SELL", price: bid, size: input.position.shares, note: `final-30-managed stop-loss bid=${bid.toFixed(2)}` }],
            position,
            reason: `final-30-managed stop loss btcReversal=${btcReversalBps.toFixed(2)} margin=${directionalMarginBps.toFixed(2)}`,
        };
    }
    return { quotes: [], position, reason: `final-30-managed confirming stop ${confirmedSeconds.toFixed(1)}s` };
}

function buildEarlyBtcEntry(input: Btc5mFinal30ManagedInput): Btc5mFinal30ManagedDecision | undefined {
    if (input.blocked || (input.params.earlyBtcMinMoveUsd <= 0 && input.params.trendMinGapSafety <= 0) || !input.openPrice || !input.btcPrice) return undefined;
    const secondsLeft = Math.max(0, (input.endMs - input.timestampMs) / 1000);
    if (secondsLeft <= input.params.maxSecondsLeftToOpen || secondsLeft > input.params.earlyBtcMaxSecondsLeftToOpen) return undefined;
    const moveUsd = input.btcPrice - input.openPrice;
    if (Math.abs(moveUsd) < input.params.earlyBtcMinMoveUsd) return undefined;
    const leg: Btc5mLeg = moveUsd > 0 ? "UP" : "DOWN";
    const ask = leg === "UP" ? input.upAsk : input.downAsk;
    if (ask === undefined || ask < input.params.earlyBtcMinAsk || ask > input.params.maxEntryPrice) return undefined;
    return filterEntry(input, {
        quotes: [{ key: `${leg}:BUY`, leg, side: "BUY", price: ask, size: input.params.orderShares, note: `final-30-managed early-btc entry move=$${Math.abs(moveUsd).toFixed(2)} ask=${ask.toFixed(2)}` }],
        reason: `final-30-managed early BTC ${leg} signal`,
    }, true);
}

function filterEntry(input: Btc5mFinal30ManagedInput, decision: Btc5mFinal30ManagedDecision, requireTrendQuality: boolean): Btc5mFinal30ManagedDecision {
    const quote = decision.quotes[0];
    if (!quote || quote.side !== "BUY") return decision;
    const metrics = calculateBtcTrendQuality({ timestampMs: input.timestampMs, leg: quote.leg, openPrice: input.openPrice, btcPrice: input.btcPrice, history: input.history, atrLookbackSeconds: input.params.trendAtrLookbackSeconds, atrFloorUsd: 0 });
    const session = final30ManagedSession(input.timestampMs, input.params);
    const directionalMarginBps = final30ManagedDirectionalMarginBps(quote.leg, input.openPrice, input.btcPrice);
    const requiredMarginBps = input.params.btcDirectionRequired ? Math.max(Number.EPSILON, session.minDirectionalMarginBps) : session.minDirectionalMarginBps;
    if (directionalMarginBps < requiredMarginBps) {
        return { quotes: [], reason: `final-30-managed ${session.name} ${session.localHour}:00 BTC margin ${directionalMarginBps.toFixed(2)}bps below ${requiredMarginBps.toFixed(2)}bps for ${quote.leg}` };
    }
    const velocityLookbackSeconds = input.params.entryVelocityLookbackSeconds ?? 0;
    if (velocityLookbackSeconds > 0) {
        const velocity = directionalBtcVelocityBpsPerSec({ leg: quote.leg, history: input.history, timestampMs: input.timestampMs, lookbackSeconds: velocityLookbackSeconds, currentPrice: input.btcPrice });
        const requiredVelocity = input.params.entryMinBtcVelocityBpsPerSec ?? 0;
        if (velocity === undefined || velocity < requiredVelocity) {
            return { quotes: [], reason: `final-30-managed entry velocity ${velocity === undefined ? "na" : velocity.toFixed(3)}bps/s below ${requiredVelocity.toFixed(3)}bps/s for ${quote.leg}` };
        }
    }
    const accelerationLookbackSeconds = input.params.entryAccelerationLookbackSeconds ?? 0;
    if (accelerationLookbackSeconds > 0) {
        const acceleration = directionalBtcAccelerationBpsPerSec2({ leg: quote.leg, history: input.history, timestampMs: input.timestampMs, lookbackSeconds: accelerationLookbackSeconds, currentPrice: input.btcPrice });
        const requiredAcceleration = input.params.entryMinBtcAccelerationBpsPerSec2 ?? 0;
        if (acceleration === undefined || acceleration < requiredAcceleration) {
            return { quotes: [], reason: `final-30-managed entry acceleration ${acceleration === undefined ? "na" : acceleration.toFixed(4)}bps/s2 below ${requiredAcceleration.toFixed(4)}bps/s2 for ${quote.leg}` };
        }
    }
    const bid = quote.leg === "UP" ? input.upBid : input.downBid;
    const spread = bid === undefined ? Number.POSITIVE_INFINITY : quote.price - bid;
    if (input.params.trendMaxSpread > 0 && spread > input.params.trendMaxSpread) {
        return { quotes: [], reason: `final-30-managed spread ${spread.toFixed(3)} above ${input.params.trendMaxSpread.toFixed(3)}` };
    }
    if (requireTrendQuality && input.params.trendMinGapSafety > 0 && metrics.gapSafety < input.params.trendMinGapSafety) {
        return { quotes: [], reason: `final-30-managed gap safety ${metrics.gapSafety.toFixed(2)} below ${input.params.trendMinGapSafety.toFixed(2)}` };
    }
    if (requireTrendQuality && input.params.trendMinPeakGapRatio > 0 && metrics.peakGapRatio < input.params.trendMinPeakGapRatio) {
        return { quotes: [], reason: `final-30-managed peak ratio ${metrics.peakGapRatio.toFixed(2)} below ${input.params.trendMinPeakGapRatio.toFixed(2)}` };
    }
    return {
        ...decision,
        quotes: [{ ...quote, note: `${quote.note} session=${session.name}/${session.localHour}:00 btcMargin=${directionalMarginBps.toFixed(2)}bps required=${requiredMarginBps.toFixed(2)}bps gapSafety=${metrics.gapSafety.toFixed(2)} peakRatio=${metrics.peakGapRatio.toFixed(2)} spread=${Number.isFinite(spread) ? spread.toFixed(3) : "na"}` }],
    };
}

function directionalBtcReversalBps(leg: Btc5mLeg, entryPrice?: number, currentPrice?: number): number {
    if (!entryPrice || !currentPrice) return 0;
    const moveBps = (currentPrice / entryPrice - 1) * 10_000;
    return leg === "UP" ? -moveBps : moveBps;
}

function directionalBtcMarginBps(leg: Btc5mLeg, openPrice?: number, currentPrice?: number): number {
    if (!openPrice || !currentPrice) return Number.POSITIVE_INFINITY;
    const moveBps = (currentPrice / openPrice - 1) * 10_000;
    return leg === "UP" ? moveBps : -moveBps;
}

/** Nearest BTC history sample to `targetMs`, within `toleranceSeconds`, that carries a price. */
function btcPriceNear(history: Btc5mRegimeSnapshot[] | undefined, targetMs: number, toleranceSeconds: number): Btc5mRegimeSnapshot | undefined {
    let best: Btc5mRegimeSnapshot | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const point of history ?? []) {
        if (point.btcPrice === undefined) continue;
        const delta = Math.abs(point.t - targetMs);
        if (delta < bestDelta) {
            best = point;
            bestDelta = delta;
        }
    }
    if (!best || bestDelta > toleranceSeconds * 1000) return undefined;
    return best;
}

/**
 * Directional BTC velocity toward `leg` over the last `lookbackSeconds` (bps per second).
 * Positive = BTC is still moving in the leg's favour; undefined when history is too thin.
 */
export function directionalBtcVelocityBpsPerSec(input: {
    leg: Btc5mLeg;
    history?: Btc5mRegimeSnapshot[];
    timestampMs: number;
    lookbackSeconds: number;
    currentPrice?: number;
}): number | undefined {
    if (!input.currentPrice || input.lookbackSeconds <= 0) return undefined;
    const anchor = btcPriceNear(input.history, input.timestampMs - input.lookbackSeconds * 1000, input.lookbackSeconds);
    if (!anchor?.btcPrice) return undefined;
    const dtSeconds = (input.timestampMs - anchor.t) / 1000;
    if (dtSeconds <= 0 || dtSeconds < input.lookbackSeconds * 0.5) return undefined;
    const velocity = ((input.currentPrice / anchor.btcPrice - 1) * 10_000) / dtSeconds;
    return input.leg === "UP" ? velocity : -velocity;
}

/**
 * Directional BTC acceleration toward `leg` (bps per second squared): the change of the
 * velocity between the recent window and the preceding window, per second.
 */
export function directionalBtcAccelerationBpsPerSec2(input: {
    leg: Btc5mLeg;
    history?: Btc5mRegimeSnapshot[];
    timestampMs: number;
    lookbackSeconds: number;
    currentPrice?: number;
}): number | undefined {
    if (!input.currentPrice || input.lookbackSeconds <= 0) return undefined;
    const mid = btcPriceNear(input.history, input.timestampMs - input.lookbackSeconds * 1000, input.lookbackSeconds);
    const old = btcPriceNear(input.history, input.timestampMs - 2 * input.lookbackSeconds * 1000, input.lookbackSeconds);
    if (!mid?.btcPrice || !old?.btcPrice) return undefined;
    const dt1 = (input.timestampMs - mid.t) / 1000;
    const dt0 = (mid.t - old.t) / 1000;
    if (dt1 <= 0 || dt0 <= 0) return undefined;
    const v1 = ((input.currentPrice / mid.btcPrice - 1) * 10_000) / dt1;
    const v0 = ((mid.btcPrice / old.btcPrice - 1) * 10_000) / dt0;
    const acceleration = (v1 - v0) / ((dt1 + dt0) / 2);
    return input.leg === "UP" ? acceleration : -acceleration;
}
