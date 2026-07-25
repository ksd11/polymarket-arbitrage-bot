import {
    buildBtc5mDynamicRangePullbackOrders,
    Btc5mDynamicRangePullbackInput,
    Btc5mDynamicRangePullbackState,
} from "./dynamic-range-pullback";
import {
    buildBtc5mFinal30ManagedOrders,
    Btc5mFinal30ManagedParams,
    Btc5mFinal30ManagedPosition,
} from "./final-30-managed";
import { Btc5mStrategyDecision } from "./types";

export type Btc5mDynamicRangeFinalManagedInput = Btc5mDynamicRangePullbackInput & {
    finalPosition?: Btc5mFinal30ManagedPosition;
    finalBlocked: boolean;
    finalParams: Btc5mFinal30ManagedParams;
};

export type Btc5mDynamicRangeFinalManagedDecision = Btc5mStrategyDecision & {
    component: "dynamic" | "final" | "idle";
    dynamicState: Btc5mDynamicRangePullbackState;
    finalPosition?: Btc5mFinal30ManagedPosition;
};

export function buildBtc5mDynamicRangeFinalManagedOrders(input: Btc5mDynamicRangeFinalManagedInput): Btc5mDynamicRangeFinalManagedDecision {
    if (input.finalPosition) return buildFinalDecision(input);
    if (input.state.paired) {
        return {
            quotes: [],
            component: "idle",
            dynamicState: input.state,
            reason: "dynamic-range-final-managed pair already locked",
        };
    }
    const dynamicPositionActive = input.state.entryLeg !== undefined && !input.state.exited;
    if (dynamicPositionActive) return buildDynamicDecision(input);
    const secondsLeft = Math.max(0, (input.endMs - input.timestampMs) / 1000);
    if (secondsLeft <= input.finalParams.earlyMaxSecondsLeftToOpen) return buildFinalDecision(input);
    return buildDynamicDecision(input);
}

function buildDynamicDecision(input: Btc5mDynamicRangeFinalManagedInput): Btc5mDynamicRangeFinalManagedDecision {
    const decision = buildBtc5mDynamicRangePullbackOrders(input);
    return {
        ...decision,
        component: "dynamic",
        dynamicState: decision.state,
        finalPosition: input.finalPosition,
    };
}

function buildFinalDecision(input: Btc5mDynamicRangeFinalManagedInput): Btc5mDynamicRangeFinalManagedDecision {
    const decision = buildBtc5mFinal30ManagedOrders({
        timestampMs: input.timestampMs,
        endMs: input.endMs,
        upAsk: input.upAsk,
        downAsk: input.downAsk,
        upBid: input.upBid,
        downBid: input.downBid,
        btcPrice: input.btcPrice,
        openPrice: input.openPrice,
        position: input.finalPosition,
        blocked: input.finalBlocked,
        params: input.finalParams,
    });
    return {
        ...decision,
        component: "final",
        dynamicState: input.state,
        finalPosition: decision.position,
    };
}
