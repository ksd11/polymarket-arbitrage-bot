import assert from "node:assert/strict";
import test from "node:test";
import { Btc5mFinal30ManagedParams } from "./final-30-managed";
import { buildBtc5mUndervaluedFinalManagedOrders } from "./undervalued-final-managed";

const finalParams: Btc5mFinal30ManagedParams = {
    triggerPrice: 0.85, earlyTriggerPrice: 0.90, maxEntryPrice: 0.90, orderShares: 5,
    maxSecondsLeftToOpen: 30, earlyMaxSecondsLeftToOpen: 30, minSecondsLeftToOpen: 8,
    earlyBtcMinMoveUsd: 0, earlyBtcMinAsk: 0.85, earlyBtcMaxSecondsLeftToOpen: 90,
    btcDirectionRequired: true, trendAtrLookbackSeconds: 14, trendMinGapSafety: 0,
    trendMinPeakGapRatio: 0.8, trendMaxSpread: 0.03, timezoneOffsetHours: 8,
    dayStartHour: 9, dayEndHour: 21, dayMinDirectionalMarginBps: 1,
    nightMinDirectionalMarginBps: 1, takeProfitDelta: 0, stopLossDelta: 0.1,
    stopMinBtcReversalBps: 2, stopConfirmSeconds: 2, stopMaxDirectionalMarginBps: 999,
};
const undervaluedParams = {
    minEntryPrice: 0.30, maxEntryPrice: 0.50, orderShares: 5,
    minSecondsLeftToOpen: 90, maxSecondsLeftToOpen: 300,
    minDirectionalBtcMarginBps: 1, stopLossPct: 0.20,
};

test("uses undervalued component before the final window", () => {
    const decision = buildBtc5mUndervaluedFinalManagedOrders({ timestampMs: 100_000, endMs: 300_000, btcPrice: 100_020, openPrice: 100_000, upAsk: 0.45, downAsk: 0.56, upBid: 0.44, downBid: 0.55, undervaluedBlocked: false, undervaluedParams, finalBlocked: false, finalParams });
    assert.equal(decision.component, "undervalued");
    assert.equal(decision.quotes[0]?.leg, "UP");
});

test("hands the final thirty seconds exclusively to final managed", () => {
    const decision = buildBtc5mUndervaluedFinalManagedOrders({ timestampMs: 275_000, endMs: 300_000, btcPrice: 100_020, openPrice: 100_000, upAsk: 0.86, downAsk: 0.15, upBid: 0.85, downBid: 0.14, undervaluedBlocked: false, undervaluedParams: { ...undervaluedParams, minSecondsLeftToOpen: 0 }, finalBlocked: false, finalParams });
    assert.equal(decision.component, "final");
    assert.equal(decision.quotes[0]?.leg, "UP");
});
