// Setup global fetch proxy FIRST (before any other imports that might call fetch)
import "../setup-proxy";

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import { WebSocketOrderBook, TokenPrice } from "../providers/websocketOrderbook";
import { logger } from "../utils/logger";

type CollectConfig = {
    market: string;
    intervalMinutes: number;
    durationMs: number;
    sampleMs: number;
    outDir: string;
    outFile: string;
    btcPriceUrl: string;
};

type MarketTokens = {
    slug: string;
    upTokenId: string;
    downTokenId: string;
    conditionId: string;
    startMs: number;
    endMs: number;
};

type Sample = {
    timestamp: string;
    timestampMs: number;
    slug: string;
    conditionId: string;
    btcPrice: number | null;
    openPrice: number | null;
    secondsLeft: number;
    upBid: number | null;
    upAsk: number | null;
    upMid: number | null;
    downBid: number | null;
    downAsk: number | null;
    downMid: number | null;
    upTokenId: string;
    downTokenId: string;
};

function getArgValue(name: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
    const withEquals = process.argv.find((arg) => arg.startsWith(`${name}=`));
    return withEquals?.slice(name.length + 1);
}

function envString(name: string, fallback: string): string {
    const value = process.env[name]?.trim();
    return value ? value : fallback;
}

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function loadConfig(): CollectConfig {
    const durationMinutes = Number(getArgValue("--duration-minutes") ?? envNumber("COLLECT_DURATION_MINUTES", 60));
    const durationMs = Number(getArgValue("--duration-ms") ?? (durationMinutes > 0 ? durationMinutes * 60_000 : 0));
    const outDir = getArgValue("--out-dir") ?? envString("COLLECT_OUT_DIR", "data");
    const outFile = getArgValue("--out-file") ?? envString("COLLECT_OUT_FILE", "btc5m-history.csv");
    const cfg: CollectConfig = {
        market: (getArgValue("--market") ?? envString("COLLECT_MARKET", "btc")).toLowerCase(),
        intervalMinutes: Number(getArgValue("--interval-minutes") ?? envNumber("COLLECT_INTERVAL_MINUTES", 5)),
        durationMs,
        sampleMs: Number(getArgValue("--sample-ms") ?? envNumber("COLLECT_SAMPLE_MS", 1000)),
        outDir,
        outFile,
        btcPriceUrl: getArgValue("--btc-price-url") ?? envString("COLLECT_BTC_PRICE_URL", "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"),
    };

    if (cfg.intervalMinutes <= 0) throw new Error("COLLECT_INTERVAL_MINUTES must be > 0");
    if (cfg.durationMs < 0) throw new Error("COLLECT_DURATION_MINUTES/COLLECT_DURATION_MS must be >= 0");
    if (cfg.sampleMs <= 0) throw new Error("COLLECT_SAMPLE_MS must be > 0");
    if (!cfg.outDir) throw new Error("COLLECT_OUT_DIR is required");
    if (!cfg.outFile.endsWith(".csv")) throw new Error("COLLECT_OUT_FILE must end with .csv");
    return cfg;
}

function cycleStart(now: Date, intervalMinutes: number): Date {
    const d = new Date(now);
    d.setSeconds(0, 0);
    const slot = Math.floor(d.getMinutes() / intervalMinutes) * intervalMinutes;
    d.setMinutes(slot, 0, 0);
    return d;
}

function slugForCycle(market: string, intervalMinutes: number, now = new Date()): { slug: string; startMs: number; endMs: number } {
    const start = cycleStart(now, intervalMinutes);
    const startMs = start.getTime();
    const endMs = startMs + intervalMinutes * 60_000;
    const timestamp = Math.floor(startMs / 1000);
    return { slug: `${market}-updown-${intervalMinutes}m-${timestamp}`, startMs, endMs };
}

