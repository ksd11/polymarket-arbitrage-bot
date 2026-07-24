import { Btc5mLeg, Btc5mStrategyDecision } from "./types";

export type Btc5mFinal30HighParams = {
    triggerPrice: number;
    earlyTriggerPrice: number;
    maxEntryPrice: number;
    orderShares: number;
    maxSecondsLeftToOpen: number;
    earlyMaxSecondsLeftToOpen: number;
    minSecondsLeftToOpen: number;
};

export type Btc5mFinal30HighInput = {
    timestampMs: number;
    endMs: number;
    upAsk?: number;
    downAsk?: number;
    entered: boolean;
    params: Btc5mFinal30HighParams;
};

export function buildBtc5mFinal30HighOrders(input: Btc5mFinal30HighInput): Btc5mStrategyDecision {
    if (input.entered) return { quotes: [], reason: "final-30-high already entered" };
    const secondsLeft = Math.max(0, (input.endMs - input.timestampMs) / 1000);
    if (secondsLeft > input.params.earlyMaxSecondsLeftToOpen || secondsLeft < input.params.minSecondsLeftToOpen) {
        return { quotes: [], reason: "final-30-high outside entry window" };
    }
    const triggerPrice = secondsLeft > input.params.maxSecondsLeftToOpen ? input.params.earlyTriggerPrice : input.params.triggerPrice;
    const observedHigh = Math.max(input.upAsk ?? 0, input.downAsk ?? 0);
    if (observedHigh >= triggerPrice && observedHigh > input.params.maxEntryPrice) {
        return { quotes: [], reason: `final-30-high blocked: ask ${observedHigh.toFixed(2)} above max ${input.params.maxEntryPrice.toFixed(2)}` };
    }
    const candidates = ([
        ["UP", input.upAsk],
        ["DOWN", input.downAsk],
    ] as const).filter((item): item is readonly [Btc5mLeg, number] => item[1] !== undefined && item[1] >= triggerPrice && item[1] <= input.params.maxEntryPrice);
    const selected = candidates.sort((left, right) => right[1] - left[1])[0];
    if (!selected) return { quotes: [], reason: "final-30-high waiting for probability" };
    const [leg, ask] = selected;
    return {
        quotes: [{ key: `${leg}:BUY`, leg, side: "BUY", price: ask, size: input.params.orderShares, note: `final-30-high entry ask=${ask.toFixed(2)}` }],
        reason: `final-30-high ${leg} signal`,
    };
}
