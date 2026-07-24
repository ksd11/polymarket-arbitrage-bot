import "./setup-proxy";
import "./patch-exchange-v2";

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { ClobClient, CreateOrderOptions, OrderType, Side, UserOrderV2 as UserOrder } from "@polymarket/clob-client-v2";
import { config } from "./config";
import { getClobClient } from "./providers/clobclient";
import { BtcPriceProvider, defaultBtcPriceConfig } from "./providers/btcPriceProvider";
import { MarketResolvedPayload, WebSocketOrderBook } from "./providers/websocketOrderbook";
import { approveUSDCAllowance, updateClobBalanceAllowance } from "./security/allowance";
import { createCredential } from "./security/createCredential";
import { validatePrivateKey } from "./security/validatePrivateKey";
import { buildBtc5mDeepReboundOrders, Btc5mDeepReboundParams } from "./strategies/btc5m/deep-rebound";
import { Btc5mRegimeSnapshot } from "./strategies/btc5m/regime";
import { buildBtc5mTrendPullbackOrders, Btc5mTrendPullbackParams, Btc5mTrendPullbackState } from "./strategies/btc5m/trend-pullback";
import { buildBtc5mSustainedHighOrders, Btc5mSustainedHighParams, Btc5mSustainedHighState } from "./strategies/btc5m/sustained-high";
import { Btc5mPreviousCycleSnapshot, Btc5mTrendRangeRegimeMetrics, Btc5mTrendRangeRegimeParams, classifyPreviousCycleRegime } from "./strategies/btc5m/trend-range-regime";
import { waitForMinimumUsdcBalance } from "./utils/balance";
import { setupConsoleFileLogging } from "./utils/console-file";
import { logger } from "./utils/logger";

type Leg = "UP" | "DOWN";
type Component = "trend" | "range" | "high" | "deep";
type OrderRole = "trend-entry" | "trend-exit" | "range-first" | "range-second" | "high-entry" | "deep-entry" | "deep-take-profit" | "deep-risk-exit";

type OverlayConfig = Btc5mTrendPullbackParams & Btc5mTrendRangeRegimeParams & {
    mode: "trend-range-overlay" | "adaptive-overlay";
    dryRun: boolean;
    market: string;
    intervalMinutes: number;
    tickSize: CreateOrderOptions["tickSize"];
    negRisk: boolean;
    cancelSecondsBeforeEnd: number;
    evaluationIntervalMs: number;
    orderPollIntervalMs: number;
    marketLogIntervalMs: number;
    orderRetrySeconds: number;
    marketDataStaleSeconds: number;
    btcPriceRefreshMs: number;
    btcPriceMaxStaleMs: number;
    btcPriceUrls: string[];
    rangeFirstPrice: number;
    rangeSecondPrice: number;
    rangeMaxTotalUsdc: number;
    conditionalTrendTakeProfitPrice: number;
    highEnabled: boolean;
    high: Btc5mSustainedHighParams;
    deepEnabled: boolean;
    deep: Btc5mDeepReboundParams;
    recordEnabled: boolean;
    recordPath: string;
};

type MarketTokens = {
    slug: string;
    conditionId: string;
    upTokenId: string;
    downTokenId: string;
    startMs: number;
    endMs: number;
    upMinOrderSize?: number;
    downMinOrderSize?: number;
};

type PlacedOrder = {
    slug: string;
    conditionId: string;
    component: Component;
    role: OrderRole;
    leg: Leg;
    side: "BUY" | "SELL";
    tokenId: string;
    orderId: string;
    price: number;
    size: number;
    filledSize: number;
    accountedFilledSize: number;
    status: string;
    placedAtMs: number;
};

type ComponentAccounting = {
    cost: number;
    costUp: number;
    costDown: number;
    sharesUp: number;
    sharesDown: number;
    soldUp: number;
    soldDown: number;
    proceeds: number;
};

type CycleAccounting = {
    tokens: MarketTokens;
    trend: ComponentAccounting;
    range: ComponentAccounting;
    high: ComponentAccounting;
    deep: ComponentAccounting;
    resolved: boolean;
};

const RECORD_HEADERS = [
    "row_type", "timestamp", "timestamp_ms", "slug", "condition_id", "dry_run",
    "btc_price", "btc_source", "seconds_left", "up_bid", "up_ask", "up_mid", "down_bid", "down_ask", "down_mid",
    "range_enabled", "previous_oscillating", "previous_sample_count", "previous_band_ratio", "previous_swing_count", "previous_price_range", "previous_choppiness",
    "trend_triggered_leg", "trend_filled", "trend_cancelled", "trend_exited", "trend_reason", "trend_quotes",
    "range_filled_up", "range_filled_down", "range_reason", "range_quotes",
    "high_triggered_leg", "high_filled", "high_cancelled", "high_reason", "high_quotes",
    "deep_enabled", "deep_filled_up", "deep_filled_down", "deep_reason", "deep_quotes",
    "event_component", "event_role", "event_leg", "event_side", "event_price", "event_size", "event_cost", "order_id", "order_status", "filled_size", "event_error",
    "winning_outcome", "trend_cost", "trend_payout", "trend_pnl", "range_cost", "range_payout", "range_pnl", "high_cost", "high_payout", "high_pnl", "deep_cost", "deep_payout", "deep_pnl", "total_pnl",
] as const;
type RecordRow = Partial<Record<typeof RECORD_HEADERS[number], string | number | boolean>>;

function envString(name: string, fallback: string): string { return process.env[name]?.trim() || fallback; }
function envNumber(name: string, fallback: number): number { const value = Number(process.env[name]?.trim()); return Number.isFinite(value) ? value : fallback; }
function envBool(name: string, fallback: boolean): boolean { const value = process.env[name]?.trim(); return value ? value.toLowerCase() === "true" : fallback; }
function parseList(raw: string): string[] { return raw.split(/[|,]/).map((value) => value.trim()).filter(Boolean); }

