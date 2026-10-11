import assert from "node:assert/strict";
import test from "node:test";
import { OrderType } from "@polymarket/clob-client-v2";
import { belowMinOrderShares, bufferedTakerBuyPrice, classifyOrderError, CLOB_MIN_ORDER_SHARES, formatOrderError, isTakerOrderType, normalizeOrderPrice, normalizeOrderSize, orderResponseError, parseOrderType } from "./order-guards";

test("normalizeOrderPrice snaps onto the tick grid", () => {
    assert.equal(normalizeOrderPrice(0.45, "0.01"), 0.45);
    assert.equal(normalizeOrderPrice(0.865, "0.01"), 0.87);
    assert.equal(normalizeOrderPrice(0.441, "0.001"), 0.441);
});

test("normalizeOrderPrice rejects untradable prices", () => {
    assert.equal(normalizeOrderPrice(0, "0.01"), null);
    assert.equal(normalizeOrderPrice(-0.2, "0.01"), null);
    assert.equal(normalizeOrderPrice(Number.NaN, "0.01"), null);
    // Above 1 - tick: the CLOB treats these as invalid.
    assert.equal(normalizeOrderPrice(0.999, "0.01"), null);
    // Rounds down to zero, i.e. below the minimum tick.
    assert.equal(normalizeOrderPrice(0.004, "0.01"), null);
});

test("normalizeOrderSize floors onto the share step", () => {
    assert.equal(normalizeOrderSize(5, 0.01), 5);
    // A dynamic-hedge size carrying four decimals must become a conforming size.
    assert.equal(normalizeOrderSize(2.1057, 0.01), 2.1);
    assert.equal(normalizeOrderSize(0.004, 0.01), 0);
    assert.equal(normalizeOrderSize(-1, 0.01), 0);
    // step <= 0 disables rounding
    assert.equal(normalizeOrderSize(2.1057, 0), 2.1057);
});

test("belowMinOrderShares enforces the exchange share floor", () => {
    // The CLOB rejects anything under 5 shares ("Size lower than the minimum: 5").
    assert.equal(CLOB_MIN_ORDER_SHARES, 5);
    assert.equal(belowMinOrderShares(1, 5), true);
    assert.equal(belowMinOrderShares(4.99, 5), true);
    assert.equal(belowMinOrderShares(0, 5), true);
    assert.equal(belowMinOrderShares(5, 5), false);
    assert.equal(belowMinOrderShares(5.01, 5), false);
    // A $1-notional-sized order (e.g. 1.2 shares @ 0.85) is still below the share floor.
    assert.equal(belowMinOrderShares(1.2, 5), true);
    // minShares <= 0 disables the check.
    assert.equal(belowMinOrderShares(0.5, 0), false);
});

test("formatOrderError keeps the response body instead of the bare status", () => {
    // The client runs without throwOnError, so callers rebuild the Error from the body.
    const rebuilt = new Error("not enough balance / allowance: the balance is not enough");
    assert.match(formatOrderError(rebuilt), /not enough balance/);
    // ApiError-shaped values keep their `data` payload.
    const apiError = Object.assign(new Error("400"), { status: 400, data: { error: "invalid price (1.2)" } });
    const formatted = formatOrderError(apiError);
    assert.match(formatted, /400/);
    assert.match(formatted, /invalid price/);
});

test("classifyOrderError marks settlement lag as retryable", () => {
    const settlementRace = new Error("not enough balance / allowance");
    assert.deepEqual(classifyOrderError(settlementRace).kind, "insufficient_balance");
    assert.equal(classifyOrderError(settlementRace).retryable, true);
});

test("classifyOrderError marks permanent rejections as non-retryable", () => {
    const badPrice = new Error("invalid price (0.865), min: 0.01 - max: 0.99");
    assert.deepEqual(classifyOrderError(badPrice).kind, "invalid_price");
    assert.equal(classifyOrderError(badPrice).retryable, false);

    const badSize = new Error("order size below minimum size");
    assert.deepEqual(classifyOrderError(badSize).kind, "invalid_size");
    assert.equal(classifyOrderError(badSize).retryable, false);

    const closed = new Error("market is not active");
    assert.deepEqual(classifyOrderError(closed).kind, "market_closed");
    assert.equal(classifyOrderError(closed).retryable, false);
});

