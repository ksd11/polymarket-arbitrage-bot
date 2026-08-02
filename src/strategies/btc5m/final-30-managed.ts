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
    stopMinBtcReversalBps: number;
    stopConfirmSeconds: number;
    stopMaxDirectionalMarginBps: number;
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
    const stopLossPrice = input.position.entryPrice - input.params.stopLossDelta;
    const contractStop = input.params.stopLossDelta > 0 && bid <= stopLossPrice;
    const btcReversalBps = directionalBtcReversalBps(input.position.leg, input.position.entryBtcPrice, input.btcPrice);
    const directionalMarginBps = directionalBtcMarginBps(input.position.leg, input.openPrice, input.btcPrice);
    const btcConfirmed = btcReversalBps >= input.params.stopMinBtcReversalBps
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
