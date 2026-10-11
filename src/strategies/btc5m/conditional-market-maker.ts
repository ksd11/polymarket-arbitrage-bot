import { buildBtc5mMarketMakerQuotes, Btc5mMarketMakerInput } from "./market-maker";
import { Btc5mLeg, Btc5mStrategyDecision, Btc5mStrategyQuote, clamp } from "./types";

export type Btc5mConditionalMarketMakerSample = {
    timestampMs: number;
    btcPrice: number;
};

export type Btc5mConditionalMarketMakerParams = {
    lookbackSeconds: number;
    accelerationLookbackSeconds: number;
    maxRangeBps: number;
    maxTrendBps: number;
    maxTrendEfficiency: number;
    trendEfficiencyMinMomentumBps: number;
    maxAccelerationBps: number;
    directionMinMomentumBps: number;
    favoredPriceImprove: number;
    unfavoredPriceOffset: number;
    favoredSizeMultiplier: number;
    unfavoredSizeMultiplier: number;
    maxNetInventoryShares: number;
    minOrderUsdc: number;
    minOrderShares: number;
    minSellProfit: number;
    forceFlattenSecondsBeforeEnd: number;
    maxUnpairedSeconds: number;
    pairOrderMaxAgeSeconds: number;
    // 可选：买单价格上限（cmm 不使用，cmm-v2 用于只买低价腿）。
    maxBidPrice?: number;
    minBidPrice?: number;
    minSecondsLeftToBuy?: number;
    buyLegsOnly?: "BOTH" | "UP" | "DOWN";
};

export type Btc5mConditionalMarketMakerInput = Btc5mMarketMakerInput & {
    timestampMs: number;
    btcPrice?: number;
    history: Btc5mConditionalMarketMakerSample[];
    conditionalParams: Btc5mConditionalMarketMakerParams;
};

export type Btc5mConditionalMarketMetrics = {
    momentumBps: number;
    accelerationBps: number;
    rangeBps: number;
    trendEfficiency: number;
    favoredLeg?: Btc5mLeg;
};

export function buildBtc5mConditionalMarketMakerQuotes(input: Btc5mConditionalMarketMakerInput): Btc5mStrategyDecision & { metrics?: Btc5mConditionalMarketMetrics } {
    const base = buildBtc5mMarketMakerQuotes(input);
    const recovery = buildInventoryRecoveryQuote(input);
    if (recovery) return { ...base, quotes: [recovery], reason: recovery.note };
    const metrics = calculateConditionalMarketMetrics(input.timestampMs, input.btcPrice, input.history, input.conditionalParams);
    if (!metrics) return retainProtectedSells(base, input, "insufficient BTC history");
    if (Math.abs(metrics.accelerationBps) >= input.conditionalParams.maxAccelerationBps) {
        return retainProtectedSells(base, input, `rapid BTC move ${metrics.accelerationBps.toFixed(2)}bps`, metrics);
    }
    if (metrics.rangeBps > input.conditionalParams.maxRangeBps) {
        return retainProtectedSells(base, input, `BTC range too wide ${metrics.rangeBps.toFixed(2)}bps`, metrics);
    }
    if (Math.abs(metrics.momentumBps) > input.conditionalParams.maxTrendBps) {
        return retainProtectedSells(base, input, `BTC trend too strong ${metrics.momentumBps.toFixed(2)}bps`, metrics);
    }
    if (metrics.trendEfficiency > input.conditionalParams.maxTrendEfficiency && Math.abs(metrics.momentumBps) >= input.conditionalParams.trendEfficiencyMinMomentumBps) {
        return retainProtectedSells(base, input, `BTC trend efficiency too high ${metrics.trendEfficiency.toFixed(2)}`, metrics);
    }

    const netInventory = input.state.qUp - input.state.qDown;
    let quotes = base.quotes
        .flatMap((quote) => skewQuote(quote, metrics.favoredLeg, netInventory, input))
        .flatMap((quote) => {
            const protectedQuote = protectSellPrice(quote, input);
            return protectedQuote ? [protectedQuote] : [];
        });
    if (input.state.entryAttempted) quotes = quotes.filter((quote) => quote.side !== "BUY");
    const desiredBuyCount = input.state.entryAttempted ? 0 : base.quotes.filter((quote) => quote.side === "BUY").length;
    const validBuyCount = quotes.filter((quote) => quote.side === "BUY").length;
    if (desiredBuyCount === 2 && validBuyCount < 2) quotes = quotes.filter((quote) => quote.side !== "BUY");
    const buyUp = quotes.find((quote) => quote.side === "BUY" && quote.leg === "UP")?.price;
    const buyDown = quotes.find((quote) => quote.side === "BUY" && quote.leg === "DOWN")?.price;
    return {
        ...base,
        quotes,
        bidCost: buyUp !== undefined && buyDown !== undefined ? buyUp + buyDown : undefined,
        reason: metrics.favoredLeg ? `conditional skew ${metrics.favoredLeg} momentum=${metrics.momentumBps.toFixed(2)}bps` : "conditional symmetric quote",
        metrics,
    };
}

