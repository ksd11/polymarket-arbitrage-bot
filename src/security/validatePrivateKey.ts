import { Wallet } from "@ethersproject/wallet";
import { config } from "../config";

/**
 * Validates that WALLET_PRIVATE_KEY is set and is a valid Ethereum private key.
 * If invalid: logs the error and exits the process with code 1.
 */
export function validatePrivateKey(): void {
    const privateKey = config.privateKey;
    if (!privateKey || !privateKey.trim()) {
        console.log("WALLET_PRIVATE_KEY is missing or empty. Set WALLET_PRIVATE_KEY in your .env file.");
        process.exit(1);
    }

    const trimmed = privateKey.trim();
    try {
        new Wallet(trimmed);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log("Invalid WALLET_PRIVATE_KEY:", msg);
        console.log(
            "Private key must be a valid 32-byte hex string (64 hex characters, optionally prefixed with 0x)."
        );
        process.exit(1);
    }
}
