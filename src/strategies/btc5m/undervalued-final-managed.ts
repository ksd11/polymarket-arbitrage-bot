import { Btc5mFinal30ManagedParams, Btc5mFinal30ManagedPosition, buildBtc5mFinal30ManagedOrders } from "./final-30-managed";
import { Btc5mRegimeSnapshot } from "./regime";
import { Btc5mStrategyDecision } from "./types";
import { Btc5mUndervaluedHoldParams, Btc5mUndervaluedHoldPosition, buildBtc5mUndervaluedHoldOrders } from "./undervalued-hold";

export type Btc5mUndervaluedFinalManagedInput = {
    timestampMs: number;
    endMs: number;
    btcPrice?: number;
    openPrice?: number;
    upAsk?: number;
    downAsk?: number;
    upBid?: number;
    downBid?: number;
    history?: Btc5mRegimeSnapshot[];
    undervaluedPosition?: Btc5mUndervaluedHoldPosition;
    undervaluedBlocked: boolean;
    undervaluedParams: Btc5mUndervaluedHoldParams;
    finalPosition?: Btc5mFinal30ManagedPosition;
    finalBlocked: boolean;
    finalParams: Btc5mFinal30ManagedParams;
};

export type Btc5mUndervaluedFinalManagedDecision = Btc5mStrategyDecision & {
    component: "undervalued" | "final" | "idle";
    undervaluedPosition?: Btc5mUndervaluedHoldPosition;
    finalPosition?: Btc5mFinal30ManagedPosition;
};

export function buildBtc5mUndervaluedFinalManagedOrders(input: Btc5mUndervaluedFinalManagedInput): Btc5mUndervaluedFinalManagedDecision {
    if (input.finalPosition && !input.finalPosition.exited) return buildFinalDecision(input);
    if (input.undervaluedPosition && !input.undervaluedPosition.exited) return buildUndervaluedDecision(input);
    const secondsLeft = Math.max(0, (input.endMs - input.timestampMs) / 1000);
    if (secondsLeft <= input.finalParams.earlyMaxSecondsLeftToOpen) return buildFinalDecision(input);
    if (input.undervaluedPosition?.exited) {
        return { quotes: [], component: "idle", undervaluedPosition: input.undervaluedPosition, finalPosition: input.finalPosition, reason: "undervalued-final-managed waiting for final window after stop" };
    }
    return buildUndervaluedDecision(input);
}

function buildUndervaluedDecision(input: Btc5mUndervaluedFinalManagedInput): Btc5mUndervaluedFinalManagedDecision {
    const decision = buildBtc5mUndervaluedHoldOrders({
        timestampMs: input.timestampMs,
        endMs: input.endMs,
        btcPrice: input.btcPrice,
        openPrice: input.openPrice,
        upAsk: input.upAsk,
        downAsk: input.downAsk,
        upBid: input.upBid,
        downBid: input.downBid,
        history: input.history,
        position: input.undervaluedPosition,
        blocked: input.undervaluedBlocked,
        params: input.undervaluedParams,
    });
    return { ...decision, component: "undervalued", undervaluedPosition: decision.position, finalPosition: input.finalPosition };
}

function buildFinalDecision(input: Btc5mUndervaluedFinalManagedInput): Btc5mUndervaluedFinalManagedDecision {
    const decision = buildBtc5mFinal30ManagedOrders({
        timestampMs: input.timestampMs,
        endMs: input.endMs,
        upAsk: input.upAsk,
        downAsk: input.downAsk,
        upBid: input.upBid,
        downBid: input.downBid,
        btcPrice: input.btcPrice,
        openPrice: input.openPrice,
        history: input.history,
        position: input.finalPosition,
        blocked: input.finalBlocked,
        params: input.finalParams,
    });
    return { ...decision, component: "final", undervaluedPosition: input.undervaluedPosition, finalPosition: decision.position };
}
