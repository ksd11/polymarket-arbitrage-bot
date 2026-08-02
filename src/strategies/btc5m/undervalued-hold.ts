import { fairUpProbability } from "./edge";
import { Btc5mRegimeSnapshot } from "./regime";
import { Btc5mLeg, Btc5mStrategyDecision } from "./types";

export type Btc5mUndervaluedHoldParams = {
    minEntryPrice: number;
    maxEntryPrice: number;
    orderShares: number;
    minSecondsLeftToOpen: number;
    maxSecondsLeftToOpen: number;
    minDirectionalBtcMarginBps: number;
    minEdge: number;
    volatilityLookbackSeconds: number;
    volatilityMinSamples: number;
    minVolPerInterval: number;
    maxVolPerInterval: number;
    maxSpread: number;
    stopLossPct: number;
};

export type Btc5mUndervaluedHoldPosition = {
    leg: Btc5mLeg;
    entryPrice: number;
    shares: number;
    exited: boolean;
};

export type Btc5mUndervaluedHoldInput = {
    timestampMs: number;
    endMs: number;
    btcPrice?: number;
    openPrice?: number;
    upAsk?: number;
    downAsk?: number;
    upBid?: number;
    downBid?: number;
    history?: Btc5mRegimeSnapshot[];
    position?: Btc5mUndervaluedHoldPosition;
    blocked: boolean;
    params: Btc5mUndervaluedHoldParams;
};

export type Btc5mUndervaluedHoldDecision = Btc5mStrategyDecision & {
    position?: Btc5mUndervaluedHoldPosition;
};

export function buildBtc5mUndervaluedHoldOrders(input: Btc5mUndervaluedHoldInput): Btc5mUndervaluedHoldDecision {
    if (input.position) return buildExitDecision(input);
    if (input.blocked) return { quotes: [], reason: "undervalued-hold already entered or has active entry" };
    if (!input.openPrice || !input.btcPrice) return { quotes: [], reason: "undervalued-hold waiting for BTC/open price" };

    const secondsLeft = Math.max(0, (input.endMs - input.timestampMs) / 1000);
    if (secondsLeft <= 30) return { quotes: [], reason: "undervalued-hold disabled in final 30 seconds" };
    if (secondsLeft < input.params.minSecondsLeftToOpen || secondsLeft > input.params.maxSecondsLeftToOpen) {
        return { quotes: [], reason: `undervalued-hold outside entry window (${secondsLeft.toFixed(1)}s left)` };
    }

    const moveBps = (input.btcPrice / input.openPrice - 1) * 10_000;
    const leg: Btc5mLeg = moveBps > 0 ? "UP" : "DOWN";
    const directionalMarginBps = Math.abs(moveBps);
    if (directionalMarginBps < input.params.minDirectionalBtcMarginBps) {
        return { quotes: [], reason: `undervalued-hold BTC margin ${directionalMarginBps.toFixed(2)}bps below ${input.params.minDirectionalBtcMarginBps.toFixed(2)}bps` };
    }

    const ask = leg === "UP" ? input.upAsk : input.downAsk;
    if (ask === undefined || ask < input.params.minEntryPrice || ask > input.params.maxEntryPrice) {
        return { quotes: [], reason: `undervalued-hold ${leg} ask ${ask?.toFixed(2) ?? "n/a"} outside [${input.params.minEntryPrice.toFixed(2)}, ${input.params.maxEntryPrice.toFixed(2)}]` };
    }
    const bid = leg === "UP" ? input.upBid : input.downBid;
    const spread = bid === undefined ? Number.POSITIVE_INFINITY : ask - bid;
    if (input.params.maxSpread > 0 && spread > input.params.maxSpread) {
        return { quotes: [], reason: `undervalued-hold spread ${spread.toFixed(3)} above ${input.params.maxSpread.toFixed(3)}` };
    }
    const volPerInterval = calculateRealtimeVolPerInterval(input.history, input.timestampMs, input.params);
    if (volPerInterval === undefined) {
        return { quotes: [], reason: `undervalued-hold waiting for ${input.params.volatilityMinSamples} volatility samples` };
    }
    const fairUp = fairUpProbability(input.btcPrice, input.openPrice, input.endMs - input.timestampMs, { intervalMinutes: 5, volPerInterval });
    const fair = leg === "UP" ? fairUp : 1 - fairUp;
    const askSum = (input.upAsk ?? 0) + (input.downAsk ?? 0);
    if (askSum <= 0) return { quotes: [], reason: "undervalued-hold waiting for complete market prices" };
    const marketProbability = ask / askSum;
    const edge = fair - marketProbability;
    if (edge < input.params.minEdge) {
        return { quotes: [], fairUp, fairDown: 1 - fairUp, reason: `undervalued-hold edge ${edge.toFixed(3)} below ${input.params.minEdge.toFixed(3)} fair=${fair.toFixed(3)} market=${marketProbability.toFixed(3)} vol5m=${(volPerInterval * 10_000).toFixed(2)}bps` };
    }

    return {
        quotes: [{
            key: `${leg}:BUY`,
            leg,
            side: "BUY",
            price: ask,
            size: input.params.orderShares,
            fair,
            edge,
            note: `undervalued-hold entry ${leg} ask=${ask.toFixed(2)} fair=${fair.toFixed(3)} market=${marketProbability.toFixed(3)} edge=${edge.toFixed(3)} vol5m=${(volPerInterval * 10_000).toFixed(2)}bps btcMargin=${directionalMarginBps.toFixed(2)}bps`,
        }],
        fairUp,
        fairDown: 1 - fairUp,
        reason: `undervalued-hold ${leg} realtime-vol edge signal`,
    };
}

