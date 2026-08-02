import assert from "node:assert/strict";
import test from "node:test";
import { parsePolymarketChainlinkBtcMessage } from "./polymarketChainlinkBtcPriceProvider";

test("parses a Polymarket Chainlink BTC update", () => {
    const snapshots = parsePolymarketChainlinkBtcMessage(JSON.stringify({
        topic: "crypto_prices_chainlink",
        type: "update",
        timestamp: 1_753_314_088_421,
        payload: { symbol: "btc/usd", timestamp: 1_753_314_088_395, value: 67_234.5 },
    }));
    assert.deepEqual(snapshots, [{ price: 67_234.5, updatedAt: 1_753_314_088_395, source: "polymarket-chainlink:btc/usd" }]);
});

test("ignores Binance and non-BTC messages", () => {
    assert.deepEqual(parsePolymarketChainlinkBtcMessage({ topic: "crypto_prices", payload: { symbol: "btcusdt", value: 67_000, timestamp: 1_753_314_088_395 } }), []);
    assert.deepEqual(parsePolymarketChainlinkBtcMessage({ topic: "crypto_prices_chainlink", payload: { symbol: "eth/usd", value: 3_500, timestamp: 1_753_314_088_395 } }), []);
});

test("normalizes second timestamps and snapshot arrays", () => {
    const snapshots = parsePolymarketChainlinkBtcMessage({
        topic: "crypto_prices_chainlink",
        payload: [
            { symbol: "btc/usd", timestamp: 1_753_314_088, value: 67_200 },
            { symbol: "btc/usd", timestamp: 1_753_314_089, value: 67_210 },
        ],
    });
    assert.equal(snapshots[0].updatedAt, 1_753_314_088_000);
    assert.equal(snapshots[1].price, 67_210);
});
