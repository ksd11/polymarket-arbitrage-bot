/**
 * Diagnostic probe (NO order is submitted).
 *
 * Builds a signed order locally and prints the resulting `maker`, together with
 * the configured funder/signer. This answers one question: does the address the
 * CLOB will debit actually match the address holding the funds?
 *
 * Usage: npx tsx src/utils/probe-maker.ts [tokenId]
 */
import { Side } from "@polymarket/clob-client-v2";
import { Wallet } from "@ethersproject/wallet";
import { config } from "../config";
import { getClobClient } from "../providers/clobclient";

async function resolveTokenId(provided?: string): Promise<string> {
    if (provided) return provided;
    const client = await getClobClient();
    const markets = await client.getSamplingMarkets();
    for (const market of (markets as any).data ?? []) {
        const raw = market.tokens ?? market.clobTokenIds ?? market.clob_token_ids;
        if (Array.isArray(raw) && raw.length > 0) {
            const first = raw[0];
            const id = typeof first === "string" ? first : first?.token_id;
            if (id) return String(id);
        }
        const csv = market.clobTokenIds ?? market.clob_token_ids;
        if (typeof csv === "string") {
            try {
                const parsed = JSON.parse(csv);
                if (Array.isArray(parsed) && parsed[0]) return String(parsed[0]);
            } catch { /* ignore */ }
        }
    }
    throw new Error("could not resolve a tokenId from sampling markets");
}

async function main(): Promise<void> {
    const client = await getClobClient();
    const tokenId = await resolveTokenId(process.argv[2]);

    const signerAddress = config.privateKey ? new Wallet(config.privateKey).address : "(none)";

    const tickSize = (await client.getTickSize(tokenId)) as any;
    const negRisk = await client.getNegRisk(tokenId);

    console.log("═══════════════════════════════════════");
    console.log("  MAKER PROBE (no order submitted)");
    console.log("═══════════════════════════════════════");
    console.log(`tokenId          : ${tokenId}`);
    console.log(`tickSize         : ${JSON.stringify(tickSize)}`);
    console.log(`negRisk          : ${negRisk}`);
    console.log(`signer (EOA)     : ${signerAddress}`);
    console.log(`configured funder: ${config.proxyWalletAddress || "(none)"}`);

    const order = await client.createOrder(
        {
            tokenID: tokenId,
            side: Side.BUY,
            price: 0.01,
            size: 5,
        },
        { tickSize: typeof tickSize === "string" ? tickSize : tickSize?.minimum_tick_size, negRisk },
    );

    console.log("───────────────────────────────────────");
    console.log(`order.maker      : ${(order as any).maker}`);
    console.log(`order.signer     : ${(order as any).signer}`);
    console.log(`order.side       : ${(order as any).side}`);
    console.log(`order.salt       : ${(order as any).salt}`);
    console.log("═══════════════════════════════════════");
}

main().catch((error) => {
    console.error("probe failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
