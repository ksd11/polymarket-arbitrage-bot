import assert from "node:assert/strict";
import test from "node:test";
import { buildBtc5mFinal30ManagedOrders, Btc5mFinal30ManagedParams, directionalBtcVelocityBpsPerSec } from "./final-30-managed";

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

test("directional velocity flips sign for DOWN legs", () => {
    const history = [{ t: 60_000, upAsk: 0.15, btcPrice: 64_000 }];
    const up = directionalBtcVelocityBpsPerSec({ leg: "UP", history, timestampMs: 70_000, lookbackSeconds: 10, currentPrice: 64_070 });
    const down = directionalBtcVelocityBpsPerSec({ leg: "DOWN", history, timestampMs: 70_000, lookbackSeconds: 10, currentPrice: 64_070 });
    assert.ok(up !== undefined && up > 1);
    assert.equal(up, -(down ?? 0));
    const thin = directionalBtcVelocityBpsPerSec({ leg: "UP", history: [], timestampMs: 70_000, lookbackSeconds: 10, currentPrice: 64_070 });
    assert.equal(thin, undefined);
});

test("velocity gate blocks a stalling entry and allows a moving one", () => {
    const velParams: Btc5mFinal30ManagedParams = { ...params, entryVelocityLookbackSeconds: 10, entryMinBtcVelocityBpsPerSec: 0.5 };
    const stalled = buildBtc5mFinal30ManagedOrders({
        timestampMs: 75_000, endMs: 100_000, upAsk: 0.86, upBid: 0.85, downAsk: 0.15, downBid: 0.14,
        btcPrice: 64_070, openPrice: 64_000, history: [{ t: 65_000, upAsk: 0.86, btcPrice: 64_070 }, { t: 70_000, upAsk: 0.86, btcPrice: 64_070 }],
        blocked: false, params: velParams,
    });
    assert.equal(stalled.quotes.length, 0);
    assert.match(stalled.reason ?? "", /entry velocity 0\.000bps\/s below 0\.500bps\/s/);

    const moving = buildBtc5mFinal30ManagedOrders({
        timestampMs: 75_000, endMs: 100_000, upAsk: 0.86, upBid: 0.85, downAsk: 0.15, downBid: 0.14,
        btcPrice: 64_070, openPrice: 64_000, history: [{ t: 65_000, upAsk: 0.86, btcPrice: 64_000 }, { t: 70_000, upAsk: 0.86, btcPrice: 64_050 }],
        blocked: false, params: velParams,
    });
    assert.equal(moving.quotes[0]?.leg, "UP");
});

test("acceleration gate blocks a flat entry and allows an accelerating one", () => {
    const accParams: Btc5mFinal30ManagedParams = { ...params, entryAccelerationLookbackSeconds: 5, entryMinBtcAccelerationBpsPerSec2: 0.03 };
    const flat = buildBtc5mFinal30ManagedOrders({
        timestampMs: 75_000, endMs: 100_000, upAsk: 0.86, upBid: 0.85, downAsk: 0.15, downBid: 0.14,
        btcPrice: 64_070, openPrice: 64_000, history: [{ t: 65_000, upAsk: 0.86, btcPrice: 64_070 }, { t: 70_000, upAsk: 0.86, btcPrice: 64_070 }],
        blocked: false, params: accParams,
    });
    assert.equal(flat.quotes.length, 0);
    assert.match(flat.reason ?? "", /entry acceleration 0\.0000bps\/s2 below 0\.0300bps\/s2/);

    const accelerating = buildBtc5mFinal30ManagedOrders({
        timestampMs: 75_000, endMs: 100_000, upAsk: 0.86, upBid: 0.85, downAsk: 0.15, downBid: 0.14,
        btcPrice: 64_070, openPrice: 64_000, history: [{ t: 65_000, upAsk: 0.86, btcPrice: 64_000 }, { t: 70_000, upAsk: 0.86, btcPrice: 64_030 }],
        blocked: false, params: accParams,
    });
    assert.equal(accelerating.quotes[0]?.leg, "UP");
});
