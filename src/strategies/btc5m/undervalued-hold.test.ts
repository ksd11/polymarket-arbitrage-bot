import assert from "node:assert/strict";
import test from "node:test";
import { buildBtc5mUndervaluedHoldOrders, Btc5mUndervaluedHoldParams, calculateRealtimeVolPerInterval } from "./undervalued-hold";

const params: Btc5mUndervaluedHoldParams = {
    minEntryPrice: 0.30,
    maxEntryPrice: 0.60,
    orderShares: 5,
    minSecondsLeftToOpen: 90,
    maxSecondsLeftToOpen: 300,
    minDirectionalBtcMarginBps: 1,
    minEdge: 0.12,
    volatilityLookbackSeconds: 60,
    volatilityMinSamples: 20,
    minVolPerInterval: 0.0005,
    maxVolPerInterval: 0.005,
    maxSpread: 0.03,
    stabilizationLookbackSeconds: 0,
    stabilizationMaxDrop: 0.05,
    stabilizationMinRecovery: 0.02,
    stabilizationStableSeconds: 3,
    stabilizationStableRange: 0.02,
    btcConfirmSeconds: 0,
    takeProfitMinDelta: 0.05,
    takeProfitMaxRemainingEdge: 0.03,
    stopLossPct: 0.20,
};

const history = Array.from({ length: 21 }, (_, index) => ({ t: 80_000 + index * 1_000, btcPrice: 100_000, upAsk: 0.45, downAsk: 0.56 }));

test("buys UP when BTC is sufficiently above open and UP is below 0.50", () => {
    const decision = buildBtc5mUndervaluedHoldOrders({
        timestampMs: 100_000,
        endMs: 300_000,
        btcPrice: 100_020,
        openPrice: 100_000,
        upAsk: 0.45,
        downAsk: 0.56,
        upBid: 0.44,
        downBid: 0.55,
        history,
        blocked: false,
        params,
    });
    assert.equal(decision.quotes[0]?.leg, "UP");
    assert.equal(decision.quotes[0]?.side, "BUY");
    assert.equal(decision.quotes[0]?.size, 5);
});

test("does not enter when BTC directional margin is noise", () => {
    const decision = buildBtc5mUndervaluedHoldOrders({
        timestampMs: 100_000,
        endMs: 300_000,
        btcPrice: 100_005,
        openPrice: 100_000,
        upAsk: 0.45,
        downAsk: 0.56,
        upBid: 0.44,
        downBid: 0.55,
        history,
        blocked: false,
        params,
    });
    assert.equal(decision.quotes.length, 0);
});

test("allows an exact 0.50 ask when realtime fair value has enough edge", () => {
    const decision = buildBtc5mUndervaluedHoldOrders({
        timestampMs: 100_000, endMs: 300_000, btcPrice: 100_020, openPrice: 100_000,
        upAsk: 0.50, downAsk: 0.51, upBid: 0.49, downBid: 0.50, history, blocked: false,
        params,
    });
    assert.equal(decision.quotes[0]?.leg, "UP");
    assert.ok((decision.quotes[0]?.edge ?? 0) >= params.minEdge);
});

test("clamps stale realtime volatility to the configured floor", () => {
    assert.equal(calculateRealtimeVolPerInterval(history, 100_000, params), params.minVolPerInterval);
});

test("takes profit after executable price converges to fair value", () => {
    const decision = buildBtc5mUndervaluedHoldOrders({
        timestampMs: 100_000,
        endMs: 300_000,
        btcPrice: 100_001,
        openPrice: 100_000,
        upBid: 0.55,
        downAsk: 0.46,
        history,
        position: { leg: "UP", entryPrice: 0.45, shares: 5, exited: false },
        blocked: true,
        params,
    });
    assert.equal(decision.quotes[0]?.side, "SELL");
    assert.match(decision.reason ?? "", /convergence take profit/);
});

test("does not take profit while substantial edge remains", () => {
    const decision = buildBtc5mUndervaluedHoldOrders({
        timestampMs: 100_000, endMs: 300_000, btcPrice: 100_020, openPrice: 100_000,
        upBid: 0.51, history, position: { leg: "UP", entryPrice: 0.45, shares: 5, exited: false }, blocked: true, params,
    });
    assert.equal(decision.quotes.length, 0);
});

test("rejects a contract that is still falling sharply", () => {
    const fallingHistory = Array.from({ length: 6 }, (_, index) => ({
        t: 95_000 + index * 1_000,
        btcPrice: 100_030,
        upAsk: 0.75 - index * 0.04,
        downAsk: 0.26 + index * 0.04,
    }));
    const decision = buildBtc5mUndervaluedHoldOrders({
        timestampMs: 100_000, endMs: 300_000, btcPrice: 100_030, openPrice: 100_000,
        upAsk: 0.55, downAsk: 0.46, upBid: 0.54, downBid: 0.45, history: fallingHistory, blocked: false,
        params: { ...params, stabilizationLookbackSeconds: 5 },
    });
    assert.equal(decision.quotes.length, 0);
    assert.match(decision.reason ?? "", /falling knife/);
});

test("sells the full position at a twenty percent loss", () => {
    const decision = buildBtc5mUndervaluedHoldOrders({
        timestampMs: 200_000,
        endMs: 300_000,
        upBid: 0.36,
        position: { leg: "UP", entryPrice: 0.45, shares: 5, exited: false },
        blocked: true,
        params,
    });
    assert.equal(decision.quotes[0]?.side, "SELL");
    assert.equal(decision.quotes[0]?.price, 0.36);
    assert.equal(decision.quotes[0]?.size, 5);
});

test("holds to settlement when stop loss is disabled", () => {
    const decision = buildBtc5mUndervaluedHoldOrders({
        timestampMs: 200_000,
        endMs: 300_000,
        upBid: 0.01,
        position: { leg: "UP", entryPrice: 0.45, shares: 5, exited: false },
        blocked: true,
        params: { ...params, stopLossPct: 0 },
    });
    assert.equal(decision.quotes.length, 0);
    assert.match(decision.reason ?? "", /disabled/);
});
