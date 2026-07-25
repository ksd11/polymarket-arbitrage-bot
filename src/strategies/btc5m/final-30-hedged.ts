import { buildBtc5mFinal30HighOrders, Btc5mFinal30HighParams } from "./final-30-high";
import { Btc5mLeg, Btc5mStrategyDecision } from "./types";

export type Btc5mFinal30HedgedPosition = {
    leg: Btc5mLeg;
    entryPrice: number;
    shares: number;
    hedged: boolean;
};

export type Btc5mFinal30HedgedParams = Btc5mFinal30HighParams & {
    maxPairCost: number;
};

export type Btc5mFinal30HedgedInput = {
    timestampMs: number;
    endMs: number;
    upAsk?: number;
    downAsk?: number;
    position?: Btc5mFinal30HedgedPosition;
    blocked: boolean;
    params: Btc5mFinal30HedgedParams;
};

export function buildBtc5mFinal30HedgedOrders(input: Btc5mFinal30HedgedInput): Btc5mStrategyDecision {
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
    if (input.position.hedged) return { quotes: [], reason: "final-30-hedged pair locked" };
    const hedgeLeg: Btc5mLeg = input.position.leg === "UP" ? "DOWN" : "UP";
    const hedgeAsk = hedgeLeg === "UP" ? input.upAsk : input.downAsk;
    const maxHedgePrice = input.params.maxPairCost - input.position.entryPrice;
    if (maxHedgePrice <= 0 || hedgeAsk === undefined || hedgeAsk > maxHedgePrice) {
        return { quotes: [], reason: `final-30-hedged waiting for ${hedgeLeg}<=${Math.max(0, maxHedgePrice).toFixed(2)}` };
    }
    return {
        quotes: [{
            key: `${hedgeLeg}:BUY`,
            leg: hedgeLeg,
            side: "BUY",
            price: maxHedgePrice,
            size: input.position.shares,
            note: `final-30-hedged pair ${input.position.entryPrice.toFixed(2)}+${hedgeAsk.toFixed(2)}`,
        }],
        reason: `final-30-hedged lock ${hedgeLeg}`,
    };
}
