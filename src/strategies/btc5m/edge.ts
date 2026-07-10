import { Btc5mLeg, Btc5mStrategyDecision, Btc5mStrategyQuote } from "./types";

export type Btc5mEdgeParams = {
    intervalMinutes: number;
    volPerInterval: number;
    minEdge: number;
    orderUsdc: number;
    maxUsdcPerLeg: number;
    maxPrice: number;
};

export type Btc5mEdgeInput = {
    timestampMs: number;
    endMs: number;
    btcPrice?: number;
    openPrice?: number;
    upAsk: number;
    downAsk: number;
    spentUp: number;
    spentDown: number;
    params: Btc5mEdgeParams;
};

export function buildBtc5mEdgeOrders(input: Btc5mEdgeInput): Btc5mStrategyDecision {
    if (input.btcPrice === undefined || input.openPrice === undefined) {
        throw new Error("edge strategy requires btc_price and open_price columns. Use --strategy range-arb or --strategy market-maker for Polymarket-only data.");
    }
    const fairUp = fairUpProbability(input.btcPrice, input.openPrice, input.endMs - input.timestampMs, input.params);
    const fairDown = 1 - fairUp;
    const quotes: Btc5mStrategyQuote[] = [];
    maybeBuy(quotes, "UP", input.upAsk, fairUp, input.spentUp, input.params);
    maybeBuy(quotes, "DOWN", input.downAsk, fairDown, input.spentDown, input.params);
    return { quotes, fairUp, fairDown };
}

export function fairUpProbability(btcPrice: number, openPrice: number, msLeft: number, params: Pick<Btc5mEdgeParams, "intervalMinutes" | "volPerInterval">): number {
    const secondsLeft = Math.max(1, msLeft / 1000);
    const intervalSeconds = params.intervalMinutes * 60;
    const expectedMove = openPrice * params.volPerInterval * Math.sqrt(secondsLeft / intervalSeconds);
    if (expectedMove <= 0) return 0.5;
    return Math.min(0.995, Math.max(0.005, normalCdf((btcPrice - openPrice) / expectedMove)));
}

function maybeBuy(quotes: Btc5mStrategyQuote[], leg: Btc5mLeg, ask: number, fair: number, spent: number, params: Btc5mEdgeParams): void {
    if (!(ask > 0 && ask <= params.maxPrice)) return;
    const edge = fair - ask;
    if (edge < params.minEdge) return;
    const budgetLeft = params.maxUsdcPerLeg > 0 ? Math.max(0, params.maxUsdcPerLeg - spent) : params.orderUsdc;
    const cost = Math.min(params.orderUsdc, budgetLeft);
    if (cost <= 0) return;
    quotes.push({ key: `${leg}:BUY`, leg, side: "BUY", price: ask, size: cost / ask, fair, edge });
}

function normalCdf(x: number): number {
    return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const t = 1 / (1 + p * absX);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
    return sign * y;
}
