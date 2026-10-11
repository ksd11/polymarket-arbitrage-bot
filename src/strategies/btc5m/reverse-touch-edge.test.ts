import assert from "node:assert/strict";
import test from "node:test";
import { buildBtc5mReverseTouchEdgeOrders } from "./reverse-touch-edge";

const params = { intervalMinutes: 5, volPerInterval: 0.0015, triggerPrice: 0.4, triggerResetPrice: 0.45, minEntryPrice: 0.5, maxEntryPrice: 0.66, minSecondsLeftToOpen: 60, maxSecondsLeftToOpen: 240, confirmSeconds: 2, minDirectionalBtcMarginBps: 2, minEdge: 0.05, maxSpread: 0.03, orderShares: 5 };

test("buys the opposite leg only after persistent BTC-aligned edge", () => {
    const history = [{ t: 100_000, upAsk: 0.39, downAsk: 0.62, btcPrice: 99_900 }, { t: 102_000, upAsk: 0.38, downAsk: 0.63, btcPrice: 99_880 }];
    const decision = buildBtc5mReverseTouchEdgeOrders({ timestampMs: 102_000, endMs: 300_000, upAsk: 0.38, downAsk: 0.63, upBid: 0.37, downBid: 0.62, btcPrice: 99_880, openPrice: 100_000, history, state: { triggerLeg: "UP", candidateLeg: "DOWN", candidateSinceMs: 100_000 }, blocked: false, params });
    assert.equal(decision.quotes[0]?.leg, "DOWN");
    assert.equal(decision.quotes[0]?.size, 5);
});

test("rejects a reverse touch when BTC disagrees", () => {
    const history = [{ t: 100_000, upAsk: 0.39, downAsk: 0.62, btcPrice: 100_030 }, { t: 102_000, upAsk: 0.38, downAsk: 0.63, btcPrice: 100_040 }];
    const decision = buildBtc5mReverseTouchEdgeOrders({ timestampMs: 102_000, endMs: 300_000, upAsk: 0.38, downAsk: 0.63, upBid: 0.37, downBid: 0.62, btcPrice: 100_040, openPrice: 100_000, history, state: { triggerLeg: "UP", candidateLeg: "DOWN", candidateSinceMs: 100_000 }, blocked: false, params });
    assert.equal(decision.quotes.length, 0);
});
