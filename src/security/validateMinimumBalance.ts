import { ClobClient, AssetType } from "@polymarket/clob-client";
import { getAvailableBalance } from "../utils/balance";
import { config } from "../config";
import { logger } from "../utils/logger";

/**
 * Validates that the wallet has at least the minimum required USDC balance to run the bot.
 * If balance is insufficient: logs a warning and exits the process with code 1.
 */
export async function validateMinimumBalance(client: ClobClient): Promise<void> {
    logger.info("Validating minimum balance");
    const minimumUsd = config.bot.minRunBalanceUsdc;

    try {
        await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    } catch {
        // Ignore sync errors - we'll still query current CLOB view below
    }

    try {
        const balanceResponse = await client.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL,
        });

        const balance = parseFloat(balanceResponse.balance || "0") / 10 ** 6;
        const allowance = parseFloat(balanceResponse.allowance || "0") / 10 ** 6;
        const available = (await getAvailableBalance(client, AssetType.COLLATERAL)) / 10 ** 6;

        if (available < minimumUsd) {
            console.log("═══════════════════════════════════════════════════════════════");
            console.log("⛔ INSUFFICIENT WALLET BALANCE");
            console.log("═══════════════════════════════════════════════════════════════");
            console.log(`The bot requires a minimum of $${minimumUsd} USD to run.`);
            console.log(`Current available balance: $${available.toFixed(2)} USD`);
            console.log(`Wallet balance: $${balance.toFixed(2)} USD | Allowance: $${allowance.toFixed(2)} USD`);
            console.log("═══════════════════════════════════════════════════════════════");
            console.log("Please add funds to your wallet and try again.");
            console.log("═══════════════════════════════════════════════════════════════");
            process.exit(1);
        }

        console.log(
            `Wallet balance check passed: $${available.toFixed(2)} USD available (minimum: $${minimumUsd} USD)`
        );
    } catch (error) {
        console.log(
            `Failed to validate wallet balance: ${error instanceof Error ? error.message : String(error)}`
        );
        console.log("Cannot start bot without verifying balance. Exiting.");
        process.exit(1);
    }
}
