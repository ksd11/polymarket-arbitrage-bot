import assert from "node:assert/strict";
import test from "node:test";
import { buildBtc5mFinal30ManagedOrders, Btc5mFinal30ManagedParams } from "./final-30-managed";

const params: Btc5mFinal30ManagedParams = {
    triggerPrice: 0.85, earlyTriggerPrice: 0.90, maxEntryPrice: 0.90, orderShares: 5,
    maxSecondsLeftToOpen: 30, earlyMaxSecondsLeftToOpen: 30, minSecondsLeftToOpen: 0,
    earlyBtcMinMoveUsd: 60, earlyBtcMinAsk: 0.85, earlyBtcMaxSecondsLeftToOpen: 60,
    takeProfitDelta: 0, stopLossDelta: 0.10, stopMinBtcReversalBps: 2, stopConfirmSeconds: 2, stopMaxDirectionalMarginBps: 999,
};

test("enters early only when BTC and contract agree", () => {
    const decision = buildBtc5mFinal30ManagedOrders({ timestampMs: 45_000, endMs: 100_000, upAsk: 0.86, downAsk: 0.15, btcPrice: 64_070, openPrice: 64_000, blocked: false, params });
    assert.equal(decision.quotes[0]?.leg, "UP");
    assert.match(decision.quotes[0]?.note ?? "", /early-btc/);
});

test("waits when the early BTC move is below threshold", () => {
    const decision = buildBtc5mFinal30ManagedOrders({ timestampMs: 45_000, endMs: 100_000, upAsk: 0.86, downAsk: 0.15, btcPrice: 64_059, openPrice: 64_000, blocked: false, params });
    assert.equal(decision.quotes.length, 0);
});
