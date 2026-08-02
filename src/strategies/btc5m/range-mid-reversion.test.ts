import assert from "node:assert/strict";
import test from "node:test";
import { buildBtc5mRangeMidReversionOrders, Btc5mRangeMidInput } from "./range-mid-reversion";

function input(): Btc5mRangeMidInput {
    return {
        timestampMs: 121_000,
        startMs: 0,
        endMs: 300_000,
        upAsk: 0.58,
        downAsk: 0.43,
        upBid: 0.57,
        downBid: 0.42,
        history: [0.3, 0.7, 0.4, 0.6, 0.45, 0.55].map((upMid, index) => ({ timestampMs: index * 20_000, upMid })),
        attempted: false,
        position: { shares: 0, cost: 0 },
        params: { observeSeconds: 120, profitDelta: 0.05, maxHoldSeconds: 15, forceExitSecondsLeft: 30, minSecondsLeftToOpen: 60, minMidCrosses: 2, shares: 5, tick: 0.01 },
    };
}

test("selects the entry closest to the current ask", () => {
    const decision = buildBtc5mRangeMidReversionOrders(input());
    assert.equal(decision.quotes.length, 1);
    assert.equal(decision.quotes[0].leg, "DOWN");
    assert.equal(decision.quotes[0].price, 0.45);
});

test("takes profit at the frozen complementary midpoint", () => {
    const value = input();
    value.attempted = true;
    value.position = { leg: "DOWN", shares: 5, cost: 2.25, enteredAtMs: 122_000 };
    value.timestampMs = 130_000;
    const decision = buildBtc5mRangeMidReversionOrders(value);
    assert.equal(decision.quotes[0].side, "SELL");
    assert.equal(decision.quotes[0].price, 0.5);
});

test("uses the current bid after the maximum hold time", () => {
    const value = input();
    value.attempted = true;
    value.position = { leg: "DOWN", shares: 5, cost: 2.25, enteredAtMs: 122_000 };
    value.timestampMs = 138_000;
    const decision = buildBtc5mRangeMidReversionOrders(value);
    assert.equal(decision.quotes[0].price, 0.42);
    assert.match(decision.quotes[0].note ?? "", /time-stop/);
});
