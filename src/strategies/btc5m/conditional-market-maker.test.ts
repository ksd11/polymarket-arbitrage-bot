import assert from "node:assert/strict";
import test from "node:test";
import { buildBtc5mConditionalMarketMakerQuotes, Btc5mConditionalMarketMakerParams } from "./conditional-market-maker";

const conditionalParams: Btc5mConditionalMarketMakerParams = {
    lookbackSeconds: 10,
    accelerationLookbackSeconds: 2,
    maxRangeBps: 12,
    maxTrendBps: 8,
    maxTrendEfficiency: 0.8,
    trendEfficiencyMinMomentumBps: 2,
    maxAccelerationBps: 4,
    directionMinMomentumBps: 1,
    favoredPriceImprove: 0.01,
    unfavoredPriceOffset: 0.02,
    favoredSizeMultiplier: 1.5,
    unfavoredSizeMultiplier: 0.5,
    maxNetInventoryShares: 10,
    minOrderUsdc: 1,
    minOrderShares: 5,
    minSellProfit: 0.01,
    forceFlattenSecondsBeforeEnd: 15,
    maxUnpairedSeconds: 5,
    pairOrderMaxAgeSeconds: 30,
};

function input(prices: number[]) {
    const timestampMs = (prices.length - 1) * 1000;
    return {
        timestampMs,
        btcPrice: prices.at(-1),
        history: prices.map((btcPrice, index) => ({ timestampMs: index * 1000, btcPrice })),
        conditionalParams: { ...conditionalParams },
        up: { bestBid: 0.49, bestAsk: 0.51, mid: 0.50 },
        down: { bestBid: 0.49, bestAsk: 0.51, mid: 0.50 },
        secondsLeft: 120,
        params: { quoteShares: 5, maxUsdcPerLeg: 20, maxInventoryShares: 20, quoteSpread: 0.06, minLockedEdge: 0.02, inventorySkewPerShare: 0.002, enableSellExcess: false, minSecondsLeftToQuote: 30, tick: 0.01 },
        state: { qUp: 0, qDown: 0, buyCostUp: 0, buyCostDown: 0, positionCostUp: 0, positionCostDown: 0, entryAttempted: false, unpairedSinceMs: undefined as number | undefined },
    };
}

test("stops quoting when BTC accelerates", () => {
    const decision = buildBtc5mConditionalMarketMakerQuotes(input([100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100.02, 100.08, 100.12]));
    assert.equal(decision.quotes.length, 0);
    assert.match(decision.reason ?? "", /rapid BTC move/);
});

test("skews price and size toward mild momentum", () => {
    const value = input([100, 100.02, 100.01, 100.03, 100.02, 100.04, 100.03, 100.05, 100.04, 100.05, 100.06]);
    value.conditionalParams.minOrderShares = 2.5;
    const decision = buildBtc5mConditionalMarketMakerQuotes(value);
    const up = decision.quotes.find((quote) => quote.leg === "UP" && quote.side === "BUY");
    const down = decision.quotes.find((quote) => quote.leg === "DOWN" && quote.side === "BUY");
    assert.equal(up?.price, 0.48);
    assert.equal(down?.price, 0.45);
    assert.equal(up?.size, 7.5);
    assert.equal(down?.size, 2.5);
});

test("stops adding inventory in the same direction at the net cap", () => {
    const value = input([100, 100.02, 100.01, 100.03, 100.02, 100.04, 100.03, 100.05, 100.04, 100.05, 100.06]);
    value.state.qUp = 10;
    const decision = buildBtc5mConditionalMarketMakerQuotes(value);
    assert.equal(decision.quotes.some((quote) => quote.leg === "UP" && quote.side === "BUY"), false);
});

test("skips buy quotes below the minimum order notional", () => {
    const value = input([100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100]);
    value.params.quoteShares = 1;
    const decision = buildBtc5mConditionalMarketMakerQuotes(value);
    assert.equal(decision.quotes.filter((quote) => quote.side === "BUY").length, 0);
});

