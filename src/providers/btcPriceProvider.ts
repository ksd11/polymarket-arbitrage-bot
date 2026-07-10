/**
 * BTC Real-time Price Provider
 *
 * Fetches BTC/USD price from multiple exchange APIs with fallback.
 * Extracted from collect/btc-5m-history.ts for reuse across strategies.
 */

import { logger } from "../utils/logger";

export type BtcPriceProviderConfig = {
    /** Price source URLs (tried in order) */
    urls: string[];
    /** Refresh interval in ms (default: 1000) */
    refreshIntervalMs: number;
    /** Max age in ms before price is considered stale (default: 10000) */
    maxStalenessMs: number;
};

export type BtcPriceSnapshot = {
    price: number;
    updatedAt: number;
    source: string;
};

const DEFAULT_URLS = [
    "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
    "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
    "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
    "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT",
];

export function defaultBtcPriceConfig(): BtcPriceProviderConfig {
    return {
        urls: DEFAULT_URLS,
        refreshIntervalMs: 1000,
        maxStalenessMs: 10_000,
    };
}

export class BtcPriceProvider {
    private latest: BtcPriceSnapshot | null = null;
    private timer: NodeJS.Timeout | null = null;
    private stopped = false;

    constructor(private cfg: BtcPriceProviderConfig = defaultBtcPriceConfig()) {}

    /** Start periodic price fetching. First fetch is awaited. */
    async start(): Promise<void> {
        this.stopped = false;
        await this.refresh();
        this.timer = setInterval(() => void this.refresh(), this.cfg.refreshIntervalMs);
        logger.info(`BtcPriceProvider started: refreshMs=${this.cfg.refreshIntervalMs}, sources=${this.cfg.urls.map(hostLabel).join(", ")}`);
    }

    /** Stop periodic fetching. */
    stop(): void {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        logger.info("BtcPriceProvider stopped");
    }

    /** Get latest BTC price, or null if stale/unavailable. */
    getPrice(): number | null {
        if (!this.latest) return null;
        if (Date.now() - this.latest.updatedAt > this.cfg.maxStalenessMs) {
            logger.warning(`BTC price stale: last updated ${((Date.now() - this.latest.updatedAt) / 1000).toFixed(1)}s ago`);
            return null;
        }
        return this.latest.price;
    }

    /** Get full snapshot including metadata. */
    getSnapshot(): BtcPriceSnapshot | null {
        return this.latest;
    }

    /** Force an immediate refresh (exposed for tests / initial fetch). */
    async refresh(): Promise<number | null> {
        if (this.stopped) return this.latest?.price ?? null;
        const errors: string[] = [];
        for (const url of this.cfg.urls) {
            try {
                const response = await fetch(url, {
                    headers: {
                        "User-Agent": "polymarket-arbitrage-bot/1.0",
                        Accept: "application/json",
                    },
                    signal: AbortSignal.timeout(5000),
                });
                if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
                const data = (await response.json()) as any;
                const price = extractBtcPrice(data);
                if (price !== null) {
                    this.latest = { price, updatedAt: Date.now(), source: hostLabel(url) };
                    return price;
                }
                errors.push(`${hostLabel(url)}: unrecognized response`);
            } catch (error) {
                errors.push(`${hostLabel(url)}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        if (errors.length > 0) {
            logger.error(`BTC price fetch failed: ${errors.join(" | ")}`);
        }
        // Keep stale price (don't null it out)
        return this.latest?.price ?? null;
    }
}

function extractBtcPrice(data: any): number | null {
    const candidates = [
        data?.price,
        data?.last,
        data?.lastPrice,
        data?.markPrice,
        data?.data?.amount,
        data?.data?.[0]?.last,
        data?.result?.XXBTZUSD?.c?.[0],
        data?.result?.XXBTZUSD?.a?.[0],
        data?.result?.XBTUSD?.c?.[0],
        data?.result?.XBTUSD?.a?.[0],
    ];
    for (const raw of candidates) {
        const price = typeof raw === "number" ? raw : Number(String(raw));
        if (Number.isFinite(price) && price > 0) return price;
    }
    return null;
}

function hostLabel(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}
