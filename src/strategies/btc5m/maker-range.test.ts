import assert from "node:assert/strict";
import test from "node:test";
import { estimatedMakerRebate, evaluateBtc5mMakerRangeRisk } from "./maker-range";

const params = {
    price: 0.4,
    shares: 5,
    maxUnpairedSeconds: 45,
    stopLossDelta: 0.1,
    forceExitSecondsLeft: 60,
    takerFeeRate: 0.07,
    makerRebateRate: 0.2,
};

test("exits an unpaired fill at the configured stop", () => {
    const decision = evaluateBtc5mMakerRangeRisk({ heldLeg: "UP", heldBid: 0.3, firstFillAtMs: 0, timestampMs: 10_000, secondsLeft: 200, params });
    assert.deepEqual(decision, { exit: true, reason: "stop-loss" });
});

test("exits an unpaired fill after timeout", () => {
    const decision = evaluateBtc5mMakerRangeRisk({ heldLeg: "DOWN", heldBid: 0.38, firstFillAtMs: 0, timestampMs: 45_000, secondsLeft: 200, params });
    assert.deepEqual(decision, { exit: true, reason: "unpaired-timeout" });
});

test("keeps waiting while pair opportunity remains", () => {
    const decision = evaluateBtc5mMakerRangeRisk({ heldLeg: "DOWN", heldBid: 0.35, firstFillAtMs: 0, timestampMs: 20_000, secondsLeft: 120, params });
    assert.deepEqual(decision, { exit: false });
});

test("calculates the crypto maker rebate estimate", () => {
    assert.equal(estimatedMakerRebate(5, 0.4, params).toFixed(4), "0.0168");
});