test("does not leave an orphan buy when the other leg is below minimum shares", () => {
    const value = input([100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100]);
    value.params.maxUsdcPerLeg = 2;
    value.up = { bestBid: 0.24, bestAsk: 0.26, mid: 0.25 };
    value.down = { bestBid: 0.73, bestAsk: 0.75, mid: 0.74 };
    const decision = buildBtc5mConditionalMarketMakerQuotes(value);
    assert.equal(decision.quotes.some((quote) => quote.side === "BUY"), false);
});

test("prefers a locked hedge over selling one-sided inventory", () => {
    const value = input([100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100]);
    value.params.enableSellExcess = true;
    value.state.qDown = 5;
    value.state.positionCostDown = 3;
    const decision = buildBtc5mConditionalMarketMakerQuotes(value);
    assert.equal(decision.quotes.length, 1);
    assert.equal(decision.quotes[0].leg, "UP");
    assert.equal(decision.quotes[0].side, "BUY");
    assert.equal(decision.quotes[0].price, 0.38);
});

test("keeps the hedge while rapid movement blocks ordinary buys", () => {
    const value = input([100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100.02, 100.08, 100.12]);
    value.params.enableSellExcess = true;
    value.state.qDown = 5;
    value.state.positionCostDown = 3;
    const decision = buildBtc5mConditionalMarketMakerQuotes(value);
    assert.equal(decision.quotes.length, 1);
    assert.equal(decision.quotes[0].leg, "UP");
    assert.equal(decision.quotes[0].side, "BUY");
    assert.equal(decision.quotes[0].price, 0.38);
});

test("keeps an aggressive profitable hedge while inventory is one-sided", () => {
    const value = input([100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100]);
    value.params.maxUsdcPerLeg = 5;
    value.state.qUp = 5;
    value.state.positionCostUp = 1.85;
    const decision = buildBtc5mConditionalMarketMakerQuotes(value);
    assert.equal(decision.quotes.length, 1);
    assert.equal(decision.quotes[0].leg, "DOWN");
    assert.equal(decision.quotes[0].side, "BUY");
    assert.equal(decision.quotes[0].price, 0.61);
});

test("forces the cheaper exit before settlement", () => {
    const value = input([100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100]);
    value.secondsLeft = 10;
    value.state.qUp = 5;
    value.state.positionCostUp = 1.85;
    value.up = { bestBid: 0.35, bestAsk: 0.36, mid: 0.355 };
    value.down = { bestBid: 0.64, bestAsk: 0.65, mid: 0.645 };
    const decision = buildBtc5mConditionalMarketMakerQuotes(value);
    assert.equal(decision.quotes.length, 1);
    assert.equal(decision.quotes[0].leg, "UP");
    assert.equal(decision.quotes[0].side, "SELL");
    assert.equal(decision.quotes[0].price, 0.35);
});

test("does not enter again after the cycle attempted one pair", () => {
    const value = input([100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100]);
    value.state.entryAttempted = true;
    const decision = buildBtc5mConditionalMarketMakerQuotes(value);
    assert.equal(decision.quotes.some((quote) => quote.side === "BUY"), false);
});

test("stops out one-sided inventory after the pairing timeout", () => {
    const value = input([100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100]);
    value.state.qUp = 5;
    value.state.positionCostUp = 1.85;
    value.state.unpairedSinceMs = value.timestampMs - 6000;
    value.up = { bestBid: 0.35, bestAsk: 0.36, mid: 0.355 };
    value.down = { bestBid: 0.64, bestAsk: 0.65, mid: 0.645 };
    const decision = buildBtc5mConditionalMarketMakerQuotes(value);
    assert.equal(decision.quotes[0].side, "SELL");
    assert.match(decision.quotes[0].note ?? "", /emergency flatten/);
});
