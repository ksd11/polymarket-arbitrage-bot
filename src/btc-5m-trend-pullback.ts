import "./setup-proxy";
import "./patch-exchange-v2";

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { ClobClient, CreateOrderOptions, OrderType, Side, UserOrderV2 as UserOrder } from "@polymarket/clob-client-v2";
import { config } from "./config";
import { getClobClient } from "./providers/clobclient";
import { BtcPriceProvider, defaultBtcPriceConfig } from "./providers/btcPriceProvider";
import { MarketResolvedPayload, WebSocketOrderBook } from "./providers/websocketOrderbook";
import { createCredential } from "./security/createCredential";
import { approveUSDCAllowance, updateClobBalanceAllowance } from "./security/allowance";
import { validatePrivateKey } from "./security/validatePrivateKey";
import {
    buildBtc5mTrendPullbackOrders,
    Btc5mTrendPullbackParams,
    Btc5mTrendPullbackState,
} from "./strategies/btc5m/trend-pullback";
import { waitForMinimumUsdcBalance } from "./utils/balance";
import { setupConsoleFileLogging } from "./utils/console-file";
import { logger } from "./utils/logger";

type Leg = "UP" | "DOWN";

type TrendPullbackConfig = Btc5mTrendPullbackParams & {
    dryRun: boolean;
    market: string;
    intervalMinutes: number;
    tickSize: CreateOrderOptions["tickSize"];
    negRisk: boolean;
    cancelSecondsBeforeEnd: number;
    evaluationIntervalMs: number;
    orderPollIntervalMs: number;
    btcPriceRefreshMs: number;
    btcPriceMaxStaleMs: number;
    btcPriceUrls: string[];
    recordEnabled: boolean;
    recordPath: string;
};

type MarketTokens = {
    slug: string;
    upTokenId: string;
    downTokenId: string;
    conditionId: string;
    startMs: number;
    endMs: number;
};

type PlacedOrder = {
    leg: Leg;
    side: "BUY" | "SELL";
    orderId: string;
    tokenId: string;
    price: number;
    size: number;
    filledSize: number;
    accountedFilledSize: number;
    status: string;
    placedAtMs: number;
};

type CycleAccounting = {
    tokens: MarketTokens;
    entryLeg?: Leg;
    entryCost: number;
    filledShares: number;
    exitProceeds: number;
    exitedShares: number;
    resolved: boolean;
};

const RECORD_HEADERS = [
    "row_type", "timestamp", "timestamp_ms", "slug", "condition_id", "dry_run",
    "btc_price", "btc_source", "seconds_left",
    "up_bid", "up_ask", "up_mid", "down_bid", "down_ask", "down_mid",
    "trigger_price", "entry_price", "order_usdc", "max_order_age_seconds", "max_btc_reversal_bps",
    "post_fill_stop_loss_price", "post_fill_take_profit_price", "post_fill_max_btc_reversal_bps",
    "candidate_leg", "candidate_since_ms", "triggered_leg", "triggered_at_ms", "triggered_btc_price",
    "order_age_seconds", "btc_reversal_bps", "filled_at_ms", "fill_price", "filled_shares",
    "state_filled", "state_exited", "state_cancelled", "decision_reason", "quotes",
    "event_leg", "event_side", "event_price", "event_size", "event_cost", "order_id", "order_status", "filled_size",
    "winning_outcome", "payout", "realized_pnl",
] as const;

type RecordRow = Partial<Record<typeof RECORD_HEADERS[number], string | number | boolean>>;

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

function envBool(name: string, fallback: boolean): boolean {
    const raw = process.env[name]?.trim();
    return raw ? raw.toLowerCase() === "true" : fallback;
}

function parseList(raw: string): string[] {
    return raw.split(/[|,]/).map((value) => value.trim()).filter(Boolean);
}

