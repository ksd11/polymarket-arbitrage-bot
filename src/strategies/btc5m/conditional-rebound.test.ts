import assert from "node:assert/strict";
import test from "node:test";
import { predictBtc5mConditionalRebound, trainBtc5mConditionalReboundModel } from "./conditional-rebound";

test("learns that larger fair edge and lower percentile improve rebound probability", () => {
    const samples = Array.from({ length: 100 }, (_, index) => {
        const positive = index >= 50;
        return {
            features: {
                ask: positive ? 0.3 : 0.6,
                askPercentile: positive ? 0.1 : 0.9,
                fairEdge: positive ? 0.2 : -0.1,
                contractMomentum: positive ? -0.05 : 0.05,
                btcMomentumAlignedBps: positive ? 3 : -3,
                secondsLeftRatio: 0.5,
                spread: 0.02,
                recentRange: 0.2,
            },
            label: (positive ? 1 : 0) as 0 | 1,
        };
    });
    const model = trainBtc5mConditionalReboundModel(samples);
    assert.ok(predictBtc5mConditionalRebound(model, samples[75].features) > 0.8);
    assert.ok(predictBtc5mConditionalRebound(model, samples[25].features) < 0.2);
});
