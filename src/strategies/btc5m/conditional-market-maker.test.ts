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
    minSellProfit: 0.01,
};

function input(prices: number[]) {
    const timestampMs = (prices.length - 1) * 1000;
    return {
        timestampMs,
        btcPrice: prices.at(-1),
        history: prices.map((btcPrice, index) => ({ timestampMs: index * 1000, btcPrice })),
        conditionalParams,
        up: { bestBid: 0.49, bestAsk: 0.51, mid: 0.50 },
        down: { bestBid: 0.49, bestAsk: 0.51, mid: 0.50 },
        secondsLeft: 120,
        params: { quoteShares: 5, maxUsdcPerLeg: 20, maxInventoryShares: 20, quoteSpread: 0.06, minLockedEdge: 0.02, inventorySkewPerShare: 0.002, enableSellExcess: false, minSecondsLeftToQuote: 30, tick: 0.01 },
        state: { qUp: 0, qDown: 0, buyCostUp: 0, buyCostDown: 0, positionCostUp: 0, positionCostDown: 0 },
    };
}

test("stops quoting when BTC accelerates", () => {
    const decision = buildBtc5mConditionalMarketMakerQuotes(input([100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100.02, 100.08, 100.12]));
    assert.equal(decision.quotes.length, 0);
    assert.match(decision.reason ?? "", /rapid BTC move/);
});

test("skews price and size toward mild momentum", () => {
    const decision = buildBtc5mConditionalMarketMakerQuotes(input([100, 100.02, 100.01, 100.03, 100.02, 100.04, 100.03, 100.05, 100.04, 100.05, 100.06]));
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

test("does not quote a sell below remaining average cost plus profit", () => {
    const value = input([100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100]);
    value.params.enableSellExcess = true;
    value.state.qDown = 5;
    value.state.positionCostDown = 3;
    const decision = buildBtc5mConditionalMarketMakerQuotes(value);
    const sell = decision.quotes.find((quote) => quote.leg === "DOWN" && quote.side === "SELL");
    assert.equal(sell?.price, 0.61);
    assert.match(sell?.note ?? "", /cost-protected sell/);
});

test("keeps a protected sell while rapid movement blocks new buys", () => {
    const value = input([100, 100.01, 100, 100.01, 100, 100.01, 100, 100.01, 100.02, 100.08, 100.12]);
    value.params.enableSellExcess = true;
    value.state.qDown = 5;
    value.state.positionCostDown = 3;
    const decision = buildBtc5mConditionalMarketMakerQuotes(value);
    assert.equal(decision.quotes.some((quote) => quote.side === "BUY"), false);
    assert.equal(decision.quotes.find((quote) => quote.side === "SELL")?.price, 0.61);
});