test("classifyOrderError treats throttling and blips as retryable", () => {
    assert.equal(classifyOrderError(new Error("429 Too Many Requests")).retryable, true);
    assert.deepEqual(classifyOrderError(new Error("429 Too Many Requests")).kind, "rate_limited");
    assert.deepEqual(classifyOrderError(new Error("fetch failed")).kind, "network");
});

test("classifyOrderError falls back to a retryable unknown", () => {
    const bare = classifyOrderError(new Error("400"));
    assert.deepEqual(bare.kind, "unknown");
    assert.equal(bare.retryable, true);
});

test("parseOrderType maps config values and defaults to GTC", () => {
    assert.equal(parseOrderType("FAK"), OrderType.FAK);
    assert.equal(parseOrderType("fok"), OrderType.FOK);
    assert.equal(parseOrderType(undefined), OrderType.GTC);
    assert.equal(parseOrderType("nonsense"), OrderType.GTC);
    assert.equal(isTakerOrderType(OrderType.FAK), true);
    assert.equal(isTakerOrderType(OrderType.GTC), false);
});

test("bufferedTakerBuyPrice lifts the limit but respects the cap", () => {
    // No buffer configured -> unchanged.
    assert.equal(bufferedTakerBuyPrice(0.96, 0, 0.97, "0.01"), 0.96);
    // Signal ask 0.96 + 2 ticks = 0.98, clamped to the 0.97 cap -> still marketable at the band top.
    assert.equal(bufferedTakerBuyPrice(0.96, 0.02, 0.97, "0.01"), 0.97);
    // Signal ask 0.95 + 2 ticks = 0.97, exactly the cap.
    assert.equal(bufferedTakerBuyPrice(0.95, 0.02, 0.97, "0.01"), 0.97);
    // Small buffer keeps below the cap when there is room.
    assert.equal(bufferedTakerBuyPrice(0.95, 0.01, 0.97, "0.01"), 0.96);
    // The live failure: ask 0.96 had already ticked to 0.97 by the time the order landed.
    assert.equal(bufferedTakerBuyPrice(0.96, 0.01, 0.97, "0.01"), 0.97);
});

test("bufferedTakerBuyPrice never leaves the tick grid or the tradable range", () => {
    // Snapped onto the grid rather than left off it.
    assert.equal(bufferedTakerBuyPrice(0.951, 0.02, 0.97, "0.01"), 0.97);
    // Cap of 1 with a buffer that would exceed 1 - tick falls back to the original price.
    assert.equal(bufferedTakerBuyPrice(0.995, 0.05, 1, "0.01"), 0.995);
});

test("orderResponseError flags a killed FAK body even though it carries an orderID", () => {
    // Exactly what the live probe got back for a non-marketable FAK order (2026-10-09).
    const killed = { error: "no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.", orderID: "0xc1337444cc861921d04a46b47a9e6bc8ef090ff1d2bb18de1c7f61f25fd5d083", status: 400 };
    const reason = orderResponseError(killed);
    assert.ok(reason && reason.includes("no orders found to match"));
    const classified = classifyOrderError(new Error(reason!));
    assert.equal(classified.kind, "taker_no_match");
    assert.equal(classified.retryable, true);
});

test("orderResponseError accepts accepted orders and rejects malformed bodies", () => {
    assert.equal(orderResponseError({ orderID: "0xabc", status: "live" }), null);
    assert.equal(orderResponseError({ orderId: "0xabc", status: 200 }), null);
    assert.ok(orderResponseError({ success: false, errorMsg: "bad" }));
    assert.ok(orderResponseError({ status: 500 }));
    assert.ok(orderResponseError({}));
    assert.ok(orderResponseError(null));
});
