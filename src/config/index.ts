import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

// Load `.env` once for the whole app. Safe if the file doesn't exist.
dotenvConfig({ path: resolve(process.cwd(), ".env") });

// Constants for optional settings (overridable via env when needed)
const DEFAULTS = {
    DEBUG: false,
    CHAIN_ID: 137,
    CLOB_API_URL: "https://clob.polymarket.com",
    SIG_TYPE: "eoa",
    PROXY_WALLET_ADDRESS: "",
    NEG_RISK: false,
    BOT_MIN_USDC_BALANCE: 1,
    BOT_MIN_RUN_BALANCE_USDC: 50,
    COPYTRADE_WAIT_FOR_NEXT_MARKET_START: false,
    LOG_DIR: "logs",
    LOG_FILE_PREFIX: "bot",
    COPYTRADE_MARKETS: "btc",
    COPYTRADE_SHARES: 5,
    COPYTRADE_TICK_SIZE: "0.01",
    COPYTRADE_NEG_RISK: false,
    COPYTRADE_PRICE_BUFFER: 0,
    COPYTRADE_FIRE_AND_FORGET: true,
    COPYTRADE_MIN_BALANCE_USDC: 1,
    COPYTRADE_MAX_BUY_COUNTS_PER_SIDE: 0,
} as const;

function envString(name: string, fallback?: string): string | undefined {
    const v = process.env[name];
    const t = typeof v === "string" ? v.trim() : "";
    if (t) return t;
    return fallback;
}

function envNumber(name: string, fallback: number): number {
    const raw = envString(name);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
    const raw = envString(name);
    if (!raw) return fallback;
    return raw.toLowerCase() === "true";
}

function envCsvLower(name: string, fallbackCsv: string): string[] {
    const raw = envString(name, fallbackCsv) ?? fallbackCsv;
    return raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

function requireEnv(name: string): string {
    const v = envString(name);
    if (!v) throw new Error(`${name} not found`);
    return v;
}

export const config = {
    debug: envBool("DEBUG", DEFAULTS.DEBUG),
    chainId: envNumber("CHAIN_ID", DEFAULTS.CHAIN_ID),
    clobApiUrl: envString("CLOB_API_URL", DEFAULTS.CLOB_API_URL)!,

    privateKey: envString("WALLET_PRIVATE_KEY"),
    requirePrivateKey: () => requireEnv("WALLET_PRIVATE_KEY"),

    useProxyWallet: ["proxy", "gnosis"].includes(
        (envString("SIG_TYPE", DEFAULTS.SIG_TYPE) ?? DEFAULTS.SIG_TYPE).toLowerCase()
    ),
    proxyWalletAddress: envString("PROXY_WALLET_ADDRESS", DEFAULTS.PROXY_WALLET_ADDRESS)!,

    rpcUrl: envString("RPC_URL"),
    rpcToken: envString("RPC_TOKEN"),

    negRisk: envBool("NEG_RISK", DEFAULTS.NEG_RISK),

    bot: {
        minUsdcBalance: envNumber("BOT_MIN_USDC_BALANCE", DEFAULTS.BOT_MIN_USDC_BALANCE),
        minRunBalanceUsdc: envNumber("BOT_MIN_RUN_BALANCE_USDC", DEFAULTS.BOT_MIN_RUN_BALANCE_USDC),
        waitForNextMarketStart: envBool("COPYTRADE_WAIT_FOR_NEXT_MARKET_START", DEFAULTS.COPYTRADE_WAIT_FOR_NEXT_MARKET_START),
    },

    logging: {
        logFilePath: envString("LOG_FILE_PATH"),
        logDir: envString("LOG_DIR", DEFAULTS.LOG_DIR)!,
        logFilePrefix: envString("LOG_FILE_PREFIX", DEFAULTS.LOG_FILE_PREFIX)!,
    },

    copytrade: {
        markets: envCsvLower("COPYTRADE_MARKETS", DEFAULTS.COPYTRADE_MARKETS),
        sharesPerSide: envNumber("COPYTRADE_SHARES", DEFAULTS.COPYTRADE_SHARES),
        tickSize: (envString("COPYTRADE_TICK_SIZE", DEFAULTS.COPYTRADE_TICK_SIZE) ?? DEFAULTS.COPYTRADE_TICK_SIZE) as "0.01" | "0.001" | "0.0001" | string,
        negRisk: envBool("COPYTRADE_NEG_RISK", DEFAULTS.COPYTRADE_NEG_RISK),
        priceBuffer: envNumber("COPYTRADE_PRICE_BUFFER", DEFAULTS.COPYTRADE_PRICE_BUFFER),
        fireAndForget: envBool("COPYTRADE_FIRE_AND_FORGET", DEFAULTS.COPYTRADE_FIRE_AND_FORGET),
        minBalanceUsdc: envNumber("COPYTRADE_MIN_BALANCE_USDC", DEFAULTS.COPYTRADE_MIN_BALANCE_USDC),
        maxBuyCountsPerSide: envNumber("COPYTRADE_MAX_BUY_COUNTS_PER_SIDE", DEFAULTS.COPYTRADE_MAX_BUY_COUNTS_PER_SIDE),
    },

    redeem: {
        conditionId: envString("CONDITION_ID"),
        indexSets: envString("INDEX_SETS"),
    },
};


