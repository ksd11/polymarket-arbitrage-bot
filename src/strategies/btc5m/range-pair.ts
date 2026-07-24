import { Btc5mLeg, Btc5mStrategyDecision } from "./types";

export type Btc5mRangePairParams = {
    firstPrice: number;
    secondPrice: number;
    maxTotalUsdc: number;
};

export type Btc5mRangePairState = {
    filledUp: boolean;
    filledDown: boolean;
    firstLeg?: Btc5mLeg;
};

export function buildBtc5mRangePairOrders(state: Btc5mRangePairState, params: Btc5mRangePairParams): Btc5mStrategyDecision {
    const size = params.maxTotalUsdc / (params.firstPrice + params.secondPrice);
    if (state.filledUp && state.filledDown) return { quotes: [], reason: "range-pair locked" };
    if (state.filledUp) {
        return { quotes: [{ key: "DOWN:BUY", leg: "DOWN", side: "BUY", price: params.secondPrice, size }], reason: "range-pair waiting for DOWN hedge" };
    }
    if (state.filledDown) {
        return { quotes: [{ key: "UP:BUY", leg: "UP", side: "BUY", price: params.secondPrice, size }], reason: "range-pair waiting for UP hedge" };
    }
    return {
        quotes: [
            { key: "UP:BUY", leg: "UP", side: "BUY", price: params.firstPrice, size },
            { key: "DOWN:BUY", leg: "DOWN", side: "BUY", price: params.firstPrice, size },
        ],
        reason: "range-pair waiting for first fill",
    };
}
