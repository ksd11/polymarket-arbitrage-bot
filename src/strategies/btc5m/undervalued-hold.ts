import { Btc5mLeg, Btc5mStrategyDecision } from "./types";

export type Btc5mUndervaluedHoldParams = {
    minEntryPrice: number;
    maxEntryPrice: number;
    orderShares: number;
    minSecondsLeftToOpen: number;
    maxSecondsLeftToOpen: number;
    minDirectionalBtcMarginBps: number;
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
    if (ask === undefined || ask <= input.params.minEntryPrice || ask >= input.params.maxEntryPrice) {
        return { quotes: [], reason: `undervalued-hold ${leg} ask ${ask?.toFixed(2) ?? "n/a"} outside (${input.params.minEntryPrice.toFixed(2)}, ${input.params.maxEntryPrice.toFixed(2)})` };
    }

    return {
        quotes: [{
            key: `${leg}:BUY`,
            leg,
            side: "BUY",
            price: ask,
            size: input.params.orderShares,
            note: `undervalued-hold entry ${leg} ask=${ask.toFixed(2)} btcMargin=${directionalMarginBps.toFixed(2)}bps`,
        }],
        reason: `undervalued-hold ${leg} underpriced versus BTC direction`,
    };
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