function buildInventoryRecoveryQuote(input: Btc5mConditionalMarketMakerInput): Btc5mStrategyQuote | undefined {
    const imbalance = input.state.qUp - input.state.qDown;
    if (Math.abs(imbalance) + 1e-9 < input.conditionalParams.minOrderShares) return undefined;

    const heldLeg: Btc5mLeg = imbalance > 0 ? "UP" : "DOWN";
    const hedgeLeg: Btc5mLeg = heldLeg === "UP" ? "DOWN" : "UP";
    const shares = Math.abs(imbalance);
    const heldShares = heldLeg === "UP" ? input.state.qUp : input.state.qDown;
    const heldCost = heldLeg === "UP" ? input.state.positionCostUp : input.state.positionCostDown;
    if (!heldCost || heldShares <= 0) return undefined;

    const averageCost = heldCost / heldShares;
    const heldPrice = heldLeg === "UP" ? input.up : input.down;
    const hedgePrice = hedgeLeg === "UP" ? input.up : input.down;
    const unpairedSeconds = input.state.unpairedSinceMs === undefined ? 0 : (input.timestampMs - input.state.unpairedSinceMs) / 1000;
    if (input.secondsLeft <= input.conditionalParams.forceFlattenSecondsBeforeEnd || unpairedSeconds >= input.conditionalParams.maxUnpairedSeconds) {
        const sellPrice = heldPrice?.bestBid ?? undefined;
        const buyPrice = hedgePrice?.bestAsk ?? undefined;
        const sellLoss = sellPrice === undefined ? Number.POSITIVE_INFINITY : averageCost - sellPrice;
        const hedgeLoss = buyPrice === undefined ? Number.POSITIVE_INFINITY : averageCost + buyPrice - 1;
        if (sellLoss <= hedgeLoss && sellPrice !== undefined) {
            return {
                key: `${heldLeg}:SELL`, leg: heldLeg, side: "SELL",
                tokenId: heldLeg === "UP" ? input.upTokenId : input.downTokenId,
                price: roundToTick(sellPrice, input.params.tick), size: shares,
                note: `emergency flatten ${heldLeg} before settlement`,
            };
        }
        if (buyPrice !== undefined && canFundHedge(input, hedgeLeg, shares, buyPrice)) {
            return {
                key: `${hedgeLeg}:BUY`, leg: hedgeLeg, side: "BUY",
                tokenId: hedgeLeg === "UP" ? input.upTokenId : input.downTokenId,
                price: roundToTick(buyPrice, input.params.tick, "ceil"), size: shares,
                note: `emergency hedge ${hedgeLeg} before settlement`,
            };
        }
        return undefined;
    }

    const maximumHedgePrice = roundToTick(1 - averageCost - input.params.minLockedEdge, input.params.tick);
    if (maximumHedgePrice < input.params.tick || !canFundHedge(input, hedgeLeg, shares, maximumHedgePrice)) return undefined;
    return {
        key: `${hedgeLeg}:BUY`, leg: hedgeLeg, side: "BUY",
        tokenId: hedgeLeg === "UP" ? input.upTokenId : input.downTokenId,
        price: maximumHedgePrice, size: shares,
        note: `inventory rescue ${hedgeLeg}, locked edge>=${input.params.minLockedEdge.toFixed(4)}`,
    };
}

function canFundHedge(input: Btc5mConditionalMarketMakerInput, leg: Btc5mLeg, shares: number, price: number): boolean {
    const spent = leg === "UP" ? input.state.buyCostUp : input.state.buyCostDown;
    const pending = leg === "UP" ? input.state.pendingBuyNotionalUp ?? 0 : input.state.pendingBuyNotionalDown ?? 0;
    return input.params.maxUsdcPerLeg <= 0 || spent + pending + shares * price <= input.params.maxUsdcPerLeg + 1e-9;
}

function retainProtectedSells(
    base: Btc5mStrategyDecision,
    input: Btc5mConditionalMarketMakerInput,
    reason: string,
    metrics?: Btc5mConditionalMarketMetrics,
): Btc5mStrategyDecision & { metrics?: Btc5mConditionalMarketMetrics } {
    const quotes = base.quotes.flatMap((quote) => {
        if (quote.side !== "SELL") return [];
        const protectedQuote = protectSellPrice(quote, input);
        return protectedQuote ? [protectedQuote] : [];
    });
    return { ...base, quotes, reason, metrics };
}

