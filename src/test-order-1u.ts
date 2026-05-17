/**
 * Test: Place a 1U BUY order on "Up" for event btc-updown-5m-1779001800
 * Run: npx tsx src/test-order-1u.ts
 */

// Setup proxy first
import "./setup-proxy";
import "./patch-exchange-v2";

import { getClobClient } from "./providers/clobclient";
import { Side } from "@polymarket/clob-client-v2";

// Event: btc-updown-5m-1779001800
// Up token ID (first in clobTokenIds array)
const UP_TOKEN_ID = "68064041488578953875152158068217749211738500258718282769215708394079874906279";

async function main() {
    console.log("=== Test: Buy 1U of 'Up' on btc-updown-5m-1779001800 ===\n");

    // 1. Initialize client
    console.log("[1] Initializing ClobClient V2...");
    const client = await getClobClient();
    console.log("    ✅ Client ready\n");

    // 2. Check orderbook to determine best price
    console.log("[2] Fetching orderbook for Up token...");
    const book = await client.getOrderBook(UP_TOKEN_ID);
    const asks = book.asks || [];
    const bids = book.bids || [];
    
    console.log(`    Best ask (lowest sell): ${asks.length > 0 ? `${asks[0].price} x ${asks[0].size}` : "none"}`);
    console.log(`    Best bid (highest buy): ${bids.length > 0 ? `${bids[bids.length - 1].price} x ${bids[bids.length - 1].size}` : "none"}`);

    // 3. Calculate order params for ~1U spend
    // Strategy: Place a limit buy at a reasonable price
    // For 1U spend: size = budget / price
    // If best ask is 0.99 and best bid is 0.01, market is wide
    // Use midpoint or a reasonable price like 0.50
    const bestAskPrice = asks.length > 0 ? parseFloat(asks[0].price) : 0.99;
    const bestBidPrice = bids.length > 0 ? parseFloat(bids[bids.length - 1].price) : 0.01;
    
    // Use a price slightly below best ask to try to get filled
    // Or if spread is wide, use midpoint
    let orderPrice: number;
    const spread = bestAskPrice - bestBidPrice;
    
    if (spread < 0.10) {
        // Tight spread - bid just below best ask
        orderPrice = Math.round((bestAskPrice - 0.01) * 100) / 100;
    } else {
        // Wide spread - use aggressive buy price at ~0.51 (market suggests ~50/50)
        // For testing, let's just use 0.50 as a fair price
        orderPrice = 0.50;
    }

    // Size for 1U budget: shares = budget / price
    const budget = 1.0; // 1 USDC
    const size = Math.floor(budget / orderPrice); // integer shares
    const actualCost = size * orderPrice;

    console.log(`\n[3] Order parameters:`);
    console.log(`    Token: Up (btc-updown-5m-1779001800)`);
    console.log(`    Side: BUY`);
    console.log(`    Price: $${orderPrice}`);
    console.log(`    Size: ${size} shares`);
    console.log(`    Total cost: ~$${actualCost.toFixed(2)}`);

    // 4. Create and post order
    console.log(`\n[4] Creating V2 limit order...`);
    try {
        const userOrder = {
            tokenID: UP_TOKEN_ID,
            price: orderPrice,
            size: size,
            side: Side.BUY,
        };

        const signedOrder = await client.createOrder(userOrder);
        console.log(`    ✅ Order signed (V2 EIP-712)`);

        console.log(`    Posting order to CLOB...`);
        const result = await client.postOrder(signedOrder);
        console.log(`    ✅ Order posted!`);
        console.log(`    Response:`, JSON.stringify(result, null, 2));

        const orderId = (result as any)?.orderID || (result as any)?.id;
        if (orderId) {
            console.log(`\n    Order ID: ${orderId}`);
            console.log(`    Status: LIVE (waiting for fill or expiry)`);
            
            // Don't cancel - let it try to fill
            console.log(`\n    ⏳ Order left open to attempt fill.`);
            console.log(`    To cancel manually: client.cancelOrder({ orderID: "${orderId}" })`);
        }
    } catch (err: any) {
        console.error(`    ❌ Order failed:`, err.message);
        if (err.response?.data) {
            console.error(`    Response data:`, JSON.stringify(err.response.data));
        }
    }

    console.log("\n=== Done ===");
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
