import assert from "node:assert/strict";
import test from "node:test";
import { Trade } from "@polymarket/clob-client-v2";
import { executionsForOrder, summarizeOrderExecutions } from "./clob-order-reconciliation";

test("summarizes taker and maker executions without duplicates", () => {
    const trades = [
        { id: "trade-a", taker_order_id: "target", size: "2.4", price: "0.41", maker_orders: [] },
        { id: "trade-b", taker_order_id: "other", size: "3", price: "0.30", maker_orders: [{ order_id: "target", matched_amount: "2.72", price: "0.37" }] },
    ] as unknown as Trade[];
    const executions = executionsForOrder(trades, "target");
    const summary = summarizeOrderExecutions([...executions, executions[0]]);
    assert.equal(summary.shares, 5.12);
    assert.ok(Math.abs(summary.notional - 1.9904) < 1e-9);
    assert.equal(summary.executionIds.length, 2);
});

test("ignores trades for unrelated orders", () => {
    const trades = [{ id: "trade-a", taker_order_id: "other", size: "2", price: "0.5", maker_orders: [] }] as unknown as Trade[];
    assert.deepEqual(executionsForOrder(trades, "target"), []);
});
