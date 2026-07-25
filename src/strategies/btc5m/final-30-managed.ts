import { buildBtc5mFinal30HighOrders, Btc5mFinal30HighParams } from "./final-30-high";
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
    position?: Btc5mFinal30ManagedPosition;
    blocked: boolean;
    params: Btc5mFinal30ManagedParams;
};

export type Btc5mFinal30ManagedDecision = Btc5mStrategyDecision & {
    position?: Btc5mFinal30ManagedPosition;
};

export function buildBtc5mFinal30ManagedOrders(input: Btc5mFinal30ManagedInput): Btc5mFinal30ManagedDecision {
    if (!input.position) {
        return buildBtc5mFinal30HighOrders({
            timestampMs: input.timestampMs,
            endMs: input.endMs,
            upAsk: input.upAsk,
            downAsk: input.downAsk,
            entered: input.blocked,
            params: input.params,
        });
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