function loadConfig(): OverlayConfig {
    const btc = defaultBtcPriceConfig();
    const mode = process.env.BTC5M_OVERLAY_MODE === "adaptive-overlay" ? "adaptive-overlay" : "trend-range-overlay";
    const prefix = mode === "adaptive-overlay" ? "ADAPTIVE_OVERLAY" : "TREND_RANGE_OVERLAY";
    const number = (suffix: string, fallback: number) => envNumber(`${prefix}_${suffix}`, fallback);
    const bool = (suffix: string, fallback: boolean) => envBool(`${prefix}_${suffix}`, fallback);
    const string = (suffix: string, fallback: string) => envString(`${prefix}_${suffix}`, fallback);
    const cfg: OverlayConfig = {
        mode,
        dryRun: bool("DRY_RUN", true),
        market: string("MARKET", envString("BTC5M_MARKET", "btc")).toLowerCase(),
        intervalMinutes: number("INTERVAL_MINUTES", 5),
        tickSize: string("TICK_SIZE", envString("BTC5M_TICK_SIZE", "0.01")) as CreateOrderOptions["tickSize"],
        negRisk: bool("NEG_RISK", envBool("BTC5M_NEG_RISK", config.copytrade.negRisk)),
        cancelSecondsBeforeEnd: number("CANCEL_SECONDS_BEFORE_END", 5),
        evaluationIntervalMs: number("EVALUATION_INTERVAL_MS", mode === "adaptive-overlay" ? 250 : 1000),
        orderPollIntervalMs: number("ORDER_POLL_INTERVAL_MS", mode === "adaptive-overlay" ? 500 : 2000),
        marketLogIntervalMs: number("MARKET_LOG_INTERVAL_MS", 1000),
        orderRetrySeconds: number("ORDER_RETRY_SECONDS", 5),
        marketDataStaleSeconds: number("MARKET_DATA_STALE_SECONDS", 30),
        btcPriceRefreshMs: number("BTC_PRICE_REFRESH_MS", btc.refreshIntervalMs),
        btcPriceMaxStaleMs: number("BTC_PRICE_MAX_STALE_MS", btc.maxStalenessMs),
        btcPriceUrls: parseList(string("BTC_PRICE_URLS", btc.urls.join("|"))),
        triggerPrice: number("TREND_TRIGGER_PRICE", 0.85),
        entryPrice: number("TREND_ENTRY_PRICE", 0.80),
        orderUsdc: number("TREND_ORDER_USDC", 4.00),
        maxUsdcPerLeg: number("TREND_MAX_USDC_PER_LEG", 4.00),
        minSecondsLeftToTrigger: number("TREND_MIN_SECONDS_LEFT_TO_TRIGGER", 30),
        minSecondsLeftToFill: number("TREND_MIN_SECONDS_LEFT_TO_FILL", 0),
        triggerConfirmSeconds: number("TREND_CONFIRM_SECONDS", 0),
        maxOrderAgeSeconds: number("TREND_MAX_ORDER_AGE_SECONDS", 8),
        maxBtcReversalBps: number("TREND_MAX_BTC_REVERSAL_BPS", 2),
        postFillStopLossPrice: number("TREND_STOP_LOSS_PRICE", 0),
        postFillTakeProfitPrice: 0,
        postFillMaxBtcReversalBps: number("TREND_POST_FILL_MAX_BTC_REVERSAL_BPS", 0),
        bandLower: number("REGIME_BAND_LOWER", envNumber("TREND_RANGE_REGIME_BAND_LOWER", 0.30)),
        bandUpper: number("REGIME_BAND_UPPER", envNumber("TREND_RANGE_REGIME_BAND_UPPER", 0.70)),
        minBandRatio: number("REGIME_MIN_BAND_RATIO", envNumber("TREND_RANGE_REGIME_MIN_BAND_RATIO", 0.70)),
        centerBuffer: number("REGIME_CENTER_BUFFER", envNumber("TREND_RANGE_REGIME_CENTER_BUFFER", 0.05)),
        minCrossCount: number("REGIME_MIN_CROSS_COUNT", envNumber("TREND_RANGE_REGIME_MIN_CROSS_COUNT", 3)),
        minPriceRange: number("REGIME_MIN_PRICE_RANGE", envNumber("TREND_RANGE_REGIME_MIN_PRICE_RANGE", 0.15)),
        minChoppiness: number("REGIME_MIN_CHOPPINESS", envNumber("TREND_RANGE_REGIME_MIN_CHOPPINESS", 3)),
        ignoreFinalSeconds: number("REGIME_IGNORE_FINAL_SECONDS", envNumber("TREND_RANGE_REGIME_IGNORE_FINAL_SECONDS", 60)),
        minSamples: number("REGIME_MIN_SAMPLES", envNumber("TREND_RANGE_REGIME_MIN_SAMPLES", 30)),
        rangeFirstPrice: number("RANGE_FIRST_PRICE", 0.40),
        rangeSecondPrice: number("RANGE_SECOND_PRICE", 0.40),
        rangeMaxTotalUsdc: number("RANGE_MAX_TOTAL_USDC", 4.00),
        conditionalTrendTakeProfitPrice: number("TREND_TAKE_PROFIT_PRICE", 0),
        highEnabled: bool("HIGH_ENABLED", true),
        high: {
            triggerPrice: number("HIGH_TRIGGER_PRICE", 0.90), confirmSeconds: number("HIGH_CONFIRM_SECONDS", 10),
            entryPrice: number("HIGH_ENTRY_PRICE", 0.90), orderUsdc: number("HIGH_ORDER_USDC", 4.50),
            maxSecondsLeftToTrigger: number("HIGH_MAX_SECONDS_LEFT_TO_TRIGGER", 120), minSecondsLeftToTrigger: number("HIGH_MIN_SECONDS_LEFT_TO_TRIGGER", 20),
            minSecondsLeftToFill: number("HIGH_MIN_SECONDS_LEFT_TO_FILL", 20), maxOrderAgeSeconds: number("HIGH_MAX_ORDER_AGE_SECONDS", 0),
            minBtcMoveBps: number("HIGH_MIN_BTC_MOVE_BPS", 3), maxBtcReversalBps: number("HIGH_MAX_BTC_REVERSAL_BPS", 2),
        },
        deepEnabled: mode === "adaptive-overlay" && bool("DEEP_ENABLED", true),
        deep: {
            intervalMinutes: number("INTERVAL_MINUTES", 5), volPerInterval: number("DEEP_VOL_PER_INTERVAL", 0.0015),
            minEntryPrice: number("DEEP_MIN_ENTRY_PRICE", 0.03), maxEntryPrice: number("DEEP_MAX_ENTRY_PRICE", 0.10),
            orderUsdc: number("DEEP_ORDER_USDC", 1.01), maxUsdcPerLeg: number("DEEP_MAX_USDC_PER_LEG", 1.01),
            scoreThreshold: number("DEEP_SCORE_THRESHOLD", 0.20), minDiscount: number("DEEP_MIN_DISCOUNT", 0.05),
            takeProfitPrice: number("DEEP_TAKE_PROFIT_PRICE", 0.05), stopLossPct: number("DEEP_STOP_LOSS_PCT", 0.50),
            minSecondsLeftToOpen: number("DEEP_MIN_SECONDS_LEFT_TO_OPEN", 60), maxSecondsLeftToOpen: number("DEEP_MAX_SECONDS_LEFT_TO_OPEN", 240),
            forceExitSecondsLeft: number("DEEP_FORCE_EXIT_SECONDS_LEFT", 30),
        },
        recordEnabled: bool("RECORD_ENABLED", true),
        recordPath: resolve(string("RECORD_FILE", `data/btc5m-${mode}-live.csv`)),
    };
    if (!(cfg.rangeFirstPrice > 0 && cfg.rangeFirstPrice < 0.5 && cfg.rangeSecondPrice >= cfg.rangeFirstPrice && cfg.rangeFirstPrice + cfg.rangeSecondPrice < 1)) throw new Error("Invalid overlay range prices");
    if (cfg.rangeMaxTotalUsdc <= 0 || cfg.orderUsdc <= 0 || cfg.maxUsdcPerLeg < cfg.orderUsdc) throw new Error("Invalid overlay budget");
    if (!(cfg.triggerPrice > cfg.entryPrice && cfg.entryPrice > 0)) throw new Error("Trend trigger must exceed entry price");
    if (!(cfg.high.entryPrice > 0 && cfg.high.entryPrice <= cfg.high.triggerPrice && cfg.high.triggerPrice < 1) || cfg.high.orderUsdc <= 0) throw new Error("Invalid sustained-high prices or budget");
    if (cfg.deepEnabled && (!(cfg.deep.minEntryPrice > 0 && cfg.deep.minEntryPrice < cfg.deep.maxEntryPrice && cfg.deep.maxEntryPrice < 1) || cfg.deep.orderUsdc < 1.01 || cfg.deep.maxUsdcPerLeg < cfg.deep.orderUsdc)) throw new Error("Invalid deep-rebound configuration: marketable BUY requires DEEP_ORDER_USDC >= 1.01 and matching max budget");
    if (cfg.marketLogIntervalMs < 0) throw new Error("Market log interval must be >= 0");
    if (cfg.orderRetrySeconds < 0) throw new Error("Order retry seconds must be >= 0");
    if (cfg.marketDataStaleSeconds <= 0) throw new Error("Market data stale seconds must be > 0");
    if (cfg.recordEnabled) cfg.recordPath = resolveRecordPathForSchema(cfg.recordPath);
    return cfg;
}