export function calculateRealtimeVolPerInterval(history: Btc5mRegimeSnapshot[] | undefined, timestampMs: number, params: Pick<Btc5mUndervaluedHoldParams, "volatilityLookbackSeconds" | "volatilityMinSamples" | "minVolPerInterval" | "maxVolPerInterval">): number | undefined {
    const cutoff = timestampMs - params.volatilityLookbackSeconds * 1000;
    const buckets = new Map<number, number>();
    for (const point of history ?? []) {
        if (point.t < cutoff || point.t > timestampMs || !point.btcPrice || point.btcPrice <= 0) continue;
        buckets.set(Math.floor(point.t / 1000), point.btcPrice);
    }
    const prices = Array.from(buckets.entries()).sort((left, right) => left[0] - right[0]).map((entry) => entry[1]);
    if (prices.length < params.volatilityMinSamples) return undefined;
    const squaredReturns: number[] = [];
    for (let index = 1; index < prices.length; index++) {
        const logReturn = Math.log(prices[index] / prices[index - 1]);
        if (Number.isFinite(logReturn)) squaredReturns.push(logReturn * logReturn);
    }
    if (squaredReturns.length === 0) return undefined;
    const rmsOneSecondVol = Math.sqrt(squaredReturns.reduce((sum, value) => sum + value, 0) / squaredReturns.length);
    const volPerInterval = rmsOneSecondVol * Math.sqrt(300);
    return Math.min(params.maxVolPerInterval, Math.max(params.minVolPerInterval, volPerInterval));
}

function buildExitDecision(input: Btc5mUndervaluedHoldInput): Btc5mUndervaluedHoldDecision {
    const position = input.position!;
    if (position.exited) return { quotes: [], position, reason: "undervalued-hold exited" };
    const bid = position.leg === "UP" ? input.upBid : input.downBid;
    if (bid === undefined || bid <= 0) return { quotes: [], position, reason: "undervalued-hold holding; waiting for bid" };
    if (input.params.stopLossPct <= 0) return { quotes: [], position, reason: "undervalued-hold holding to settlement; stop loss disabled" };
    const stopPrice = position.entryPrice * (1 - input.params.stopLossPct);
    if (bid > stopPrice) {
        return { quotes: [], position, reason: `undervalued-hold holding to settlement; bid=${bid.toFixed(2)} stop=${stopPrice.toFixed(3)}` };
    }
    return {
        quotes: [{
            key: `${position.leg}:SELL`,
            leg: position.leg,
            side: "SELL",
            price: bid,
            size: position.shares,
            note: `undervalued-hold stop-loss bid=${bid.toFixed(2)} threshold=${stopPrice.toFixed(3)}`,
        }],
        position,
        reason: `undervalued-hold stop loss ${(input.params.stopLossPct * 100).toFixed(1)}%`,
    };
}