function loadConfig(): TrendPullbackConfig {
    const defaultBtc = defaultBtcPriceConfig();
    const cfg: TrendPullbackConfig = {
        dryRun: envBool("TREND_PULLBACK_DRY_RUN", true),
        market: envString("TREND_PULLBACK_MARKET", envString("BTC5M_MARKET", "btc")).toLowerCase(),
        intervalMinutes: envNumber("TREND_PULLBACK_INTERVAL_MINUTES", envNumber("BTC5M_INTERVAL_MINUTES", 5)),
        tickSize: envString("TREND_PULLBACK_TICK_SIZE", envString("BTC5M_TICK_SIZE", "0.01")) as CreateOrderOptions["tickSize"],
        negRisk: envBool("TREND_PULLBACK_NEG_RISK", envBool("BTC5M_NEG_RISK", config.copytrade.negRisk)),
        cancelSecondsBeforeEnd: envNumber("TREND_PULLBACK_CANCEL_SECONDS_BEFORE_END", envNumber("BTC5M_CANCEL_SECONDS_BEFORE_END", 5)),
        evaluationIntervalMs: envNumber("TREND_PULLBACK_EVALUATION_INTERVAL_MS", 1000),
        orderPollIntervalMs: envNumber("TREND_PULLBACK_ORDER_POLL_INTERVAL_MS", 2000),
        btcPriceRefreshMs: envNumber("TREND_PULLBACK_BTC_PRICE_REFRESH_MS", envNumber("BTC5M_BTC_PRICE_REFRESH_MS", defaultBtc.refreshIntervalMs)),
        btcPriceMaxStaleMs: envNumber("TREND_PULLBACK_BTC_PRICE_MAX_STALE_MS", envNumber("BTC5M_BTC_PRICE_MAX_STALE_MS", defaultBtc.maxStalenessMs)),
        btcPriceUrls: parseList(envString("TREND_PULLBACK_BTC_PRICE_URLS", defaultBtc.urls.join("|"))),
        triggerPrice: envNumber("TREND_PULLBACK_TRIGGER_PRICE", 0.85),
        entryPrice: envNumber("TREND_PULLBACK_ENTRY_PRICE", 0.80),
        orderUsdc: envNumber("TREND_PULLBACK_ORDER_USDC", 1.6),
        maxUsdcPerLeg: envNumber("TREND_PULLBACK_MAX_USDC_PER_LEG", 1.6),
        minSecondsLeftToTrigger: envNumber("TREND_PULLBACK_MIN_SECONDS_LEFT_TO_TRIGGER", 30),
        minSecondsLeftToFill: envNumber("TREND_PULLBACK_MIN_SECONDS_LEFT_TO_FILL", 0),
        triggerConfirmSeconds: envNumber("TREND_PULLBACK_TRIGGER_CONFIRM_SECONDS", 0),
        maxOrderAgeSeconds: envNumber("TREND_PULLBACK_MAX_ORDER_AGE_SECONDS", 8),
        maxBtcReversalBps: envNumber("TREND_PULLBACK_MAX_BTC_REVERSAL_BPS", 2),
        postFillStopLossPrice: envNumber("TREND_PULLBACK_POST_FILL_STOP_LOSS_PRICE", 0),
        postFillTakeProfitPrice: envNumber("TREND_PULLBACK_POST_FILL_TAKE_PROFIT_PRICE", 0),
        postFillMaxBtcReversalBps: envNumber("TREND_PULLBACK_POST_FILL_MAX_BTC_REVERSAL_BPS", 0),
        recordEnabled: envBool("TREND_PULLBACK_RECORD_ENABLED", true),
        recordPath: resolve(envString("TREND_PULLBACK_RECORD_FILE", "data/btc5m-trend-pullback-live.csv")),
    };

    if (cfg.intervalMinutes <= 0) throw new Error("TREND_PULLBACK_INTERVAL_MINUTES must be > 0");
    if (!(cfg.triggerPrice > 0 && cfg.triggerPrice < 1)) throw new Error("TREND_PULLBACK_TRIGGER_PRICE must be between 0 and 1");
    if (!(cfg.entryPrice > 0 && cfg.entryPrice < cfg.triggerPrice)) throw new Error("TREND_PULLBACK_ENTRY_PRICE must be below trigger price");
    if (cfg.orderUsdc <= 0) throw new Error("TREND_PULLBACK_ORDER_USDC must be > 0");
    if (cfg.maxUsdcPerLeg < cfg.orderUsdc) throw new Error("TREND_PULLBACK_MAX_USDC_PER_LEG must be >= TREND_PULLBACK_ORDER_USDC");
    if (cfg.minSecondsLeftToTrigger < 0 || cfg.minSecondsLeftToFill < 0 || cfg.cancelSecondsBeforeEnd < 0) throw new Error("Trend-pullback time settings must be >= 0");
    if (cfg.triggerConfirmSeconds < 0 || cfg.maxOrderAgeSeconds < 0 || cfg.maxBtcReversalBps < 0) throw new Error("Trend-pullback guard settings must be >= 0");
    if (!(cfg.postFillStopLossPrice >= 0 && cfg.postFillStopLossPrice < cfg.entryPrice)) throw new Error("TREND_PULLBACK_POST_FILL_STOP_LOSS_PRICE must be >= 0 and below entry price");
    if (!(cfg.postFillTakeProfitPrice >= 0 && cfg.postFillTakeProfitPrice <= 1)) throw new Error("TREND_PULLBACK_POST_FILL_TAKE_PROFIT_PRICE must be between 0 and 1");
    if (cfg.postFillMaxBtcReversalBps < 0) throw new Error("TREND_PULLBACK_POST_FILL_MAX_BTC_REVERSAL_BPS must be >= 0");
    if (cfg.evaluationIntervalMs < 250 || cfg.orderPollIntervalMs < 250) throw new Error("Trend-pullback intervals must be >= 250ms");
    if (cfg.maxBtcReversalBps > 0 && cfg.btcPriceUrls.length === 0) throw new Error("TREND_PULLBACK_BTC_PRICE_URLS is required when BTC reversal protection is enabled");
    if (cfg.recordEnabled) cfg.recordPath = resolveRecordPathForSchema(cfg.recordPath);
    return cfg;
}

