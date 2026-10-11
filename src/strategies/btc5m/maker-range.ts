import { Btc5mLeg } from "./types";

export type Btc5mMakerRangeParams = {
    price: number;
    shares: number;
    maxUnpairedSeconds: number;
    stopLossDelta: number;
    forceExitSecondsLeft: number;
    takerFeeRate: number;
    makerRebateRate: number;
};

export type Btc5mMakerRangeRiskInput = {
    heldLeg: Btc5mLeg;
    heldBid?: number;
    firstFillAtMs: number;
    timestampMs: number;
    secondsLeft: number;
    params: Btc5mMakerRangeParams;
};

export type Btc5mMakerRangeRiskDecision = {
    exit: boolean;
    reason?: "stop-loss" | "unpaired-timeout" | "force-exit";
};

export function evaluateBtc5mMakerRangeRisk(input: Btc5mMakerRangeRiskInput): Btc5mMakerRangeRiskDecision {
    if (input.secondsLeft <= input.params.forceExitSecondsLeft) return { exit: true, reason: "force-exit" };
    const unpairedSeconds = (input.timestampMs - input.firstFillAtMs) / 1000;
    if (unpairedSeconds >= input.params.maxUnpairedSeconds) return { exit: true, reason: "unpaired-timeout" };
    const stopPrice = input.params.price - input.params.stopLossDelta;
    if (input.heldBid !== undefined && input.heldBid <= stopPrice + 1e-9) return { exit: true, reason: "stop-loss" };
    return { exit: false };
}

export function polymarketFeeEquivalent(shares: number, price: number, feeRate: number): number {
    return shares * feeRate * price * (1 - price);
}

export function estimatedMakerRebate(shares: number, price: number, params: Pick<Btc5mMakerRangeParams, "takerFeeRate" | "makerRebateRate">): number {
    return polymarketFeeEquivalent(shares, price, params.takerFeeRate) * params.makerRebateRate;
}