function parseJsonArray<T>(raw: unknown, ctx: string): T[] {
    if (typeof raw !== "string") throw new Error(`${ctx}: expected JSON string`);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${ctx}: expected JSON array`);
    return parsed as T[];
}

async function fetchTokenIdsForSlug(slug: string, startMs: number, endMs: number): Promise<MarketTokens> {
    const url = `https://gamma-api.polymarket.com/markets/slug/${slug}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Gamma API ${response.status} ${response.statusText} for slug=${slug}`);
    }

    const data = (await response.json()) as any;
    const outcomes = parseJsonArray<string>(data.outcomes, "data.outcomes");
    const tokenIds = parseJsonArray<string>(data.clobTokenIds, "data.clobTokenIds");
    const upIdx = outcomes.indexOf("Up");
    const downIdx = outcomes.indexOf("Down");
    if (upIdx < 0 || downIdx < 0) throw new Error(`Missing Up/Down outcomes for slug=${slug}`);
    if (!tokenIds[upIdx] || !tokenIds[downIdx]) throw new Error(`Missing token ids for slug=${slug}`);

    return {
        slug,
        upTokenId: tokenIds[upIdx],
        downTokenId: tokenIds[downIdx],
        conditionId: String(data.conditionId || ""),
        startMs,
        endMs,
    };
}

async function fetchBtcPrice(url: string): Promise<number | null> {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const data = (await response.json()) as any;
        const raw = data.price ?? data.last ?? data.lastPrice ?? data.markPrice ?? data.data?.amount;
        const price = typeof raw === "number" ? raw : Number(String(raw));
        return Number.isFinite(price) && price > 0 ? price : null;
    } catch (error) {
        logger.error(`Failed to fetch BTC price: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

function csvValue(value: string | number | null): string {
    if (value === null) return "";
    const raw = String(value);
    if (!/[",\n\r]/.test(raw)) return raw;
    return `"${raw.replace(/"/g, "\"\"")}"`;
}

function writeHeaderIfNeeded(path: string): void {
    if (existsSync(path)) return;
    const header = [
        "timestamp",
        "timestamp_ms",
        "slug",
        "condition_id",
        "btc_price",
        "open_price",
        "seconds_left",
        "up_bid",
        "up_ask",
        "up_mid",
        "down_bid",
        "down_ask",
        "down_mid",
        "up_token_id",
        "down_token_id",
    ];
    appendFileSync(path, `${header.join(",")}\n`);
}

function writeSample(path: string, sample: Sample): void {
    const values = [
        sample.timestamp,
        sample.timestampMs,
        sample.slug,
        sample.conditionId,
        sample.btcPrice,
        sample.openPrice,
        sample.secondsLeft.toFixed(3),
        sample.upBid,
        sample.upAsk,
        sample.upMid,
        sample.downBid,
        sample.downAsk,
        sample.downMid,
        sample.upTokenId,
        sample.downTokenId,
    ];
    appendFileSync(path, `${values.map(csvValue).join(",")}\n`);
}

class BtcFiveMinuteHistoryCollector {
    private ws: WebSocketOrderBook | null = null;
    private tokens: MarketTokens | null = null;
    private openPrice: number | null = null;
    private latestBtcPrice: number | null = null;
    private timers: NodeJS.Timeout[] = [];
    private stopped = false;
    private readonly outputPath: string;

    constructor(private cfg: CollectConfig) {
        this.outputPath = resolve(cfg.outDir, cfg.outFile);
    }

    async start(): Promise<void> {
        mkdirSync(resolve(this.cfg.outDir), { recursive: true });
        writeHeaderIfNeeded(this.outputPath);

        logger.info(`Collecting BTC ${this.cfg.intervalMinutes}m history to ${this.outputPath}`);
        logger.info(`Duration: ${this.cfg.durationMs === 0 ? "forever" : `${(this.cfg.durationMs / 60_000).toFixed(2)}m`}, sampleMs=${this.cfg.sampleMs}`);

        this.ws = new WebSocketOrderBook("market", [], null);
        await this.ws.connect();
        await this.initializeCurrentCycle();

        this.latestBtcPrice = await fetchBtcPrice(this.cfg.btcPriceUrl);
        this.openPrice = this.latestBtcPrice;

        this.timers.push(setInterval(() => void this.handleCycleTick(), 2_000));
        this.timers.push(setInterval(() => void this.refreshBtcPrice(), Math.max(500, Math.min(this.cfg.sampleMs, 2_000))));
        this.timers.push(setInterval(() => void this.captureSample(), this.cfg.sampleMs));

        if (this.cfg.durationMs > 0) {
            this.timers.push(setTimeout(() => void this.stop("duration reached"), this.cfg.durationMs));
        }
    }

