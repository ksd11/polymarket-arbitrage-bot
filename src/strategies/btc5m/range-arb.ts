import { Btc5mStrategyDecision, Btc5mStrategyQuote } from "./types";

export type Btc5mRangeArbParams = {
    priceX: number;
    usdcPerLeg: number;
};

export type Btc5mRangeArbInput = {
    upAsk: number;
    downAsk: number;
    hasUpPosition: boolean;
    hasDownPosition: boolean;
    params: Btc5mRangeArbParams;
};

export function buildBtc5mRangeArbOrders(input: Btc5mRangeArbInput): Btc5mStrategyDecision {
    const quotes: Btc5mStrategyQuote[] = [];
    const size = input.params.usdcPerLeg / input.params.priceX;
    if (!input.hasUpPosition && input.upAsk <= input.params.priceX) {
        quotes.push({ key: "UP:BUY", leg: "UP", side: "BUY", price: input.params.priceX, size, edge: 1 - 2 * input.params.priceX });
    }
    if (!input.hasDownPosition && input.downAsk <= input.params.priceX) {
        quotes.push({ key: "DOWN:BUY", leg: "DOWN", side: "BUY", price: input.params.priceX, size, edge: 1 - 2 * input.params.priceX });
    }
    return { quotes };
}