export function calculateConditionalMarketMetrics(
    timestampMs: number,
    btcPrice: number | undefined,
    history: Btc5mConditionalMarketMakerSample[],
    params: Btc5mConditionalMarketMakerParams,
): Btc5mConditionalMarketMetrics | undefined {
    if (!btcPrice || btcPrice <= 0) return undefined;
    const startMs = timestampMs - params.lookbackSeconds * 1000;
    const samples = history.filter((sample) => sample.timestampMs >= startMs && sample.timestampMs <= timestampMs && sample.btcPrice > 0);
    if (samples.length < 3 || samples[0].timestampMs > startMs + 2000) return undefined;
    const first = samples[0].btcPrice;
    const momentumBps = (btcPrice / first - 1) * 10_000;
    const accelerationStartMs = timestampMs - params.accelerationLookbackSeconds * 1000;
    const accelerationSample = closestAtOrBefore(samples, accelerationStartMs) ?? samples[0];
    const accelerationBps = (btcPrice / accelerationSample.btcPrice - 1) * 10_000;
    const prices = samples.map((sample) => sample.btcPrice).concat(btcPrice);
    const rangeBps = (Math.max(...prices) / Math.min(...prices) - 1) * 10_000;
    let pathBps = 0;
    for (let index = 1; index < samples.length; index++) {
        pathBps += Math.abs((samples[index].btcPrice / samples[index - 1].btcPrice - 1) * 10_000);
    }
    const trendEfficiency = pathBps > 0 ? Math.min(1, Math.abs(momentumBps) / pathBps) : 0;
    const favoredLeg = Math.abs(momentumBps) >= params.directionMinMomentumBps ? (momentumBps > 0 ? "UP" : "DOWN") : undefined;
    return { momentumBps, accelerationBps, rangeBps, trendEfficiency, favoredLeg };
}

function skewQuote(
    quote: Btc5mStrategyQuote,
    favoredLeg: Btc5mLeg | undefined,
    netInventory: number,
    input: Btc5mConditionalMarketMakerInput,
): Btc5mStrategyQuote[] {
    if (quote.side !== "BUY") return [quote];
    const { conditionalParams, params } = input;
    const sameDirectionInventory = quote.leg === "UP" ? netInventory : -netInventory;
    if (sameDirectionInventory >= conditionalParams.maxNetInventoryShares) return [];
    const directional = favoredLeg !== undefined;
    const favored = quote.leg === favoredLeg;
    const rawPrice = directional ? quote.price + (favored ? conditionalParams.favoredPriceImprove : -conditionalParams.unfavoredPriceOffset) : quote.price;
    const price = roundToTick(clamp(rawPrice, params.tick, 1 - params.tick), params.tick);
    const sizeMultiplier = directional ? (favored ? conditionalParams.favoredSizeMultiplier : conditionalParams.unfavoredSizeMultiplier) : 1;
    const inventoryCapacity = Math.max(0, conditionalParams.maxNetInventoryShares - sameDirectionInventory);
    const size = Math.min(quote.size * sizeMultiplier, inventoryCapacity);
    if (size + 1e-9 < conditionalParams.minOrderShares || price * size + 1e-9 < conditionalParams.minOrderUsdc) return [];
    return [{ ...quote, price, size, edge: quote.fair === undefined ? quote.edge : quote.fair - price, note: directional ? `${favored ? "favored" : "unfavored"} conditional quote` : "symmetric conditional quote" }];
}

function protectSellPrice(quote: Btc5mStrategyQuote, input: Btc5mConditionalMarketMakerInput): Btc5mStrategyQuote | undefined {
    if (quote.side !== "SELL") return quote;
    const shares = quote.leg === "UP" ? input.state.qUp : input.state.qDown;
    const positionCost = quote.leg === "UP" ? input.state.positionCostUp : input.state.positionCostDown;
    if (!positionCost || shares <= 0) return quote;
    const averageCost = positionCost / shares;
    const rawMinimumPrice = averageCost + input.conditionalParams.minSellProfit;
    if (rawMinimumPrice > 1 - input.params.tick + 1e-9) return undefined;
    const minimumPrice = roundToTick(rawMinimumPrice, input.params.tick, "ceil");
    if (quote.price >= minimumPrice) return quote;
    return {
        ...quote,
        price: minimumPrice,
        edge: quote.fair === undefined ? quote.edge : quote.fair - minimumPrice,
        note: `cost-protected sell avg=${averageCost.toFixed(4)}`,
    };
}

function closestAtOrBefore(samples: Btc5mConditionalMarketMakerSample[], timestampMs: number): Btc5mConditionalMarketMakerSample | undefined {
    let match: Btc5mConditionalMarketMakerSample | undefined;
    for (const sample of samples) {
        if (sample.timestampMs > timestampMs) break;
        match = sample;
    }
    return match;
}

function roundToTick(value: number, tick: number, mode: "floor" | "ceil" = "floor"): number {
    const decimals = (tick.toString().split(".")[1] ?? "").length;
    const rounded = mode === "floor" ? Math.floor((value + 1e-9) / tick) : Math.ceil((value - 1e-9) / tick);
    return Number(clamp(rounded * tick, tick, 1 - tick).toFixed(decimals));
}
