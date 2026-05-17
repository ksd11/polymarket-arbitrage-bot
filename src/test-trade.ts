/**
 * Quick test: verify clob-client-v2 can connect, get balance, and place/cancel an order.
 * Run: npx tsx src/test-trade.ts
 */

// Setup proxy first
import "./setup-proxy";
// V2 verification
import "./patch-exchange-v2";

import { getClobClient } from "./providers/clobclient";
import { Side, AssetType } from "@polymarket/clob-client-v2";

async function main() {
    console.log("=== Polymarket clob-client-v2 Trade Test ===\n");

    // 1. Initialize client
    console.log("[1] Initializing ClobClient V2...");
    const client = await getClobClient();
    console.log("    ✅ ClobClient V2 initialized successfully\n");

    // 2. Get balance & allowance
    console.log("[2] Fetching balance & allowance...");
    try {
        const ba = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        console.log("    Balance:", ba.balance);
        console.log("    Allowances:", JSON.stringify(ba.allowances));
        console.log("    ✅ Balance API works\n");
    } catch (err: any) {
        console.error("    ❌ Balance fetch failed:", err.message);
    }

    // 3. Get open orders
    console.log("[3] Fetching open orders...");
    try {
        const orders = await client.getOpenOrders();
        console.log(`    Open orders: ${orders.length}`);
        if (orders.length > 0) {
            orders.slice(0, 3).forEach((o: any) => {
                console.log(`      - ${o.id} | ${o.side} ${o.size} @ ${o.price}`);
            });
        }
        console.log("    ✅ Orders API works\n");
    } catch (err: any) {
        console.error("    ❌ Orders fetch failed:", err.message);
    }

    // 4. Get recent trades
    console.log("[4] Fetching recent trades...");
    try {
        const trades = await client.getTrades();
        console.log(`    Recent trades: ${trades.length}`);
        if (trades.length > 0) {
            trades.slice(0, 3).forEach((t: any) => {
                console.log(`      - ${t.id?.slice(0, 8)}... | ${t.side} ${t.size} @ ${t.price} | ${t.status}`);
            });
        }
        console.log("    ✅ Trades API works\n");
    } catch (err: any) {
        console.error("    ❌ Trades fetch failed:", err.message);
    }

    // 5. Test V2 order creation (create limit order + cancel)
    console.log("[5] Testing V2 order signing & posting (BTC 5min market)...");
    try {
        // Fetch active BTC 5-min markets from Gamma API
        const resp = await fetch(
            "https://gamma-api.polymarket.com/events?limit=3&active=true&closed=false&order=startDate&ascending=false&slug_filter=btc-updown-5m"
        );
        const events = await resp.json() as any[];

        // Find a Bitcoin market (not BNB/ETH)
        let market: any = null;
        let evtTitle = "";
        for (const evt of events || []) {
            if (evt.title?.includes("Bitcoin") || evt.slug?.includes("btc-updown")) {
                market = evt.markets?.[0];
                evtTitle = evt.title;
                break;
            }
        }

        if (!market) {
            console.log("    ⚠️  No active BTC 5min markets found, skipping order test");
        } else {
            // Parse token IDs
            let tokenIds: string[];
            if (typeof market.clobTokenIds === "string") {
                tokenIds = JSON.parse(market.clobTokenIds);
            } else {
                tokenIds = market.clobTokenIds || [];
            }

            if (tokenIds.length === 0) {
                console.log("    ⚠️  No token IDs found, skipping");
            } else {
                const tokenId = tokenIds[0]; // "Up" token
                console.log(`    Market: ${evtTitle}`);
                console.log(`    Token (Up): ${tokenId.slice(0, 30)}...`);

                // V2 UserOrderV2: no nonce/feeRateBps/taker — just tokenID, price, size, side
                const userOrder = {
                    tokenID: tokenId,
                    price: 0.02,    // 2 cents — extremely unlikely to fill
                    size: 5,        // minimum viable size
                    side: Side.BUY,
                };

                console.log(`    Creating V2 limit order: BUY ${userOrder.size} @ $${userOrder.price}...`);
                const signedOrder = await client.createOrder(userOrder);
                console.log(`    ✅ Order signed successfully (V2 EIP-712 with timestamp/metadata/builder)`);

                // Post the order to the orderbook
                const postResult = await client.postOrder(signedOrder);
                console.log(`    ✅ Order posted!`);
                console.log(`    Response:`, JSON.stringify(postResult).slice(0, 300));

                // Try to cancel it
                const orderId = (postResult as any)?.orderID || (postResult as any)?.id || (postResult as any)?.orderIds?.[0];
                if (orderId) {
                    console.log(`    Cancelling order ${orderId}...`);
                    try {
                        const cancelResult = await client.cancelOrder({ orderID: orderId });
                        console.log(`    ✅ Order cancelled:`, JSON.stringify(cancelResult).slice(0, 200));
                    } catch (cancelErr: any) {
                        console.log(`    ⚠️  Cancel failed: ${cancelErr.message}`);
                    }
                } else {
                    console.log("    ⚠️  No order ID in response, cancelling all...");
                    const cancelAll = await client.cancelAll();
                    console.log(`    Cleanup:`, JSON.stringify(cancelAll).slice(0, 100));
                }
            }
        }
    } catch (err: any) {
        console.error("    ❌ Order test failed:", err.message);
        if (err.cause) console.error("       Cause:", err.cause);
    }

    console.log("\n=== Test Complete ===");
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