function cycleStart(now: Date, intervalMinutes: number): Date {
    const date = new Date(now);
    date.setSeconds(0, 0);
    date.setMinutes(Math.floor(date.getMinutes() / intervalMinutes) * intervalMinutes, 0, 0);
    return date;
}

function slugForCycle(market: string, intervalMinutes: number, now = new Date()): { slug: string; startMs: number; endMs: number } {
    const startMs = cycleStart(now, intervalMinutes).getTime();
    return {
        slug: `${market}-updown-${intervalMinutes}m-${Math.floor(startMs / 1000)}`,
        startMs,
        endMs: startMs + intervalMinutes * 60_000,
    };
}

function parseJsonArray<T>(raw: unknown, context: string): T[] {
    if (typeof raw !== "string") throw new Error(`${context}: expected JSON string`);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${context}: expected JSON array`);
    return parsed as T[];
}

async function fetchTokens(slug: string, startMs: number, endMs: number): Promise<MarketTokens> {
    const response = await fetch(`https://gamma-api.polymarket.com/markets/slug/${slug}`);
    if (!response.ok) throw new Error(`Gamma API ${response.status} ${response.statusText} for slug=${slug}`);
    const data = (await response.json()) as any;
    const outcomes = parseJsonArray<string>(data.outcomes, "outcomes");
    const tokenIds = parseJsonArray<string>(data.clobTokenIds, "clobTokenIds");
    const upIndex = outcomes.indexOf("Up");
    const downIndex = outcomes.indexOf("Down");
    if (upIndex < 0 || downIndex < 0 || !tokenIds[upIndex] || !tokenIds[downIndex]) throw new Error(`Missing UP/DOWN tokens for ${slug}`);
    return {
        slug,
        upTokenId: tokenIds[upIndex],
        downTokenId: tokenIds[downIndex],
        conditionId: String(data.conditionId || ""),
        startMs,
        endMs,
    };
}

