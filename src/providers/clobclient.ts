import { readFileSync, existsSync } from "fs";
import { Chain, ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import type { ApiKeyCreds } from "@polymarket/clob-client-v2";
import { Wallet } from "@ethersproject/wallet";
import { config } from "../config";
import { ensureCredential, credentialPath } from "../security/createCredential";

// Cache for ClobClient instance to avoid repeated initialization
let cachedClient: ClobClient | null = null;
let cachedConfig: { chainId: number; host: string } | null = null;

/**
 * Initialize ClobClient V2 from credentials (cached singleton).
 * If credential file is missing, creates it automatically via createOrDeriveApiKey.
 */
export async function getClobClient(): Promise<ClobClient> {
    if (!existsSync(credentialPath())) {
        const ok = await ensureCredential();
        if (!ok) {
            throw new Error(
                "Credential file not found and could not create one. Set WALLET_PRIVATE_KEY and ensure the wallet can create a Polymarket API key."
            );
        }
    }

    const creds: ApiKeyCreds = JSON.parse(readFileSync(credentialPath(), "utf-8"));
    
    const chainId = (config.chainId || Chain.POLYGON) as Chain;
    const host = config.clobApiUrl;

    // Return cached client if config hasn't changed
    if (cachedClient && cachedConfig && 
        cachedConfig.chainId === chainId && 
        cachedConfig.host === host) {
        return cachedClient;
    }

    // Create wallet from private key
    const privateKey = config.requirePrivateKey();
    const wallet = new Wallet(privateKey);

    // Convert base64url secret to standard base64 for clob-client compatibility
    const secretBase64 = creds.secret.replace(/-/g, '+').replace(/_/g, '/');

    // Create API key credentials
    const apiKeyCreds: ApiKeyCreds = {
        key: creds.key,
        secret: secretBase64,
        passphrase: creds.passphrase,
    };

    // Signature type for V2 Exchange:
    // In V2, POLY_PROXY (1) is BLOCKED for order submission.
    // Use POLY_1271 (3) = "Deposit Wallet" mode for proxy wallet users.
    // 0 = EOA, 1 = POLY_PROXY (blocked), 2 = POLY_GNOSIS_SAFE, 3 = POLY_1271 (deposit wallet)
    const signatureType: SignatureTypeV2 = config.useProxyWallet
        ? SignatureTypeV2.POLY_1271
        : SignatureTypeV2.EOA;
    const funderAddress = config.useProxyWallet ? config.proxyWalletAddress : undefined;

    // V2 SDK: constructor takes an options object (not positional args)
    cachedClient = new ClobClient({
        host,
        chain: chainId,
        signer: wallet,
        creds: apiKeyCreds,
        signatureType,
        funderAddress,
    });
    cachedConfig = { chainId, host };

    return cachedClient;
}

/**
 * Clear cached ClobClient (useful for testing or re-initialization)
 */
export function clearClobClientCache(): void {
    cachedClient = null;
    cachedConfig = null;
}