    async stop(reason: string): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        if (this.tokens && this.ws) {
            this.ws.unsubscribeFromTokenIds([this.tokens.upTokenId, this.tokens.downTokenId]);
        }
        if (this.ws) this.ws.disconnect();
        logger.info(`BTC 5m history collector stopped: ${reason}`);
        process.exit(0);
    }

    private async initializeCurrentCycle(): Promise<void> {
        const cycle = slugForCycle(this.cfg.market, this.cfg.intervalMinutes);
        try {
            const tokens = await fetchTokenIdsForSlug(cycle.slug, cycle.startMs, cycle.endMs);
            if (this.tokens && this.ws) {
                this.ws.offPriceUpdate(this.tokens.upTokenId);
                this.ws.offPriceUpdate(this.tokens.downTokenId);
                this.ws.unsubscribeFromTokenIds([this.tokens.upTokenId, this.tokens.downTokenId]);
            }

            this.tokens = tokens;
            this.openPrice = this.latestBtcPrice;
            logger.info(`Cycle ready: ${tokens.slug}`);

            if (!this.ws) throw new Error("WebSocket is not initialized");
            this.ws.subscribeToTokenIds([tokens.upTokenId, tokens.downTokenId]);
            this.ws.setTokenLabel(tokens.upTokenId, "Up");
            this.ws.setTokenLabel(tokens.downTokenId, "Down");
            this.ws.setTokenPair(tokens.upTokenId, tokens.downTokenId);
            this.ws.onPriceUpdate(tokens.upTokenId, () => undefined);
            this.ws.onPriceUpdate(tokens.downTokenId, () => undefined);
        } catch (error) {
            logger.error(`Failed to initialize current ${this.cfg.intervalMinutes}m market: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async handleCycleTick(): Promise<void> {
        if (this.stopped) return;
        const current = slugForCycle(this.cfg.market, this.cfg.intervalMinutes);
        if (!this.tokens || this.tokens.slug !== current.slug) {
            await this.initializeCurrentCycle();
        }
    }

    private async refreshBtcPrice(): Promise<void> {
        if (this.stopped) return;
        const price = await fetchBtcPrice(this.cfg.btcPriceUrl);
        if (price !== null) {
            this.latestBtcPrice = price;
            if (this.openPrice === null) this.openPrice = price;
        }
    }

    private captureSample(): void {
        if (this.stopped || !this.tokens || !this.ws) return;
        const now = Date.now();
        const up = this.ws.getPrice(this.tokens.upTokenId);
        const down = this.ws.getPrice(this.tokens.downTokenId);
        const sample: Sample = {
            timestamp: new Date(now).toISOString(),
            timestampMs: now,
            slug: this.tokens.slug,
            conditionId: this.tokens.conditionId,
            btcPrice: this.latestBtcPrice,
            openPrice: this.openPrice,
            secondsLeft: Math.max(0, (this.tokens.endMs - now) / 1000),
            upBid: valueOrNull(up, "bestBid"),
            upAsk: valueOrNull(up, "bestAsk"),
            upMid: valueOrNull(up, "mid"),
            downBid: valueOrNull(down, "bestBid"),
            downAsk: valueOrNull(down, "bestAsk"),
            downMid: valueOrNull(down, "mid"),
            upTokenId: this.tokens.upTokenId,
            downTokenId: this.tokens.downTokenId,
        };
        writeSample(this.outputPath, sample);
        logger.info(`Wrote sample ${sample.slug}: btc=${sample.btcPrice ?? "--"} upAsk=${sample.upAsk ?? "--"} downAsk=${sample.downAsk ?? "--"}`);
    }
}

function valueOrNull(price: TokenPrice | null, key: "bestBid" | "bestAsk" | "mid"): number | null {
    const value = price?.[key] ?? null;
    return Number.isFinite(value) ? value : null;
}

async function main(): Promise<void> {
    const cfg = loadConfig();
    const collector = new BtcFiveMinuteHistoryCollector(cfg);

    const shutdown = (signal: string) => {
        void collector.stop(signal);
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));

    await collector.start();
}

main().catch((error) => {
    logger.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