function cycleForNow(market: string, intervalMinutes: number, now = Date.now()): { slug: string; startMs: number; endMs: number } {
    const intervalMs = intervalMinutes * 60_000;
    const startMs = Math.floor(now / intervalMs) * intervalMs;
    return { slug: `${market}-updown-${intervalMinutes}m-${Math.floor(startMs / 1000)}`, startMs, endMs: startMs + intervalMs };
}

function parseJsonArray(raw: unknown): string[] { if (typeof raw !== "string") throw new Error("Expected JSON array string"); const parsed = JSON.parse(raw); if (!Array.isArray(parsed)) throw new Error("Expected JSON array"); return parsed.map(String); }
async function fetchTokens(cycle: { slug: string; startMs: number; endMs: number }): Promise<MarketTokens> {
    const response = await fetch(`https://gamma-api.polymarket.com/markets/slug/${cycle.slug}`);
    if (!response.ok) throw new Error(`Gamma API ${response.status} for ${cycle.slug}`);
    const data = await response.json() as any;
    const outcomes = parseJsonArray(data.outcomes);
    const ids = parseJsonArray(data.clobTokenIds);
    const up = outcomes.indexOf("Up"); const down = outcomes.indexOf("Down");
    if (up < 0 || down < 0 || !ids[up] || !ids[down]) throw new Error(`Missing tokens for ${cycle.slug}`);
    return { ...cycle, conditionId: String(data.conditionId || ""), upTokenId: ids[up], downTokenId: ids[down] };
}

