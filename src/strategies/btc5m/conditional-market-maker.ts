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
    const metrics = calculateConditionalMarketMetrics(input.timestampMs, input.btcPrice, input.history, input.conditionalParams);
    if (!metrics) return { quotes: [], reason: "insufficient BTC history" };
    if (Math.abs(metrics.accelerationBps) >= input.conditionalParams.maxAccelerationBps) {
        return { quotes: [], reason: `rapid BTC move ${metrics.accelerationBps.toFixed(2)}bps`, metrics };
    }
    if (metrics.rangeBps > input.conditionalParams.maxRangeBps) {
        return { quotes: [], reason: `BTC range too wide ${metrics.rangeBps.toFixed(2)}bps`, metrics };
    }
    if (Math.abs(metrics.momentumBps) > input.conditionalParams.maxTrendBps) {
        return { quotes: [], reason: `BTC trend too strong ${metrics.momentumBps.toFixed(2)}bps`, metrics };
    }
    if (metrics.trendEfficiency > input.conditionalParams.maxTrendEfficiency && Math.abs(metrics.momentumBps) >= input.conditionalParams.trendEfficiencyMinMomentumBps) {
        return { quotes: [], reason: `BTC trend efficiency too high ${metrics.trendEfficiency.toFixed(2)}`, metrics };
    }

    const base = buildBtc5mMarketMakerQuotes(input);
    const netInventory = input.state.qUp - input.state.qDown;
    const quotes = base.quotes.flatMap((quote) => skewQuote(quote, metrics.favoredLeg, netInventory, input));
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
    if (size <= 0 || price * size + 1e-9 < conditionalParams.minOrderUsdc) return [];
    return [{ ...quote, price, size, edge: quote.fair === undefined ? quote.edge : quote.fair - price, note: directional ? `${favored ? "favored" : "unfavored"} conditional quote` : "symmetric conditional quote" }];
}

function closestAtOrBefore(samples: Btc5mConditionalMarketMakerSample[], timestampMs: number): Btc5mConditionalMarketMakerSample | undefined {
    let match: Btc5mConditionalMarketMakerSample | undefined;
    for (const sample of samples) {
        if (sample.timestampMs > timestampMs) break;
        match = sample;
    }
    return match;
}

function roundToTick(value: number, tick: number): number {
    const decimals = (tick.toString().split(".")[1] ?? "").length;
    return Number((Math.floor((value + 1e-9) / tick) * tick).toFixed(decimals));
}
