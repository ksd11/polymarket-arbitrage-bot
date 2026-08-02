import assert from "node:assert/strict";
import test from "node:test";
import { buildBtc5mFinal30ManagedOrders, Btc5mFinal30ManagedParams } from "./final-30-managed";

const params: Btc5mFinal30ManagedParams = {
    triggerPrice: 0.85, earlyTriggerPrice: 0.90, maxEntryPrice: 0.90, orderShares: 5,
    maxSecondsLeftToOpen: 30, earlyMaxSecondsLeftToOpen: 30, minSecondsLeftToOpen: 0,
    earlyBtcMinMoveUsd: 60, earlyBtcMinAsk: 0.85, earlyBtcMaxSecondsLeftToOpen: 60,
    btcDirectionRequired: true, trendAtrLookbackSeconds: 14, trendMinGapSafety: 0, trendMinPeakGapRatio: 0, trendMaxSpread: 0.03,
    timezoneOffsetHours: 8, dayStartHour: 9, dayEndHour: 21, dayMinDirectionalMarginBps: 2, nightMinDirectionalMarginBps: 1,
    takeProfitDelta: 0, stopLossDelta: 0.10, stopMinBtcReversalBps: 2, stopConfirmSeconds: 2, stopMaxDirectionalMarginBps: 999,
};

test("enters early only when BTC and contract agree", () => {
    const decision = buildBtc5mFinal30ManagedOrders({ timestampMs: 45_000, endMs: 100_000, upAsk: 0.86, upBid: 0.85, downAsk: 0.15, downBid: 0.14, btcPrice: 64_070, openPrice: 64_000, blocked: false, params });
    assert.equal(decision.quotes[0]?.leg, "UP");
    assert.match(decision.quotes[0]?.note ?? "", /early-btc/);
});

test("waits when the early BTC move is below threshold", () => {
    const decision = buildBtc5mFinal30ManagedOrders({ timestampMs: 45_000, endMs: 100_000, upAsk: 0.86, upBid: 0.85, downAsk: 0.15, downBid: 0.14, btcPrice: 64_059, openPrice: 64_000, blocked: false, params });
    assert.equal(decision.quotes.length, 0);
});

test("rejects a final entry when BTC direction disagrees", () => {
    const decision = buildBtc5mFinal30ManagedOrders({ timestampMs: 75_000, endMs: 100_000, upAsk: 0.86, upBid: 0.85, downAsk: 0.15, downBid: 0.14, btcPrice: 63_990, openPrice: 64_000, blocked: false, params });
    assert.equal(decision.quotes.length, 0);
    assert.match(decision.reason ?? "", /BTC margin -1\.56bps below 1\.00bps/);
});

test("requires normalized gap safety and peak retention for early entry", () => {
    const strictParams = { ...params, earlyBtcMinMoveUsd: 0, trendMinGapSafety: 2, trendMinPeakGapRatio: 0.8 };
    const history = [
        { t: 30_000, upAsk: 0.70, btcPrice: 64_000 },
        { t: 31_000, upAsk: 0.72, btcPrice: 64_002 },
        { t: 32_000, upAsk: 0.74, btcPrice: 64_004 },
        { t: 40_000, upAsk: 0.88, btcPrice: 64_080 },
        { t: 45_000, upAsk: 0.86, btcPrice: 64_070 },
    ];
    const decision = buildBtc5mFinal30ManagedOrders({ timestampMs: 45_000, endMs: 100_000, upAsk: 0.86, upBid: 0.85, downAsk: 0.15, downBid: 0.14, btcPrice: 64_070, openPrice: 64_000, history, blocked: false, params: strictParams });
    assert.equal(decision.quotes[0]?.leg, "UP");
    assert.match(decision.quotes[0]?.note ?? "", /gapSafety=/);
});

test("uses a stricter BTC margin during daytime", () => {
    const daytime = Date.UTC(2026, 0, 1, 1, 0, 0);
    const decision = buildBtc5mFinal30ManagedOrders({ timestampMs: daytime, endMs: daytime + 25_000, upAsk: 0.86, upBid: 0.85, downAsk: 0.15, downBid: 0.14, btcPrice: 64_009.6, openPrice: 64_000, blocked: false, params });
    assert.equal(decision.quotes.length, 0);
    assert.match(decision.reason ?? "", /day 9:00 BTC margin 1\.50bps below 2\.00bps/);
});

test("allows the same BTC margin during nighttime", () => {
    const nighttime = Date.UTC(2026, 0, 1, 17, 0, 0);
    const decision = buildBtc5mFinal30ManagedOrders({ timestampMs: nighttime, endMs: nighttime + 25_000, upAsk: 0.86, upBid: 0.85, downAsk: 0.15, downBid: 0.14, btcPrice: 64_009.6, openPrice: 64_000, blocked: false, params });
    assert.equal(decision.quotes[0]?.leg, "UP");
    assert.match(decision.quotes[0]?.note ?? "", /session=night\/1:00 btcMargin=1\.50bps required=1\.00bps/);
});
