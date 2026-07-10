import { Btc5mPrice, Btc5mStrategyDecision, Btc5mStrategyQuote, clamp, midFromPrice } from "./types";

export type Btc5mMarketMakerParams = {
    quoteShares: number;
    maxUsdcPerLeg: number;
    maxInventoryShares: number;
    quoteSpread: number;
    minLockedEdge: number;
    inventorySkewPerShare: number;
    enableSellExcess: boolean;
    minSecondsLeftToQuote: number;
    tick: number;
};

export type Btc5mMarketMakerState = {
    qUp: number;
    qDown: number;
    buyCostUp: number;
    buyCostDown: number;
    pendingBuyNotionalUp?: number;
    pendingBuyNotionalDown?: number;
};

export type Btc5mMarketMakerInput = {
    up: Btc5mPrice | null;
    down: Btc5mPrice | null;
    upTokenId?: string;
    downTokenId?: string;
    secondsLeft: number;
    params: Btc5mMarketMakerParams;
    state: Btc5mMarketMakerState;
};

export function buildBtc5mMarketMakerQuotes(input: Btc5mMarketMakerInput): Btc5mStrategyDecision {
    const upMid = midFromPrice(input.up);
    const downMid = midFromPrice(input.down);
    if (upMid === undefined && downMid === undefined) return { quotes: [], reason: "missing prices" };

    const { params, state } = input;
    const fairUp = clamp(upMid !== undefined && downMid !== undefined ? (upMid + (1 - downMid)) / 2 : upMid ?? 1 - (downMid as number), params.tick, 1 - params.tick);
    const fairDown = 1 - fairUp;
    const netInventory = state.qUp - state.qDown;
    const inventorySkew = params.inventorySkewPerShare * netInventory;
    const bidUp = roundToTick(fairUp - params.quoteSpread / 2 - inventorySkew, params.tick, "floor");
    const bidDown = roundToTick(fairDown - params.quoteSpread / 2 + inventorySkew, params.tick, "floor");
    const bidCost = bidUp + bidDown;
    const quotes: Btc5mStrategyQuote[] = [];

    if (input.secondsLeft >= params.minSecondsLeftToQuote && bidCost <= 1 - params.minLockedEdge) {
        const buyCapacity = params.maxInventoryShares - Math.max(state.qUp, state.qDown);
        const upBuySize = Math.min(params.quoteShares, buyCapacity, buyBudgetSize(params, state.buyCostUp, state.pendingBuyNotionalUp ?? 0, bidUp));
        const downBuySize = Math.min(params.quoteShares, buyCapacity, buyBudgetSize(params, state.buyCostDown, state.pendingBuyNotionalDown ?? 0, bidDown));
        if (upBuySize > 0) quotes.push({ key: "UP:BUY", leg: "UP", side: "BUY", tokenId: input.upTokenId, price: bidUp, size: upBuySize, fair: fairUp, edge: fairUp - bidUp });
        if (downBuySize > 0) quotes.push({ key: "DOWN:BUY", leg: "DOWN", side: "BUY", tokenId: input.downTokenId, price: bidDown, size: downBuySize, fair: fairDown, edge: fairDown - bidDown });
    }

    if (params.enableSellExcess) {
        const askUp = roundToTick(fairUp + params.quoteSpread / 2 - inventorySkew, params.tick, "ceil");
        const askDown = roundToTick(fairDown + params.quoteSpread / 2 + inventorySkew, params.tick, "ceil");
        const sellUpSize = Math.min(params.quoteShares, Math.max(0, state.qUp - state.qDown));
        const sellDownSize = Math.min(params.quoteShares, Math.max(0, state.qDown - state.qUp));
        if (sellUpSize > 0) quotes.push({ key: "UP:SELL", leg: "UP", side: "SELL", tokenId: input.upTokenId, price: askUp, size: sellUpSize, fair: fairUp });
        if (sellDownSize > 0) quotes.push({ key: "DOWN:SELL", leg: "DOWN", side: "SELL", tokenId: input.downTokenId, price: askDown, size: sellDownSize, fair: fairDown });
    }

    return { quotes, fairUp, fairDown, bidCost };
}

function buyBudgetSize(params: Btc5mMarketMakerParams, spent: number, reserved: number, price: number): number {
    if (params.maxUsdcPerLeg <= 0) return Number.POSITIVE_INFINITY;
    const available = params.maxUsdcPerLeg - spent - reserved;
    if (available <= 0) return 0;
    return available / price;
}

function roundToTick(price: number, tick: number, mode: "floor" | "ceil"): number {
    const rounded = mode === "floor" ? Math.floor(price / tick) * tick : Math.ceil(price / tick) * tick;
    return Number(clamp(rounded, tick, 1 - tick).toFixed(tickDecimals(tick)));
}

function tickDecimals(tick: number): number {
    const [, fraction = ""] = tick.toString().split(".");
    return fraction.length;
}