function orderFilledSize(order: any): number {
    const value = order?.size_matched ?? order?.sizeMatched ?? order?.filled_size ?? order?.filledSize ?? 0;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function isFinalOrderStatus(status: string): boolean {
    return ["FILLED", "MATCHED", "CANCELLED", "CANCELED", "REJECTED", "FAILED"].includes(status.toUpperCase());
}

function csvValue(value: string | number | boolean | undefined): string {
    if (value === undefined) return "";
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function appendRecord(path: string, row: RecordRow): void {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) appendFileSync(path, `${RECORD_HEADERS.join(",")}\n`);
    appendFileSync(path, `${RECORD_HEADERS.map((header) => csvValue(row[header])).join(",")}\n`);
}

function resolveRecordPathForSchema(path: string): string {
    const expectedHeader = RECORD_HEADERS.join(",");
    if (!existsSync(path) || readFileSync(path, "utf8").split(/\r?\n/, 1)[0] === expectedHeader) return path;
    for (let version = 2; version < 100; version++) {
        const candidate = path.replace(/\.csv$/i, `-v${version}.csv`);
        if (!existsSync(candidate) || readFileSync(candidate, "utf8").split(/\r?\n/, 1)[0] === expectedHeader) {
            logger.warning(`Trend-pullback log schema changed; preserving ${path} and writing new rows to ${candidate}`);
            return candidate;
        }
    }
    throw new Error(`Unable to allocate a compatible trend-pullback record file for ${path}`);
}

function optionalNumber(value: number | null | undefined, digits = 6): string | undefined {
    return value === null || value === undefined || !Number.isFinite(value) ? undefined : value.toFixed(digits);
}

class BtcFiveMinuteTrendPullbackBot {
    private ws: WebSocketOrderBook | null = null;
    private btcPrice: BtcPriceProvider;
    private tokens: MarketTokens | null = null;
    private state: Btc5mTrendPullbackState = {};
    private order: PlacedOrder | null = null;
    private exitOrder: PlacedOrder | null = null;
    private accounting: CycleAccounting | null = null;
    private accountingByAssetId = new Map<string, CycleAccounting>();
    private entryExpiryTimer: NodeJS.Timeout | null = null;
    private spentUp = 0;
    private spentDown = 0;
    private timers: NodeJS.Timeout[] = [];
    private stopped = false;
    private evaluating = false;

    constructor(private client: ClobClient, private cfg: TrendPullbackConfig) {
        this.btcPrice = new BtcPriceProvider({
            urls: cfg.btcPriceUrls,
            refreshIntervalMs: cfg.btcPriceRefreshMs,
            maxStalenessMs: cfg.btcPriceMaxStaleMs,
        });
    }

    async start(): Promise<void> {
        logger.info(`Starting BTC 5m trend-pullback: trigger=${this.cfg.triggerPrice}, entry=${this.cfg.entryPrice}, orderUsdc=${this.cfg.orderUsdc}, reversal=${this.cfg.maxBtcReversalBps}bps, dryRun=${this.cfg.dryRun}`);
        if (this.cfg.recordEnabled) logger.info(`Trend-pullback market/decision CSV: ${this.cfg.recordPath}`);
        await this.btcPrice.start();
        this.ws = new WebSocketOrderBook("market", [], null);
        await this.ws.connect();
        this.ws.onMarketResolved((payload) => this.handleMarketResolved(payload));
        await this.initializeCurrentCycle();
        this.timers.push(setInterval(() => void this.handleCycleTick(), 2_000));
        this.timers.push(setInterval(() => void this.evaluate(), this.cfg.evaluationIntervalMs));
        this.timers.push(setInterval(() => void this.pollOrder(), this.cfg.orderPollIntervalMs));
    }

    async stop(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        await this.cancelAllOrders("shutdown");
        this.btcPrice.stop();
        this.ws?.disconnect();
        logger.info("BTC 5m trend-pullback stopped");
    }

    private async handleCycleTick(): Promise<void> {
        if (this.stopped) return;
        const current = slugForCycle(this.cfg.market, this.cfg.intervalMinutes);
        if (!this.tokens || current.slug !== this.tokens.slug) {
            await this.cancelAllOrders("new cycle");
            this.resetCycle();
            await this.initializeCurrentCycle();
            return;
        }
        const secondsLeft = (this.tokens.endMs - Date.now()) / 1000;
        if (secondsLeft <= this.cfg.cancelSecondsBeforeEnd) await this.cancelAllOrders(`cycle ending in ${secondsLeft.toFixed(1)}s`);
    }

    private resetCycle(): void {
        this.tokens = null;
        this.state = {};
        if (this.entryExpiryTimer) clearTimeout(this.entryExpiryTimer);
        this.entryExpiryTimer = null;
        this.order = null;
        this.exitOrder = null;
        this.accounting = null;
        this.spentUp = 0;
        this.spentDown = 0;
    }

    private async initializeCurrentCycle(): Promise<void> {
        const cycle = slugForCycle(this.cfg.market, this.cfg.intervalMinutes);
        try {
            this.tokens = await fetchTokens(cycle.slug, cycle.startMs, cycle.endMs);
            this.accounting = { tokens: this.tokens, entryCost: 0, filledShares: 0, exitProceeds: 0, exitedShares: 0, resolved: false };
            this.accountingByAssetId.set(this.tokens.upTokenId, this.accounting);
            this.accountingByAssetId.set(this.tokens.downTokenId, this.accounting);
            logger.info(`Cycle ready: ${this.tokens.slug}`);
            if (!this.ws) throw new Error("WebSocket is not initialized");
            this.ws.subscribeToTokenIds([this.tokens.upTokenId, this.tokens.downTokenId]);
            this.ws.setTokenLabel(this.tokens.upTokenId, "Up");
            this.ws.setTokenLabel(this.tokens.downTokenId, "Down");
            this.ws.setTokenPair(this.tokens.upTokenId, this.tokens.downTokenId);
            this.ws.onPriceUpdate(this.tokens.upTokenId, () => undefined);
            this.ws.onPriceUpdate(this.tokens.downTokenId, () => undefined);
        } catch (error) {
            logger.error(`Failed to initialize trend-pullback market: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async evaluate(): Promise<void> {
        if (this.stopped || this.evaluating || !this.tokens || !this.ws) return;
        this.evaluating = true;
        try {
            const now = Date.now();
            const secondsLeft = Math.max(0, (this.tokens.endMs - now) / 1000);
            const up = this.ws.getPrice(this.tokens.upTokenId);
            const down = this.ws.getPrice(this.tokens.downTokenId);
            if (!up?.bestAsk || !down?.bestAsk) return;

            const btcSnapshot = this.btcPrice.getSnapshot();
            const btcPrice = this.btcPrice.getPrice();
            await this.maybeFillDryRun(now, up.bestAsk, down.bestAsk);

            if (this.cfg.maxBtcReversalBps > 0 && btcPrice === null) {
                this.recordDecision(now, secondsLeft, up, down, undefined, btcSnapshot?.source, "trend-pullback waiting for BTC price", []);
                return;
            }

            const previousState = this.state;
            const decision = buildBtc5mTrendPullbackOrders({
                timestampMs: now,
                endMs: this.tokens.endMs,
                upAsk: up.bestAsk,
                downAsk: down.bestAsk,
                upBid: up.bestBid ?? undefined,
                downBid: down.bestBid ?? undefined,
                btcPrice: btcPrice ?? undefined,
                spentUp: this.spentUp,
                spentDown: this.spentDown,
                state: this.state,
                params: this.cfg,
            });
            this.state = decision.state;
            this.recordDecision(now, secondsLeft, up, down, btcPrice ?? undefined, btcSnapshot?.source, decision.reason, decision.quotes);

            logger.info(`Trend-pullback eval: btc=${btcPrice?.toFixed(2) ?? "--"} upAsk=${up.bestAsk.toFixed(4)} downAsk=${down.bestAsk.toFixed(4)} secLeft=${secondsLeft.toFixed(0)} state=${this.stateLabel()} decision=${decision.reason ?? "--"}`);

            if (!previousState.cancelled && this.state.cancelled) {
                await this.cancelPlacedOrder(this.order, decision.reason ?? "strategy cancelled");
                return;
            }
            const quote = decision.quotes[0];
            if (quote?.side === "BUY" && !this.order) await this.placeOrder(quote.leg, "BUY", quote.price, quote.size);
            if (quote?.side === "SELL" && !this.exitOrder) await this.placeOrder(quote.leg, "SELL", quote.price, quote.size);
        } finally {
            this.evaluating = false;
        }
    }

    private async placeOrder(leg: Leg, side: "BUY" | "SELL", price: number, size: number): Promise<void> {
        if (!this.tokens) return;
        const tokenId = leg === "UP" ? this.tokens.upTokenId : this.tokens.downTokenId;
        const placedAtMs = Date.now();
        if (this.cfg.dryRun) {
            const placed = { leg, side, orderId: `dry-${placedAtMs}`, tokenId, price, size, filledSize: 0, accountedFilledSize: 0, status: "NEW", placedAtMs } satisfies PlacedOrder;
            if (side === "BUY") this.order = placed;
            else this.exitOrder = placed;
            logger.info(`[DRY-RUN] Posted ${side} ${leg} ${size.toFixed(4)} @ ${price.toFixed(4)} (${(price * size).toFixed(4)} USDC)`);
            this.recordOrderEvent("dry_run_order_posted", placed);
            if (side === "BUY") this.scheduleEntryExpiry();
            if (side === "SELL") this.fillDryRunExit(placed);
            return;
        }

        const order: UserOrder = { tokenID: tokenId, side: side === "BUY" ? Side.BUY : Side.SELL, price, size };
        try {
            const response = await this.client.createAndPostOrder(order, { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk }, OrderType.GTC);
            if (!response?.orderID) throw new Error("CLOB returned no orderID");
            const placed = { leg, side, orderId: response.orderID, tokenId, price, size, filledSize: 0, accountedFilledSize: 0, status: "NEW", placedAtMs } satisfies PlacedOrder;
            if (side === "BUY") this.order = placed;
            else this.exitOrder = placed;
            logger.info(`Posted ${side} ${leg} ${response.orderID.slice(0, 12)}...: ${size.toFixed(4)} @ ${price.toFixed(4)}`);
            this.recordOrderEvent("order_posted", placed);
            if (side === "BUY") this.scheduleEntryExpiry();
        } catch (error) {
            logger.error(`Failed to post trend-pullback ${leg}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async maybeFillDryRun(now: number, upAsk: number, downAsk: number): Promise<void> {
        if (!this.cfg.dryRun || !this.order || this.order.status !== "NEW" || now <= this.order.placedAtMs) return;
        const ask = this.order.leg === "UP" ? upAsk : downAsk;
        if (ask > this.order.price) return;
        this.order.filledSize = this.order.size;
        this.order.accountedFilledSize = this.order.size;
        this.order.status = "FILLED";
        this.clearEntryExpiry();
        this.addSpent(this.order.leg, this.order.price * this.order.size);
        this.accountEntryFill(this.order, this.order.size);
        this.state = { ...this.state, filled: true, filledAtMs: now, fillPrice: this.order.price, filledShares: this.order.size };
        logger.info(`[DRY-RUN] Filled BUY ${this.order.leg} ${this.order.size.toFixed(4)} @ ${this.order.price.toFixed(4)}; observed ask=${ask.toFixed(4)}`);
        this.recordOrderEvent("dry_run_order_filled", this.order);
    }

    private fillDryRunExit(order: PlacedOrder): void {
        order.filledSize = order.size;
        order.accountedFilledSize = order.size;
        order.status = "FILLED";
        this.accountExitFill(order, order.size);
        this.state = { ...this.state, exited: true };
        logger.info(`[DRY-RUN] Filled SELL ${order.leg} ${order.size.toFixed(4)} @ ${order.price.toFixed(4)}`);
        this.recordOrderEvent("dry_run_exit_filled", order);
    }

    private async pollOrder(): Promise<void> {
        if (this.cfg.dryRun || this.stopped) return;
        await this.pollPlacedOrder(this.order);
        await this.pollPlacedOrder(this.exitOrder);
    }

    private async pollPlacedOrder(order: PlacedOrder | null): Promise<void> {
        if (!order || isFinalOrderStatus(order.status)) return;
        try {
            const latest = await this.client.getOrder(order.orderId);
            if (!latest) return;
            order.status = String((latest as any).status || order.status);
            order.filledSize = orderFilledSize(latest);
            const newlyFilled = Math.max(0, order.filledSize - order.accountedFilledSize);
            if (newlyFilled > 0) {
                order.accountedFilledSize = order.filledSize;
                if (order.side === "BUY") {
                    this.clearEntryExpiry();
                    this.addSpent(order.leg, newlyFilled * order.price);
                    this.accountEntryFill(order, newlyFilled);
                    this.state = {
                        ...this.state,
                        filled: true,
                        filledAtMs: this.state.filledAtMs ?? Date.now(),
                        fillPrice: order.price,
                        filledShares: order.filledSize,
                    };
                } else {
                    this.accountExitFill(order, newlyFilled);
                    if (order.filledSize + 1e-9 >= order.size) this.state = { ...this.state, exited: true };
                }
                this.recordOrderEvent(order.side === "BUY" ? "order_fill" : "exit_fill", order);
                if (order.side === "BUY" && order.filledSize + 1e-9 < order.size) await this.cancelPlacedOrder(order, "partial fill; cancel remaining size");
            } else {
                this.recordOrderEvent("order_update", order);
            }
        } catch (error) {
            logger.error(`Failed to poll trend-pullback order: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private accountEntryFill(order: PlacedOrder, shares: number): void {
        if (!this.accounting) return;
        this.accounting.entryLeg = order.leg;
        this.accounting.entryCost += shares * order.price;
        this.accounting.filledShares += shares;
    }

    private accountExitFill(order: PlacedOrder, shares: number): void {
        if (!this.accounting) return;
        this.accounting.exitProceeds += shares * order.price;
        this.accounting.exitedShares += shares;
    }

    private addSpent(leg: Leg, cost: number): void {
        if (leg === "UP") this.spentUp += cost;
        else this.spentDown += cost;
    }

    private scheduleEntryExpiry(): void {
        this.clearEntryExpiry();
        if (this.cfg.maxOrderAgeSeconds <= 0 || this.state.triggeredAtMs === undefined) return;
        const expiresAtMs = this.state.triggeredAtMs + this.cfg.maxOrderAgeSeconds * 1000;
        const delayMs = Math.max(0, expiresAtMs - Date.now());
        this.entryExpiryTimer = setTimeout(() => {
            this.entryExpiryTimer = null;
            if (!this.order || isFinalOrderStatus(this.order.status)) return;
            this.state = { ...this.state, cancelled: true };
            void this.cancelPlacedOrder(this.order, `order age reached ${this.cfg.maxOrderAgeSeconds}s`);
        }, delayMs);
    }

    private clearEntryExpiry(): void {
        if (!this.entryExpiryTimer) return;
        clearTimeout(this.entryExpiryTimer);
        this.entryExpiryTimer = null;
    }

    private async cancelAllOrders(reason: string): Promise<void> {
        await this.cancelPlacedOrder(this.order, reason);
        await this.cancelPlacedOrder(this.exitOrder, reason);
    }

    private async cancelPlacedOrder(order: PlacedOrder | null, reason: string): Promise<void> {
        if (!order || isFinalOrderStatus(order.status)) return;
        if (order.side === "BUY") this.clearEntryExpiry();
        if (this.cfg.dryRun) {
            order.status = "CANCELLED";
            logger.info(`[DRY-RUN] Cancelled ${order.side} ${order.leg} order (${reason})`);
            this.recordOrderEvent("dry_run_order_cancelled", order);
            return;
        }
        try {
            await this.client.cancelOrder({ orderID: order.orderId });
            order.status = "CANCELLED";
            logger.info(`Cancelled ${order.side} ${order.leg} order ${order.orderId.slice(0, 12)}... (${reason})`);
            this.recordOrderEvent("order_cancelled", order);
        } catch (error) {
            logger.error(`Failed to cancel trend-pullback order: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private handleMarketResolved(payload: MarketResolvedPayload): void {
        const accounting = this.accountingByAssetId.get(payload.winningAssetId)
            ?? payload.assetIds.map((assetId) => this.accountingByAssetId.get(assetId)).find(Boolean);
        if (!accounting || accounting.resolved) return;
        accounting.resolved = true;
        const outcome = payload.winningOutcome.toUpperCase();
        const winner: Leg | undefined = payload.winningAssetId === accounting.tokens.upTokenId || outcome === "UP"
            ? "UP"
            : payload.winningAssetId === accounting.tokens.downTokenId || outcome === "DOWN" ? "DOWN" : undefined;
        if (!winner) return;
        const remainingShares = Math.max(0, accounting.filledShares - accounting.exitedShares);
        const settlementPayout = accounting.entryLeg === winner ? remainingShares : 0;
        const payout = accounting.exitProceeds + settlementPayout;
        const pnl = payout - accounting.entryCost;
        logger.info(`Trend-pullback resolved ${accounting.tokens.slug}: winner=${winner}, entry=${accounting.entryLeg ?? "NONE"}, cost=${accounting.entryCost.toFixed(4)}, payout=${payout.toFixed(4)}, pnl=${pnl.toFixed(4)}`);
        if (this.cfg.recordEnabled) {
            const timestampMs = payload.timestamp > 10_000_000_000 ? payload.timestamp : payload.timestamp * 1000;
            appendRecord(this.cfg.recordPath, {
                row_type: "resolution",
                timestamp: new Date(timestampMs || Date.now()).toISOString(),
                timestamp_ms: timestampMs || Date.now(),
                slug: accounting.tokens.slug,
                condition_id: accounting.tokens.conditionId,
                dry_run: this.cfg.dryRun,
                trigger_price: this.cfg.triggerPrice,
                entry_price: this.cfg.entryPrice,
                order_usdc: this.cfg.orderUsdc,
                max_btc_reversal_bps: this.cfg.maxBtcReversalBps,
                max_order_age_seconds: this.cfg.maxOrderAgeSeconds,
                post_fill_stop_loss_price: this.cfg.postFillStopLossPrice,
                post_fill_take_profit_price: this.cfg.postFillTakeProfitPrice,
                post_fill_max_btc_reversal_bps: this.cfg.postFillMaxBtcReversalBps,
                event_leg: accounting.entryLeg,
                event_side: "SETTLEMENT",
                event_size: accounting.filledShares.toFixed(6),
                event_cost: accounting.entryCost.toFixed(6),
                winning_outcome: winner,
                payout: payout.toFixed(6),
                realized_pnl: pnl.toFixed(6),
            });
        }
        this.ws?.unsubscribeFromTokenIds([accounting.tokens.upTokenId, accounting.tokens.downTokenId]);
        this.ws?.offPriceUpdate(accounting.tokens.upTokenId);
        this.ws?.offPriceUpdate(accounting.tokens.downTokenId);
        this.accountingByAssetId.delete(accounting.tokens.upTokenId);
        this.accountingByAssetId.delete(accounting.tokens.downTokenId);
    }

    private stateLabel(): string {
        if (this.state.exited) return "exited";
        if (this.state.filled) return "filled";
        if (this.state.cancelled) return "cancelled";
        if (this.state.triggeredLeg) return `pending-${this.state.triggeredLeg}`;
        if (this.state.candidateLeg) return `confirming-${this.state.candidateLeg}`;
        return "waiting";
    }

    private currentBtcReversalBps(btcPrice: number | undefined): number | undefined {
        if (!this.state.triggeredLeg || this.state.triggeredBtcPrice === undefined || btcPrice === undefined || this.state.triggeredBtcPrice <= 0) return undefined;
        const direction = this.state.triggeredLeg === "UP" ? 1 : -1;
        const directionalMoveBps = direction * (btcPrice - this.state.triggeredBtcPrice) / this.state.triggeredBtcPrice * 10_000;
        return Math.max(0, -directionalMoveBps);
    }

    private recordDecision(
        timestampMs: number,
        secondsLeft: number,
        up: { bestBid?: number | null; bestAsk?: number | null; mid?: number | null },
        down: { bestBid?: number | null; bestAsk?: number | null; mid?: number | null },
        btcPrice: number | undefined,
        btcSource: string | undefined,
        reason: string | undefined,
        quotes: Array<{ leg: string; side: string; price: number; size: number; note?: string }>,
    ): void {
        if (!this.cfg.recordEnabled || !this.tokens) return;
        appendRecord(this.cfg.recordPath, {
            row_type: "decision",
            timestamp: new Date(timestampMs).toISOString(),
            timestamp_ms: timestampMs,
            slug: this.tokens.slug,
            condition_id: this.tokens.conditionId,
            dry_run: this.cfg.dryRun,
            btc_price: optionalNumber(btcPrice, 2),
            btc_source: btcSource,
            seconds_left: secondsLeft.toFixed(3),
            up_bid: optionalNumber(up.bestBid), up_ask: optionalNumber(up.bestAsk), up_mid: optionalNumber(up.mid),
            down_bid: optionalNumber(down.bestBid), down_ask: optionalNumber(down.bestAsk), down_mid: optionalNumber(down.mid),
            trigger_price: this.cfg.triggerPrice,
            entry_price: this.cfg.entryPrice,
            order_usdc: this.cfg.orderUsdc,
            max_btc_reversal_bps: this.cfg.maxBtcReversalBps,
            max_order_age_seconds: this.cfg.maxOrderAgeSeconds,
            post_fill_stop_loss_price: this.cfg.postFillStopLossPrice,
            post_fill_take_profit_price: this.cfg.postFillTakeProfitPrice,
            post_fill_max_btc_reversal_bps: this.cfg.postFillMaxBtcReversalBps,
            candidate_leg: this.state.candidateLeg,
            candidate_since_ms: this.state.candidateSinceMs,
            triggered_leg: this.state.triggeredLeg,
            triggered_at_ms: this.state.triggeredAtMs,
            triggered_btc_price: optionalNumber(this.state.triggeredBtcPrice, 2),
            order_age_seconds: this.state.triggeredAtMs === undefined ? undefined : ((timestampMs - this.state.triggeredAtMs) / 1000).toFixed(3),
            btc_reversal_bps: optionalNumber(this.currentBtcReversalBps(btcPrice), 3),
            filled_at_ms: this.state.filledAtMs,
            fill_price: optionalNumber(this.state.fillPrice),
            filled_shares: optionalNumber(this.state.filledShares),
            state_filled: Boolean(this.state.filled),
            state_exited: Boolean(this.state.exited),
            state_cancelled: Boolean(this.state.cancelled),
            decision_reason: reason,
            quotes: quotes.map((quote) => `${quote.side} ${quote.leg}@${quote.price.toFixed(4)}x${quote.size.toFixed(4)} ${quote.note ?? ""}`.trim()).join("|"),
        });
    }

    private recordOrderEvent(rowType: string, order: PlacedOrder): void {
        if (!this.cfg.recordEnabled || !this.tokens) return;
        appendRecord(this.cfg.recordPath, {
            row_type: rowType,
            timestamp: new Date().toISOString(),
            timestamp_ms: Date.now(),
            slug: this.tokens.slug,
            condition_id: this.tokens.conditionId,
            dry_run: this.cfg.dryRun,
            trigger_price: this.cfg.triggerPrice,
            entry_price: this.cfg.entryPrice,
            order_usdc: this.cfg.orderUsdc,
            max_btc_reversal_bps: this.cfg.maxBtcReversalBps,
            event_leg: order.leg,
            event_side: order.side,
            event_price: order.price.toFixed(6),
            event_size: order.size.toFixed(6),
            event_cost: (order.price * order.size).toFixed(6),
            order_id: order.orderId,
            order_status: order.status,
            filled_size: order.filledSize.toFixed(6),
        });
    }
}

async function bootstrapClient(cfg: TrendPullbackConfig): Promise<ClobClient> {
    if (cfg.dryRun) {
        logger.info("Dry-run mode: skipping wallet, credentials, allowance, and balance checks.");
        return {} as ClobClient;
    }
    if (!validatePrivateKey()) throw new Error("WALLET_PRIVATE_KEY is invalid or missing");
    await createCredential();
    const client = await getClobClient();
    if (process.env.SKIP_ALLOWANCE_APPROVE !== "true") {
        try {
            await approveUSDCAllowance();
            await updateClobBalanceAllowance(client);
        } catch (error) {
            logger.error(`Allowance approval failed: ${error instanceof Error ? error.message : String(error)}`);
            logger.error("Continuing only if existing allowance is sufficient.");
        }
    }
    const requiredBalance = Math.max(config.bot.minUsdcBalance, cfg.orderUsdc);
    const gate = await waitForMinimumUsdcBalance(client, requiredBalance, { pollIntervalMs: 15_000, timeoutMs: 0, logEveryPoll: true });
    if (!gate.ok) throw new Error(`USDC balance gate failed: required>=${requiredBalance}`);
    return client;
}

async function main(): Promise<void> {
    const cfg = loadConfig();
    setupConsoleFileLogging({ logFilePath: config.logging.logFilePath, logDir: config.logging.logDir, filePrefix: config.logging.logFilePrefix });
    const client = await bootstrapClient(cfg);
    const bot = new BtcFiveMinuteTrendPullbackBot(client, cfg);
    const shutdown = async (signal: string) => {
        logger.info(`Received ${signal}, shutting down...`);
        await bot.stop();
        process.exit(0);
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    await bot.start();
}

main().catch((error) => {
    logger.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