function emptyComponent(): ComponentAccounting { return { cost: 0, costUp: 0, costDown: 0, sharesUp: 0, sharesDown: 0, soldUp: 0, soldDown: 0, proceeds: 0 }; }
function orderFilledSize(order: any): number { const value = Number(order?.size_matched ?? order?.sizeMatched ?? order?.filled_size ?? order?.filledSize ?? 0); return Number.isFinite(value) ? value : 0; }
function minimumOrderSize(orderBook: any): number | undefined { const value = Number(orderBook?.min_order_size ?? orderBook?.minOrderSize); return Number.isFinite(value) && value > 0 ? value : undefined; }
function describeClobResponse(response: any): string { const detail = response?.errorMsg ?? response?.error_msg ?? response?.error ?? response?.message ?? response?.status ?? response; try { return typeof detail === "string" ? detail : JSON.stringify(detail); } catch { return String(detail); } }
function isFinal(status: string): boolean { return ["FILLED", "MATCHED", "CANCELLED", "CANCELED", "REJECTED", "FAILED"].includes(status.toUpperCase()); }
function optional(value: number | null | undefined, digits = 6): string | undefined { return value === null || value === undefined || !Number.isFinite(value) ? undefined : value.toFixed(digits); }
function csvValue(value: RecordRow[keyof RecordRow]): string { if (value === undefined) return ""; const text = String(value); return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
function appendRecord(path: string, row: RecordRow): void { mkdirSync(dirname(path), { recursive: true }); if (!existsSync(path)) appendFileSync(path, `${RECORD_HEADERS.join(",")}\n`); appendFileSync(path, `${RECORD_HEADERS.map((header) => csvValue(row[header])).join(",")}\n`); }
function resolveRecordPathForSchema(path: string): string { const header = RECORD_HEADERS.join(","); if (!existsSync(path) || readFileSync(path, "utf8").split(/\r?\n/, 1)[0] === header) return path; for (let version = 2; version < 100; version++) { const candidate = path.replace(/\.csv$/i, `-v${version}.csv`); if (!existsSync(candidate) || readFileSync(candidate, "utf8").split(/\r?\n/, 1)[0] === header) return candidate; } throw new Error("Unable to allocate overlay record file"); }

class TrendRangeOverlayBot {
    private ws: WebSocketOrderBook | null = null;
    private btc: BtcPriceProvider;
    private tokens: MarketTokens | null = null;
    private trendState: Btc5mTrendPullbackState = {};
    private highState: Btc5mSustainedHighState = {};
    private btcOpenPrice?: number;
    private trendSpentUp = 0;
    private trendSpentDown = 0;
    private rangeEnabled = false;
    private previousMetrics?: Btc5mTrendRangeRegimeMetrics;
    private snapshots: Btc5mPreviousCycleSnapshot[] = [];
    private deepHistory: Btc5mRegimeSnapshot[] = [];
    private deepExited: Record<Leg, boolean> = { UP: false, DOWN: false };
    private lastDeepSnapshotAt = 0;
    private orders: PlacedOrder[] = [];
    private accounting: CycleAccounting | null = null;
    private accountingByAsset = new Map<string, CycleAccounting>();
    private timers: NodeJS.Timeout[] = [];
    private evaluating = false;
    private switchingCycle = false;
    private stopped = false;
    private orderRetryAfter = new Map<string, number>();
    private lastMarketUpdateAt = 0;
    private lastMarketReconnectAt = 0;

    constructor(private client: ClobClient, private cfg: OverlayConfig) {
        this.btc = new BtcPriceProvider({ urls: cfg.btcPriceUrls, refreshIntervalMs: cfg.btcPriceRefreshMs, maxStalenessMs: cfg.btcPriceMaxStaleMs });
    }

    async start(): Promise<void> {
        logger.info(`Starting ${this.cfg.mode}: trend=${this.cfg.triggerPrice}->${this.cfg.entryPrice}, high=${this.cfg.highEnabled ? `${this.cfg.high.triggerPrice}->${this.cfg.high.entryPrice}` : "off"}, range=${this.cfg.rangeFirstPrice}/${this.cfg.rangeSecondPrice}, deep=${this.cfg.deepEnabled ? `${this.cfg.deep.minEntryPrice}-${this.cfg.deep.maxEntryPrice}/+${this.cfg.deep.takeProfitPrice}` : "off"}, dryRun=${this.cfg.dryRun}`);
        logger.info(`Trajectory CSV: ${this.cfg.recordPath}`);
        await this.btc.start();
        this.ws = new WebSocketOrderBook("market", [], null, this.cfg.marketLogIntervalMs);
        await this.ws.connect();
        this.ws.onMarketResolved((payload) => this.handleResolution(payload));
        await this.initializeCycle();
        this.timers.push(setInterval(() => void this.handleCycleTick(), 2000));
        this.timers.push(setInterval(() => void this.evaluate(), this.cfg.evaluationIntervalMs));
        this.timers.push(setInterval(() => void this.pollOrders(), this.cfg.orderPollIntervalMs));
    }

    async stop(): Promise<void> {
        this.stopped = true;
        for (const timer of this.timers) clearInterval(timer);
        await this.cancelOrders(() => true, "shutdown");
        this.btc.stop();
        this.ws?.disconnect();
    }

    private async handleCycleTick(): Promise<void> {
        if (this.stopped || this.switchingCycle) return;
        const current = cycleForNow(this.cfg.market, this.cfg.intervalMinutes);
        if (!this.tokens || current.slug !== this.tokens.slug) {
            this.switchingCycle = true;
            try {
                if (this.tokens) {
                    const metrics = classifyPreviousCycleRegime(this.snapshots, this.cfg);
                    this.previousMetrics = metrics;
                    this.rangeEnabled = metrics.oscillating;
                    this.recordClassification(this.tokens, metrics);
                    logger.info(`Previous cycle regime: oscillating=${metrics.oscillating}, band=${metrics.bandRatio.toFixed(2)}, swings=${metrics.crossCount}, range=${metrics.priceRange.toFixed(2)}, chop=${metrics.choppiness.toFixed(2)}; nextRange=${this.rangeEnabled}`);
                }
                await this.cancelOrders(() => true, "new cycle");
                this.resetCycle();
                await this.initializeCycle();
            } finally {
                this.switchingCycle = false;
            }
            return;
        }
        const now = Date.now();
        if (now - this.lastMarketUpdateAt > this.cfg.marketDataStaleSeconds * 1000 && now - this.lastMarketReconnectAt > this.cfg.marketDataStaleSeconds * 1000) {
            this.lastMarketReconnectAt = now;
            this.lastMarketUpdateAt = now;
            this.ws?.forceReconnect(`no price update for ${this.cfg.marketDataStaleSeconds}s on ${this.tokens.slug}`);
        }
        if ((this.tokens.endMs - Date.now()) / 1000 <= this.cfg.cancelSecondsBeforeEnd) await this.cancelOrders(() => true, "cycle ending");
    }

    private resetCycle(): void {
        this.tokens = null;
        this.trendState = {};
        this.highState = {};
        this.btcOpenPrice = undefined;
        this.trendSpentUp = 0;
        this.trendSpentDown = 0;
        this.snapshots = [];
        this.deepHistory = [];
        this.deepExited = { UP: false, DOWN: false };
        this.lastDeepSnapshotAt = 0;
        this.orders = [];
        this.orderRetryAfter.clear();
        this.lastMarketUpdateAt = 0;
        this.accounting = null;
    }

    private async initializeCycle(): Promise<void> {
        try {
            const tokens = await fetchTokens(cycleForNow(this.cfg.market, this.cfg.intervalMinutes));
            if (!this.cfg.dryRun) {
                try {
                    const [upBook, downBook] = await Promise.all([this.client.getOrderBook(tokens.upTokenId), this.client.getOrderBook(tokens.downTokenId)]);
                    tokens.upMinOrderSize = minimumOrderSize(upBook);
                    tokens.downMinOrderSize = minimumOrderSize(downBook);
                    logger.info(`CLOB minimum order size: UP=${tokens.upMinOrderSize ?? "unknown"}, DOWN=${tokens.downMinOrderSize ?? "unknown"}`);
                } catch (error) {
                    logger.warning(`Failed to fetch CLOB minimum order size: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            this.tokens = tokens;
            this.lastMarketUpdateAt = Date.now();
            this.accounting = { tokens, trend: emptyComponent(), range: emptyComponent(), high: emptyComponent(), deep: emptyComponent(), resolved: false };
            this.accountingByAsset.set(tokens.upTokenId, this.accounting);
            this.accountingByAsset.set(tokens.downTokenId, this.accounting);
            if (!this.ws) throw new Error("WebSocket unavailable");
            this.ws.subscribeToTokenIds([tokens.upTokenId, tokens.downTokenId]);
            this.ws.setTokenLabel(tokens.upTokenId, "Up"); this.ws.setTokenLabel(tokens.downTokenId, "Down"); this.ws.setTokenPair(tokens.upTokenId, tokens.downTokenId);
            const markMarketUpdate = () => { if (this.tokens?.slug === tokens.slug) this.lastMarketUpdateAt = Date.now(); };
            this.ws.onPriceUpdate(tokens.upTokenId, markMarketUpdate); this.ws.onPriceUpdate(tokens.downTokenId, markMarketUpdate);
            logger.info(`Cycle ready: ${tokens.slug}, rangeEnabled=${this.rangeEnabled}`);
        } catch (error) { logger.error(`Failed to initialize overlay cycle: ${error instanceof Error ? error.message : String(error)}`); }
    }

    private async evaluate(): Promise<void> {
        if (this.stopped || this.switchingCycle || this.evaluating || !this.tokens || !this.ws) return;
        this.evaluating = true;
        try {
            const now = Date.now(); const secondsLeft = Math.max(0, (this.tokens.endMs - now) / 1000);
            const up = this.ws.getPrice(this.tokens.upTokenId); const down = this.ws.getPrice(this.tokens.downTokenId);
            if (!up?.bestAsk || !down?.bestAsk) return;
            if (up.mid !== null && up.mid !== undefined) this.snapshots.push({ timestampMs: now, secondsLeft, upMid: up.mid });
            if (secondsLeft <= this.cfg.cancelSecondsBeforeEnd) {
                await this.cancelOrders(() => true, "cycle ending");
                this.recordDecision(now, secondsLeft, up, down, this.btc.getPrice() ?? undefined, this.btc.getSnapshot()?.source, "cycle ending", [], "cycle ending", [], "cycle ending", [], "cycle ending", []);
                return;
            }
            await this.fillDryRunOrders(now, up.bestAsk, down.bestAsk, up.bestBid ?? 0, down.bestBid ?? 0);
            const btcPrice = this.btc.getPrice(); const btcSource = this.btc.getSnapshot()?.source;
            if (btcPrice !== null && btcPrice !== undefined && this.btcOpenPrice === undefined) this.btcOpenPrice = btcPrice;
            if (this.cfg.deepEnabled && btcPrice !== null && btcPrice !== undefined && now - this.lastDeepSnapshotAt >= 1000) {
                this.deepHistory.push({ t: now, upAsk: up.bestAsk, downAsk: down.bestAsk, btcPrice });
                this.deepHistory = this.deepHistory.filter((snapshot) => now - snapshot.t <= 60_000);
                this.lastDeepSnapshotAt = now;
            }
            const trendParams = { ...this.cfg, postFillTakeProfitPrice: this.rangeEnabled ? this.cfg.conditionalTrendTakeProfitPrice : 0 };
            const previousState = this.trendState;
            const trend = buildBtc5mTrendPullbackOrders({ timestampMs: now, endMs: this.tokens.endMs, upAsk: up.bestAsk, downAsk: down.bestAsk, upBid: up.bestBid ?? undefined, downBid: down.bestBid ?? undefined, btcPrice: btcPrice ?? undefined, spentUp: this.trendSpentUp, spentDown: this.trendSpentDown, state: this.trendState, params: trendParams });
            this.trendState = trend.state;
            if (!previousState.cancelled && this.trendState.cancelled) await this.cancelOrders((order) => order.role === "trend-entry", trend.reason || "trend cancelled");
            await this.syncTrendOrders(trend.quotes);
            if (this.trendState.filled && this.activeOrders((order) => order.role === "high-entry").length) {
                this.highState = { ...this.highState, cancelled: true };
                await this.cancelOrders((order) => order.role === "high-entry", "trend entry filled");
            }
            const previousHighState = this.highState;
            const high = this.cfg.highEnabled && !this.rangeEnabled && !this.trendState.filled
                ? buildBtc5mSustainedHighOrders({ timestampMs: now, endMs: this.tokens.endMs, upAsk: up.bestAsk, downAsk: down.bestAsk, btcPrice: btcPrice ?? undefined, openPrice: this.btcOpenPrice, state: this.highState, params: this.cfg.high })
                : { quotes: [], state: this.highState, reason: this.rangeEnabled ? "sustained-high disabled in range cycle" : "sustained-high disabled" };
            this.highState = high.state;
            if (!previousHighState.cancelled && this.highState.cancelled) await this.cancelOrders((order) => order.role === "high-entry", high.reason || "sustained-high cancelled");
            if (this.trendState.cancelled && !this.trendState.filled) await this.syncHighOrders(high.quotes);
            const range = await this.syncRangeOrders(secondsLeft);
            const deep = this.cfg.deepEnabled && this.accounting
                ? buildBtc5mDeepReboundOrders({
                    timestampMs: now, endMs: this.tokens.endMs, btcPrice: btcPrice ?? undefined, openPrice: this.btcOpenPrice,
                    up: { bestAsk: up.bestAsk, bestBid: up.bestBid ?? undefined, mid: up.mid ?? undefined },
                    down: { bestAsk: down.bestAsk, bestBid: down.bestBid ?? undefined, mid: down.mid ?? undefined },
                    positions: { UP: this.deepPosition("UP"), DOWN: this.deepPosition("DOWN") }, history: this.deepHistory,
                    params: this.cfg.deep, emitRestingTakeProfit: true,
                })
                : { quotes: [], reason: "deep-rebound disabled" };
            await this.syncDeepOrders(deep.quotes);
            this.recordDecision(now, secondsLeft, up, down, btcPrice ?? undefined, btcSource, trend.reason, trend.quotes, range.reason, range.quotes, high.reason, high.quotes, deep.reason, deep.quotes);
        } finally { this.evaluating = false; }
    }

    private deepPosition(leg: Leg): { shares: number; cost: number; tookProfit: boolean } {
        if (!this.accounting) return { shares: 0, cost: 0, tookProfit: this.deepExited[leg] };
        const account = this.accounting.deep;
        const bought = leg === "UP" ? account.sharesUp : account.sharesDown;
        const sold = leg === "UP" ? account.soldUp : account.soldDown;
        const shares = Math.max(0, bought - sold);
        const legCost = leg === "UP" ? account.costUp : account.costDown;
        return { shares, cost: bought > 0 ? legCost * shares / bought : 0, tookProfit: this.deepExited[leg] };
    }

    private async syncTrendOrders(quotes: Array<{ leg: Leg; side: "BUY" | "SELL"; price: number; size: number }>): Promise<void> {
        const quote = quotes[0]; if (!quote) return;
        const role: OrderRole = quote.side === "BUY" ? "trend-entry" : "trend-exit";
        if (!this.activeOrders((order) => order.role === role).length) await this.placeOrder("trend", role, quote.leg, quote.side, quote.price, quote.size);
    }

    private async syncHighOrders(quotes: Array<{ leg: Leg; side: "BUY" | "SELL"; price: number; size: number }>): Promise<void> {
        const quote = quotes[0];
        if (quote?.side === "BUY" && !this.activeOrders((order) => order.role === "high-entry").length) {
            await this.placeOrder("high", "high-entry", quote.leg, quote.side, quote.price, quote.size);
        }
    }

    private async syncDeepOrders(quotes: Array<{ leg: Leg; side: "BUY" | "SELL"; price: number; size: number; note?: string }>): Promise<void> {
        if (!this.cfg.deepEnabled || !this.accounting) return;
        for (const leg of ["UP", "DOWN"] as const) {
            const desired = quotes.find((quote) => quote.leg === leg);
            const active = this.activeOrders((order) => order.component === "deep" && order.leg === leg);
            for (const order of active) {
                const desiredRole: OrderRole | undefined = desired?.side === "BUY" ? "deep-entry" : desired?.note?.includes("take profit") ? "deep-take-profit" : desired ? "deep-risk-exit" : undefined;
                if (!desired || order.side !== desired.side || order.role !== desiredRole || Math.abs(order.price - desired.price) > 1e-9 || Math.abs(order.size - order.filledSize - desired.size) > 1e-6) {
                    await this.cancelOrder(order, "deep quote changed");
                }
            }
            if (!desired || this.activeOrders((order) => order.component === "deep" && order.leg === leg).length) continue;
            if (desired.side === "BUY" && this.deepExited[leg]) continue;
            const role: OrderRole = desired.side === "BUY" ? "deep-entry" : desired.note?.includes("take profit") ? "deep-take-profit" : "deep-risk-exit";
            await this.placeOrder("deep", role, leg, desired.side, desired.price, desired.size);
        }
    }

    private async syncRangeOrders(secondsLeft: number): Promise<{ reason: string; quotes: string[] }> {
        if (!this.rangeEnabled || secondsLeft <= this.cfg.cancelSecondsBeforeEnd || !this.accounting) return { reason: "range disabled", quotes: [] };
        const range = this.accounting.range; const up = range.sharesUp; const down = range.sharesDown;
        const target = this.cfg.rangeMaxTotalUsdc / (this.cfg.rangeFirstPrice + this.cfg.rangeSecondPrice);
        let desired: { leg: Leg; price: number; size: number; role: OrderRole }[];
        if (up <= 1e-9 && down <= 1e-9) desired = [{ leg: "UP", price: this.cfg.rangeFirstPrice, size: target, role: "range-first" }, { leg: "DOWN", price: this.cfg.rangeFirstPrice, size: target, role: "range-first" }];
        else if (up + 1e-9 < down) desired = [{ leg: "UP", price: this.cfg.rangeSecondPrice, size: down - up, role: "range-second" }];
        else if (down + 1e-9 < up) desired = [{ leg: "DOWN", price: this.cfg.rangeSecondPrice, size: up - down, role: "range-second" }];
        else desired = [];
        for (const order of this.activeOrders((item) => item.component === "range")) {
            const match = desired.find((item) => item.leg === order.leg && Math.abs(item.price - order.price) < 1e-9 && Math.abs(item.size - (order.size - order.filledSize)) < 1e-6);
            if (!match) await this.cancelOrder(order, "range quote changed");
        }
        const quoteLabels: string[] = [];
        for (const item of desired) {
            quoteLabels.push(`${item.leg}@${item.price.toFixed(2)}x${item.size.toFixed(4)}`);
            if (!this.activeOrders((order) => order.component === "range" && order.leg === item.leg).length) await this.placeOrder("range", item.role, item.leg, "BUY", item.price, item.size);
        }
        return { reason: desired.length ? "range pairing" : "range pair locked", quotes: quoteLabels };
    }

    private activeOrders(predicate: (order: PlacedOrder) => boolean): PlacedOrder[] { return this.orders.filter((order) => !isFinal(order.status) && predicate(order)); }

    private async placeOrder(component: Component, role: OrderRole, leg: Leg, side: "BUY" | "SELL", price: number, size: number): Promise<void> {
        if (!this.tokens || size <= 1e-9) return;
        const tokenId = leg === "UP" ? this.tokens.upTokenId : this.tokens.downTokenId; const placedAtMs = Date.now();
        const retryKey = `${component}:${role}:${leg}:${side}`;
        if ((this.orderRetryAfter.get(retryKey) ?? 0) > placedAtMs) return;
        const base = { slug: this.tokens.slug, conditionId: this.tokens.conditionId, component, role, leg, side, tokenId, price, size, filledSize: 0, accountedFilledSize: 0, status: "NEW", placedAtMs };
        if (this.cfg.dryRun) {
            const order = { ...base, orderId: `dry-${component}-${leg}-${placedAtMs}` } satisfies PlacedOrder; this.orders.push(order); this.recordOrder("dry_run_order_posted", order);
            return;
        }
        const minOrderSize = leg === "UP" ? this.tokens.upMinOrderSize : this.tokens.downMinOrderSize;
        if (minOrderSize !== undefined && size + 1e-9 < minOrderSize) {
            const message = `size ${size.toFixed(4)} is below CLOB minimum ${minOrderSize.toFixed(4)} shares; required budget at ${price.toFixed(2)} is at least ${(minOrderSize * price).toFixed(4)} USDC`;
            this.orderRetryAfter.set(retryKey, placedAtMs + Math.max(30, this.cfg.orderRetrySeconds) * 1000);
            this.recordPlacementError(base, message);
            logger.error(`Skipped ${component}/${role} ${leg}: ${message}`);
            return;
        }
        try {
            const response = await this.client.createAndPostOrder({ tokenID: tokenId, side: side === "BUY" ? Side.BUY : Side.SELL, price, size } satisfies UserOrder, { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk }, OrderType.GTC);
            const orderId = response?.orderID ?? response?.orderId;
            if (!orderId || response?.success === false) {
                const message = `CLOB rejected order: ${describeClobResponse(response)}`;
                this.orderRetryAfter.set(retryKey, Date.now() + this.cfg.orderRetrySeconds * 1000);
                this.recordPlacementError(base, message);
                logger.error(`Failed to post ${component}/${role}: ${message}`);
                return;
            }
            this.orderRetryAfter.delete(retryKey);
            const order = { ...base, orderId } satisfies PlacedOrder; this.orders.push(order); this.recordOrder("order_posted", order);
            logger.info(`Posted ${component}/${role} ${side} ${leg} ${size.toFixed(4)} @ ${price.toFixed(2)}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.orderRetryAfter.set(retryKey, Date.now() + this.cfg.orderRetrySeconds * 1000);
            this.recordPlacementError(base, message);
            logger.error(`Failed to post ${component}/${role}: ${message}`);
        }
    }

    private async fillDryRunOrders(now: number, upAsk: number, downAsk: number, upBid: number, downBid: number): Promise<void> {
        for (const order of this.activeOrders(() => true)) {
            if (now <= order.placedAtMs) continue;
            const marketPrice = order.leg === "UP" ? (order.side === "BUY" ? upAsk : upBid) : (order.side === "BUY" ? downAsk : downBid);
            if (order.side === "BUY" ? marketPrice > order.price : marketPrice < order.price) continue;
            this.fillDryOrder(order, order.size - order.filledSize, "dry_run_order_filled");
        }
    }

    private fillDryOrder(order: PlacedOrder, shares: number, rowType: string): void { order.filledSize += shares; order.accountedFilledSize += shares; order.status = "FILLED"; this.accountFill(order, shares); this.recordOrder(rowType, order); }

    private async pollOrders(): Promise<void> {
        if (this.cfg.dryRun || this.stopped) return;
        for (const order of this.activeOrders(() => true)) {
            try {
                const latest = await this.client.getOrder(order.orderId); if (!latest) continue;
                order.status = String((latest as any).status || order.status); order.filledSize = orderFilledSize(latest);
                const newlyFilled = Math.max(0, order.filledSize - order.accountedFilledSize);
                if (newlyFilled > 0) { order.accountedFilledSize = order.filledSize; this.accountFill(order, newlyFilled); this.recordOrder("order_fill", order); if (order.filledSize + 1e-9 < order.size) await this.cancelOrder(order, "partial fill; cancel remainder"); }
            } catch (error) { logger.error(`Failed to poll ${order.orderId.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`); }
        }
    }

    private accountFill(order: PlacedOrder, shares: number): void {
        if (!this.accounting) return; const account = this.accounting[order.component];
        if (order.side === "BUY") { account.cost += shares * order.price; if (order.leg === "UP") { account.costUp += shares * order.price; account.sharesUp += shares; } else { account.costDown += shares * order.price; account.sharesDown += shares; } }
        else { account.proceeds += shares * order.price; if (order.leg === "UP") account.soldUp += shares; else account.soldDown += shares; }
        if (order.component === "trend") {
            if (order.role === "trend-entry") { if (order.leg === "UP") this.trendSpentUp += shares * order.price; else this.trendSpentDown += shares * order.price; this.trendState = { ...this.trendState, filled: true, filledAtMs: this.trendState.filledAtMs ?? Date.now(), fillPrice: order.price, filledShares: (this.trendState.filledShares ?? 0) + shares }; }
            if (order.role === "trend-exit" && order.filledSize + 1e-9 >= order.size) this.trendState = { ...this.trendState, exited: true };
        }
        if (order.component === "high" && order.role === "high-entry") this.highState = { ...this.highState, filled: true };
        if (order.component === "deep" && order.side === "SELL" && order.filledSize + 1e-9 >= order.size) this.deepExited[order.leg] = true;
    }

    private async cancelOrders(predicate: (order: PlacedOrder) => boolean, reason: string): Promise<void> { for (const order of this.activeOrders(predicate)) await this.cancelOrder(order, reason); }
    private async cancelOrder(order: PlacedOrder, reason: string): Promise<void> {
        if (isFinal(order.status)) return;
        if (this.cfg.dryRun) { order.status = "CANCELLED"; this.recordOrder("dry_run_order_cancelled", order); return; }
        try { await this.client.cancelOrder({ orderID: order.orderId }); order.status = "CANCELLED"; this.recordOrder("order_cancelled", order); logger.info(`Cancelled ${order.component}/${order.role} (${reason})`); }
        catch (error) { logger.error(`Failed to cancel ${order.orderId.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`); }
    }

    private handleResolution(payload: MarketResolvedPayload): void {
        const accounting = this.accountingByAsset.get(payload.winningAssetId) ?? payload.assetIds.map((id) => this.accountingByAsset.get(id)).find(Boolean);
        if (!accounting || accounting.resolved) return;
        const outcome = payload.winningOutcome.toUpperCase(); const winner: Leg | undefined = payload.winningAssetId === accounting.tokens.upTokenId || outcome === "UP" ? "UP" : payload.winningAssetId === accounting.tokens.downTokenId || outcome === "DOWN" ? "DOWN" : undefined;
        if (!winner) return; accounting.resolved = true;
        const result = (component: ComponentAccounting) => { const remaining = winner === "UP" ? component.sharesUp - component.soldUp : component.sharesDown - component.soldDown; const payout = component.proceeds + Math.max(0, remaining); return { payout, pnl: payout - component.cost }; };
        const trend = result(accounting.trend); const range = result(accounting.range); const high = result(accounting.high); const deep = result(accounting.deep); const timestampMs = payload.timestamp > 10_000_000_000 ? payload.timestamp : payload.timestamp * 1000;
        if (this.cfg.recordEnabled) appendRecord(this.cfg.recordPath, { row_type: "resolution", timestamp: new Date(timestampMs || Date.now()).toISOString(), timestamp_ms: timestampMs || Date.now(), slug: accounting.tokens.slug, condition_id: accounting.tokens.conditionId, dry_run: this.cfg.dryRun, winning_outcome: winner, trend_cost: accounting.trend.cost.toFixed(6), trend_payout: trend.payout.toFixed(6), trend_pnl: trend.pnl.toFixed(6), range_cost: accounting.range.cost.toFixed(6), range_payout: range.payout.toFixed(6), range_pnl: range.pnl.toFixed(6), high_cost: accounting.high.cost.toFixed(6), high_payout: high.payout.toFixed(6), high_pnl: high.pnl.toFixed(6), deep_cost: accounting.deep.cost.toFixed(6), deep_payout: deep.payout.toFixed(6), deep_pnl: deep.pnl.toFixed(6), total_pnl: (trend.pnl + range.pnl + high.pnl + deep.pnl).toFixed(6) });
        logger.info(`Resolved ${accounting.tokens.slug}: winner=${winner}, trendPnl=${trend.pnl.toFixed(4)}, rangePnl=${range.pnl.toFixed(4)}, highPnl=${high.pnl.toFixed(4)}, deepPnl=${deep.pnl.toFixed(4)}, total=${(trend.pnl + range.pnl + high.pnl + deep.pnl).toFixed(4)}`);
        this.ws?.unsubscribeFromTokenIds([accounting.tokens.upTokenId, accounting.tokens.downTokenId]); this.ws?.offPriceUpdate(accounting.tokens.upTokenId); this.ws?.offPriceUpdate(accounting.tokens.downTokenId); this.accountingByAsset.delete(accounting.tokens.upTokenId); this.accountingByAsset.delete(accounting.tokens.downTokenId);
    }

    private recordDecision(now: number, secondsLeft: number, up: any, down: any, btcPrice: number | undefined, btcSource: string | undefined, trendReason: string | undefined, trendQuotes: any[], rangeReason: string, rangeQuotes: string[], highReason: string | undefined, highQuotes: any[], deepReason: string | undefined, deepQuotes: any[]): void {
        if (!this.cfg.recordEnabled || !this.tokens || !this.accounting) return; const metrics = this.previousMetrics;
        appendRecord(this.cfg.recordPath, { row_type: "decision", timestamp: new Date(now).toISOString(), timestamp_ms: now, slug: this.tokens.slug, condition_id: this.tokens.conditionId, dry_run: this.cfg.dryRun, btc_price: optional(btcPrice, 2), btc_source: btcSource, seconds_left: secondsLeft.toFixed(3), up_bid: optional(up.bestBid), up_ask: optional(up.bestAsk), up_mid: optional(up.mid), down_bid: optional(down.bestBid), down_ask: optional(down.bestAsk), down_mid: optional(down.mid), range_enabled: this.rangeEnabled, previous_oscillating: metrics?.oscillating, previous_sample_count: metrics?.sampleCount, previous_band_ratio: optional(metrics?.bandRatio), previous_swing_count: metrics?.crossCount, previous_price_range: optional(metrics?.priceRange), previous_choppiness: optional(metrics?.choppiness), trend_triggered_leg: this.trendState.triggeredLeg, trend_filled: Boolean(this.trendState.filled), trend_cancelled: Boolean(this.trendState.cancelled), trend_exited: Boolean(this.trendState.exited), trend_reason: trendReason, trend_quotes: trendQuotes.map((quote) => `${quote.side} ${quote.leg}@${quote.price.toFixed(2)}x${quote.size.toFixed(4)}`).join("|"), range_filled_up: optional(this.accounting.range.sharesUp), range_filled_down: optional(this.accounting.range.sharesDown), range_reason: rangeReason, range_quotes: rangeQuotes.join("|"), high_triggered_leg: this.highState.triggeredLeg, high_filled: Boolean(this.highState.filled), high_cancelled: Boolean(this.highState.cancelled), high_reason: highReason, high_quotes: highQuotes.map((quote) => `${quote.side} ${quote.leg}@${quote.price.toFixed(2)}x${quote.size.toFixed(4)}`).join("|"), deep_enabled: this.cfg.deepEnabled, deep_filled_up: optional(this.accounting.deep.sharesUp), deep_filled_down: optional(this.accounting.deep.sharesDown), deep_reason: deepReason, deep_quotes: deepQuotes.map((quote) => `${quote.side} ${quote.leg}@${quote.price.toFixed(2)}x${quote.size.toFixed(4)}`).join("|") });
    }

    private recordOrder(rowType: string, order: PlacedOrder): void { if (!this.cfg.recordEnabled) return; appendRecord(this.cfg.recordPath, { row_type: rowType, timestamp: new Date().toISOString(), timestamp_ms: Date.now(), slug: order.slug, condition_id: order.conditionId, dry_run: this.cfg.dryRun, range_enabled: this.rangeEnabled, event_component: order.component, event_role: order.role, event_leg: order.leg, event_side: order.side, event_price: order.price.toFixed(6), event_size: order.size.toFixed(6), event_cost: (order.price * order.size).toFixed(6), order_id: order.orderId, order_status: order.status, filled_size: order.filledSize.toFixed(6) }); }
    private recordPlacementError(order: Omit<PlacedOrder, "orderId">, message: string): void { if (!this.cfg.recordEnabled) return; appendRecord(this.cfg.recordPath, { row_type: "order_error", timestamp: new Date().toISOString(), timestamp_ms: Date.now(), slug: order.slug, condition_id: order.conditionId, dry_run: this.cfg.dryRun, range_enabled: this.rangeEnabled, event_component: order.component, event_role: order.role, event_leg: order.leg, event_side: order.side, event_price: order.price.toFixed(6), event_size: order.size.toFixed(6), event_cost: (order.price * order.size).toFixed(6), order_status: "ERROR", filled_size: order.filledSize.toFixed(6), event_error: message }); }
    private recordClassification(tokens: MarketTokens, metrics: Btc5mTrendRangeRegimeMetrics): void { if (!this.cfg.recordEnabled) return; appendRecord(this.cfg.recordPath, { row_type: "regime_classification", timestamp: new Date().toISOString(), timestamp_ms: Date.now(), slug: tokens.slug, condition_id: tokens.conditionId, dry_run: this.cfg.dryRun, range_enabled: metrics.oscillating, previous_oscillating: metrics.oscillating, previous_sample_count: metrics.sampleCount, previous_band_ratio: optional(metrics.bandRatio), previous_swing_count: metrics.crossCount, previous_price_range: optional(metrics.priceRange), previous_choppiness: optional(metrics.choppiness) }); }
}

async function bootstrap(cfg: OverlayConfig): Promise<ClobClient> {
    if (cfg.dryRun) return {} as ClobClient;
    if (!validatePrivateKey()) throw new Error("WALLET_PRIVATE_KEY is invalid or missing");
    await createCredential(); const client = await getClobClient();
    if (process.env.SKIP_ALLOWANCE_APPROVE !== "true") { try { await approveUSDCAllowance(); await updateClobBalanceAllowance(client); } catch (error) { logger.error(`Allowance approval failed: ${error instanceof Error ? error.message : String(error)}`); } }
    const deepBudget = cfg.deepEnabled ? cfg.deep.maxUsdcPerLeg * 2 : 0;
    const required = Math.max(config.bot.minUsdcBalance, cfg.orderUsdc + cfg.rangeMaxTotalUsdc + deepBudget, cfg.high.orderUsdc + deepBudget); const gate = await waitForMinimumUsdcBalance(client, required, { pollIntervalMs: 15_000, timeoutMs: 0, logEveryPoll: true }); if (!gate.ok) throw new Error(`USDC balance gate failed: required>=${required}`); return client;
}

async function main(): Promise<void> {
    const cfg = loadConfig(); setupConsoleFileLogging({ logFilePath: config.logging.logFilePath, logDir: config.logging.logDir, filePrefix: config.logging.logFilePrefix }); const bot = new TrendRangeOverlayBot(await bootstrap(cfg), cfg);
    const shutdown = async (signal: string) => { logger.info(`Received ${signal}, shutting down...`); await bot.stop(); process.exit(0); };
    process.once("SIGINT", () => void shutdown("SIGINT")); process.once("SIGTERM", () => void shutdown("SIGTERM")); await bot.start();
}

main().catch((error) => { logger.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
