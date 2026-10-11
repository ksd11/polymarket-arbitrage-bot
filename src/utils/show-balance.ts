/**
 * Read-only balance / allowance inspector.
 *
 * Prints exactly what the bot's own client sees (same code path as
 * `waitForMinimumUsdcBalance`), so we can tell apart:
 *   - the CLOB's view of collateral (USDC) balance & allowances
 *   - conditional-token (CTF) balances for one or more token ids
 *
 * Usage:
 *   npx tsx src/utils/show-balance.ts                # collateral only
 *   npx tsx src/utils/show-balance.ts <tokenId> ...  # + conditional balances
 *
 * It performs NO order placement and NO on-chain writes.
 */
import { AssetType, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { JsonRpcProvider, Contract } from "ethers";
import { Wallet } from "@ethersproject/wallet";
import { config } from "../config";
import { getClobClient } from "../providers/clobclient";

/**
 * Collateral tokens worth checking on-chain.
 * IMPORTANT: Polymarket V2 settled on `pUSD` as the trading collateral —
 * NOT USDC.e, NOT native USDC. Checking the wrong token is the #1 reason
 * "wallet looks empty" while the CLOB happily reports a balance.
 */
const ONCHAIN_TOKENS: Array<{ name: string; address: string }> = [
    { name: "pUSD (V2 collateral)", address: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" },
    { name: "USDC.e", address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" },
    { name: "USDC (native)", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
];

const DEFAULT_RPCS = [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.drpc.org",
    "https://1rpc.io/matic",
];

function fmt(raw: string | undefined, decimals = 6): string {
    const n = Number(raw ?? "0");
    if (!Number.isFinite(n)) return String(raw);
    return (n / 10 ** decimals).toFixed(6);
}

async function main(): Promise<void> {
    const tokenIds = process.argv.slice(2).filter((arg) => arg && !arg.startsWith("-"));

    const client = await getClobClient();

    const signer = config.privateKey ? new Wallet(config.privateKey).address : "(none)";
    const sigType = config.useProxyWallet ? SignatureTypeV2.POLY_1271 : SignatureTypeV2.EOA;

    console.log("═══════════════════════════════════════");
    console.log("  BALANCE INSPECTOR (read-only)");
    console.log("═══════════════════════════════════════");
    console.log(`host            : ${config.clobApiUrl}`);
    console.log(`chainId         : ${config.chainId}`);
    console.log(`signer (EOA)    : ${signer}`);
    console.log(`SIG_TYPE        : ${config.useProxyWallet ? "proxy" : "eoa"}`);
    console.log(`signatureType   : ${sigType}`);
    console.log(`funder address  : ${config.useProxyWallet ? config.proxyWalletAddress : "(EOA / signer)"}`);
    console.log("───────────────────────────────────────");

    // Best effort: ask the CLOB to re-read on-chain state before we query it.
    try {
        await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        console.log("updateBalanceAllowance(COLLATERAL): ok");
    } catch (error) {
        console.log(
            `updateBalanceAllowance(COLLATERAL): failed -> ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    try {
        const res = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const allowances = res.allowances ?? {};
        const allowanceSum = Object.values(allowances).reduce(
            (sum, v) => sum + Number(v ?? 0),
            0
        );
        console.log("");
        console.log("  COLLATERAL (USDC)");
        console.log(`  balance   : ${fmt(res.balance)} USDC   (raw=${res.balance})`);
        console.log(`  allowance : ${fmt(String(allowanceSum))} USDC   (raw=${allowanceSum})`);
        console.log(`  allowances: ${JSON.stringify(allowances)}`);
    } catch (error) {
        console.log("");
        console.log(
            `  COLLATERAL (USDC): query failed -> ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    // Independent on-chain cross-check. The CLOB view above is the authority for
    // order validation, but if it disagrees with the chain it is worth knowing.
    const onchainAddress = config.useProxyWallet ? config.proxyWalletAddress : signer;
    if (onchainAddress && onchainAddress.startsWith("0x")) {
        console.log("");
        console.log(`  ON-CHAIN (${onchainAddress})`);
        const rpcUrl = config.rpcUrl ?? DEFAULT_RPCS[0];
        let provider: JsonRpcProvider | null = null;
        for (const url of [rpcUrl, ...DEFAULT_RPCS]) {
            try {
                const candidate = new JsonRpcProvider(url);
                await candidate.getBlockNumber();
                provider = candidate;
                if (url !== rpcUrl) console.log(`  (rpc fallback: ${url})`);
                break;
            } catch { /* try next */ }
        }
        if (!provider) {
            console.log("  rpc: unavailable, skipped");
        } else {
            const abi = ["function balanceOf(address) view returns (uint256)"];
            for (const token of ONCHAIN_TOKENS) {
                try {
                    const contract = new Contract(token.address, abi, provider);
                    const raw: bigint = await contract.balanceOf(onchainAddress);
                    console.log(`  ${token.name.padEnd(22)} = ${(Number(raw) / 1e6).toFixed(6)} (raw=${raw})`);
                } catch (error) {
                    console.log(
                        `  ${token.name.padEnd(22)} = query failed: ${
                            error instanceof Error ? error.message : String(error)
                        }`
                    );
                }
            }
        }
    }

    if (tokenIds.length > 0) {
        console.log("");
        console.log("  CONDITIONAL (CTF shares)");
        for (const tokenId of tokenIds) {
            try {
                const res = await client.getBalanceAllowance({
                    asset_type: AssetType.CONDITIONAL,
                    token_id: tokenId,
                });
                console.log(`  ${tokenId} -> ${fmt(res.balance)} shares (raw=${res.balance})`);
            } catch (error) {
                console.log(
                    `  ${tokenId} -> failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
            }
        }
    }

    // Open orders tell us whether any funds are already reserved.
    try {
        const openOrders = await client.getOpenOrders();
        console.log("");
        console.log(`  OPEN ORDERS: ${openOrders.length}`);
        for (const order of openOrders.slice(0, 10)) {
            console.log(
                `    ${order.side} ${order.original_size} @ ${order.price} matched=${order.size_matched} id=${order.id}`
            );
        }
    } catch (error) {
        console.log(
            `  OPEN ORDERS: query failed -> ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    console.log("═══════════════════════════════════════");
}

main().catch((error) => {
    console.error("Balance inspector failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
