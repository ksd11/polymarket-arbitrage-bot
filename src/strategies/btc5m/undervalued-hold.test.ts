import assert from "node:assert/strict";
import test from "node:test";
import { buildBtc5mUndervaluedHoldOrders, Btc5mUndervaluedHoldParams } from "./undervalued-hold";

const params: Btc5mUndervaluedHoldParams = {
    minEntryPrice: 0.30,
    maxEntryPrice: 0.50,
    orderShares: 5,
    minSecondsLeftToOpen: 90,
    maxSecondsLeftToOpen: 300,
    minDirectionalBtcMarginBps: 1,
    stopLossPct: 0.20,
};

test("buys UP when BTC is sufficiently above open and UP is below 0.50", () => {
    const decision = buildBtc5mUndervaluedHoldOrders({
        timestampMs: 100_000,
        endMs: 300_000,
        btcPrice: 100_020,
        openPrice: 100_000,
        upAsk: 0.45,
        downAsk: 0.56,
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
        blocked: false,
        params,
    });
    assert.equal(decision.quotes.length, 0);
});

test("holds gains without taking profit", () => {
    const decision = buildBtc5mUndervaluedHoldOrders({
        timestampMs: 200_000,
        endMs: 300_000,
        upBid: 0.90,
        position: { leg: "UP", entryPrice: 0.45, shares: 5, exited: false },
        blocked: true,
        params,
    });
    assert.equal(decision.quotes.length, 0);
    assert.match(decision.reason ?? "", /holding to settlement/);
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
