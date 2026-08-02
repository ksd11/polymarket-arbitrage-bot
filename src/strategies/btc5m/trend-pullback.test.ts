import assert from "node:assert/strict";
import test from "node:test";
import { buildBtc5mTrendPullbackOrders, Btc5mTrendPullbackParams } from "./trend-pullback";

const params: Btc5mTrendPullbackParams = {
    triggerPrice: 0.90,
    entryPrice: 0.85,
    orderUsdc: 1.6,
    maxUsdcPerLeg: 1.6,
    minSecondsLeftToTrigger: 60,
    maxSecondsLeftToTrigger: 180,
    minSecondsLeftToFill: 20,
    triggerConfirmSeconds: 2,
    maxOrderAgeSeconds: 20,
    maxBtcReversalBps: 3,
    btcDirectionRequired: true,
    trendAtrLookbackSeconds: 14,
    trendAtrFloorUsd: 0.5,
    trendMinGapSafety: 5,
    trendMinPeakGapRatio: 0.8,
    trendMaxSpread: 0.03,
    minBtcRangeUsd: 0,
    minBtcUniquePrices: 0,
    maxBtcUnchangedSeconds: 0,
    waitForPullbackTouch: false,
    maxTouchDrop: 0.05,
    postFillStopLossPrice: 0.77,
    postFillTakeProfitPrice: 0.90,
    postFillMaxBtcReversalBps: 3,
};

const history = [
    { t: 108_000, upAsk: 0.70, downAsk: 0.31, btcPrice: 64_050 },
    { t: 109_000, upAsk: 0.75, downAsk: 0.26, btcPrice: 64_052 },
    { t: 110_000, upAsk: 0.80, downAsk: 0.21, btcPrice: 64_054 },
    { t: 120_000, upAsk: 0.91, downAsk: 0.10, btcPrice: 64_080 },
];

test("arms after a confirmed high-quality trend and posts a pullback bid", () => {
    const candidate = buildBtc5mTrendPullbackOrders({ timestampMs: 120_000, endMs: 300_000, upAsk: 0.91, upBid: 0.90, downAsk: 0.10, downBid: 0.09, btcPrice: 64_080, openPrice: 64_000, history, spentUp: 0, spentDown: 0, state: {}, params });
    assert.equal(candidate.quotes.length, 0);
    const armed = buildBtc5mTrendPullbackOrders({ timestampMs: 122_000, endMs: 300_000, upAsk: 0.92, upBid: 0.91, downAsk: 0.09, downBid: 0.08, btcPrice: 64_082, openPrice: 64_000, history: [...history, { t: 122_000, upAsk: 0.92, downAsk: 0.09, btcPrice: 64_082 }], spentUp: 0, spentDown: 0, state: candidate.state, params });
    assert.equal(armed.state.triggeredLeg, "UP");
    assert.equal(armed.quotes[0]?.price, 0.85);
    assert.match(armed.quotes[0]?.note ?? "", /gapSafety=/);
});

test("rejects a contract signal when BTC direction disagrees", () => {
    const decision = buildBtc5mTrendPullbackOrders({ timestampMs: 120_000, endMs: 300_000, upAsk: 0.91, upBid: 0.90, downAsk: 0.10, downBid: 0.09, btcPrice: 63_990, openPrice: 64_000, history, spentUp: 0, spentDown: 0, state: {}, params });
    assert.equal(decision.quotes.length, 0);
    assert.match(decision.reason ?? "", /direction disagrees/);
});

test("cancels an armed bid after the trend loses peak retention", () => {
    const decision = buildBtc5mTrendPullbackOrders({ timestampMs: 130_000, endMs: 300_000, upAsk: 0.86, upBid: 0.85, downAsk: 0.15, downBid: 0.14, btcPrice: 64_050, openPrice: 64_000, history: [...history, { t: 130_000, upAsk: 0.86, downAsk: 0.15, btcPrice: 64_050 }], spentUp: 0, spentDown: 0, state: { triggeredLeg: "UP", triggeredAtMs: 122_000, triggeredBtcPrice: 64_082 }, params: { ...params, maxBtcReversalBps: 10 } });
    assert.equal(decision.state.cancelled, true);
    assert.match(decision.reason ?? "", /peak ratio/);
});

test("rejects a pullback touch when the BTC source stops changing", () => {
    const inactiveHistory = Array.from({ length: 15 }, (_, index) => ({ t: 116_000 + index * 1_000, upAsk: 0.90 - index * 0.003, downAsk: 0.11 + index * 0.003, btcPrice: 64_080 }));
    const decision = buildBtc5mTrendPullbackOrders({ timestampMs: 130_000, endMs: 300_000, upAsk: 0.85, upBid: 0.84, downAsk: 0.16, downBid: 0.15, btcPrice: 64_080, openPrice: 64_000, history: inactiveHistory, spentUp: 0, spentDown: 0, state: { triggeredLeg: "UP", triggeredAtMs: 122_000, triggeredBtcPrice: 64_080 }, params: { ...params, minBtcRangeUsd: 0.5, minBtcUniquePrices: 3, maxBtcUnchangedSeconds: 5, waitForPullbackTouch: true } });
    assert.equal(decision.state.cancelled, undefined);
    assert.equal(decision.quotes.length, 0);
    assert.match(decision.reason ?? "", /touch rejected: inactive BTC/);
});

test("waits for a pullback touch and revalidates before buying", () => {
    const activeHistory = [...history, { t: 121_000, upAsk: 0.87, downAsk: 0.14, btcPrice: 64_081 }, { t: 122_000, upAsk: 0.84, downAsk: 0.17, btcPrice: 64_082 }];
    const decision = buildBtc5mTrendPullbackOrders({ timestampMs: 122_000, endMs: 300_000, upAsk: 0.84, upBid: 0.83, downAsk: 0.17, downBid: 0.16, btcPrice: 64_082, openPrice: 64_000, history: activeHistory, spentUp: 0, spentDown: 0, state: { triggeredLeg: "UP", triggeredAtMs: 120_000, triggeredBtcPrice: 64_080 }, params: { ...params, waitForPullbackTouch: true, minBtcRangeUsd: 0.5, minBtcUniquePrices: 3, maxBtcUnchangedSeconds: 5 } });
    assert.equal(decision.quotes[0]?.price, 0.84);
    assert.equal(decision.quotes[0]?.side, "BUY");
});
