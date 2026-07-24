import "./setup-proxy";
import "./patch-exchange-v2";

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { ClobClient, CreateOrderOptions, OrderType, Side, UserOrderV2 as UserOrder } from "@polymarket/clob-client-v2";
import { config } from "./config";
import { getClobClient } from "./providers/clobclient";
import { BtcPriceProvider, defaultBtcPriceConfig } from "./providers/btcPriceProvider";
import { MarketResolvedPayload, WebSocketOrderBook } from "./providers/websocketOrderbook";
import { approveUSDCAllowance, updateClobBalanceAllowance } from "./security/allowance";
import { createCredential } from "./security/createCredential";
import { validatePrivateKey } from "./security/validatePrivateKey";
import { buildBtc5mLatencyScalpOrders, Btc5mLatencyScalpParams, Btc5mLatencyScalpState } from "./strategies/btc5m/latency-scalp";
import { buildBtc5mDeepReboundOrders, Btc5mDeepReboundParams } from "./strategies/btc5m/deep-rebound";
import { buildBtc5mFinal30HighOrders, Btc5mFinal30HighParams } from "./strategies/btc5m/final-30-high";
import { Btc5mRegimeSnapshot } from "./strategies/btc5m/regime";
import { waitForMinimumUsdcBalance } from "./utils/balance";
import { setupConsoleFileLogging } from "./utils/console-file";
import { logger } from "./utils/logger";

type Leg = "UP" | "DOWN";
type Role = "entry" | "take-profit" | "risk-exit";

type RunnerConfig = {
    mode: "latency-scalp" | "deep-rebound" | "final-30-high";
    dryRun: boolean;
    market: string;
    intervalMinutes: number;
    tickSize: CreateOrderOptions["tickSize"];
    negRisk: boolean;
    evaluationIntervalMs: number;
    orderPollIntervalMs: number;
    marketLogIntervalMs: number;
    recordIntervalMs: number;
    btcPriceRefreshMs: number;
    btcPriceMaxStaleMs: number;
    btcPriceUrls: string[];
    recordEnabled: boolean;
    recordPath: string;
    params: Btc5mLatencyScalpParams;
    deepParams: Btc5mDeepReboundParams;
    final30HighParams: Btc5mFinal30HighParams;
};

type Tokens = {
    slug: string;
    conditionId: string;
    upTokenId: string;
    downTokenId: string;
    startMs: number;
    endMs: number;
    upMinOrderSize?: number;
    downMinOrderSize?: number;
};

type TrackedOrder = {
    role: Role;
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

type Accounting = {
    tokens: Tokens;
    entryLeg?: Leg;
    cost: number;
    shares: number;
    proceeds: number;
    soldShares: number;
    resolved: boolean;
};

const HEADERS = [
    "row_type", "timestamp", "timestamp_ms", "slug", "condition_id", "dry_run",
    "btc_price", "open_price", "seconds_left", "up_bid", "up_ask", "down_bid", "down_ask",
    "candidate_leg", "triggered_leg", "state_filled", "state_cancelled", "state_exited", "decision_reason", "quotes",
    "event_role", "event_leg", "event_side", "event_price", "event_size", "event_cost", "order_id", "order_status", "filled_size", "event_error",
    "winning_outcome", "entry_cost", "exit_proceeds", "settlement_payout", "pnl",
] as const;
type RecordRow = Partial<Record<typeof HEADERS[number], string | number | boolean>>;

function envString(name: string, fallback: string): string { return process.env[name]?.trim() || fallback; }
function envNumber(name: string, fallback: number): number { const value = Number(process.env[name]?.trim()); return Number.isFinite(value) ? value : fallback; }
function envBool(name: string, fallback: boolean): boolean { const value = process.env[name]?.trim(); return value ? value.toLowerCase() === "true" : fallback; }
function parseList(value: string): string[] { return value.split(/[|,]/).map((item) => item.trim()).filter(Boolean); }
function optional(value: number | null | undefined, digits = 6): string | undefined { return value === null || value === undefined || !Number.isFinite(value) ? undefined : value.toFixed(digits); }
function csvValue(value: RecordRow[keyof RecordRow]): string { if (value === undefined) return ""; const text = String(value); return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
function appendRecord(path: string, row: RecordRow): void { mkdirSync(dirname(path), { recursive: true }); if (!existsSync(path)) appendFileSync(path, `${HEADERS.join(",")}\n`); appendFileSync(path, `${HEADERS.map((header) => csvValue(row[header])).join(",")}\n`); }
function isFinal(status: string): boolean { return ["FILLED", "MATCHED", "CANCELLED", "CANCELED", "REJECTED", "FAILED"].includes(status.toUpperCase()); }
function orderFilledSize(order: any): number { const value = Number(order?.size_matched ?? order?.sizeMatched ?? order?.filled_size ?? order?.filledSize ?? 0); return Number.isFinite(value) ? value : 0; }
function minimumOrderSize(book: any): number | undefined { const value = Number(book?.min_order_size ?? book?.minOrderSize); return Number.isFinite(value) && value > 0 ? value : undefined; }

function loadConfig(): RunnerConfig {
    const btc = defaultBtcPriceConfig();
    const requestedMode = process.env.BTC5M_SCALP_MODE;
    const mode: RunnerConfig["mode"] = requestedMode === "deep-rebound" ? "deep-rebound" : requestedMode === "final-30-high" ? "final-30-high" : "latency-scalp";
    const deep = mode === "deep-rebound";
    const final30High = mode === "final-30-high";
    const prefix = deep ? "DEEP_REBOUND" : final30High ? "FINAL_30_HIGH" : "LATENCY_SCALP";
    const cfg: RunnerConfig = {
        mode,
        dryRun: envBool(`${prefix}_DRY_RUN`, true), market: envString(`${prefix}_MARKET`, "btc").toLowerCase(),
        intervalMinutes: envNumber(`${prefix}_INTERVAL_MINUTES`, 5), tickSize: envString(`${prefix}_TICK_SIZE`, "0.01") as CreateOrderOptions["tickSize"],
        negRisk: envBool(`${prefix}_NEG_RISK`, config.copytrade.negRisk), evaluationIntervalMs: envNumber(`${prefix}_EVALUATION_INTERVAL_MS`, deep ? 250 : 100),
        orderPollIntervalMs: envNumber(`${prefix}_ORDER_POLL_INTERVAL_MS`, deep ? 500 : 250), marketLogIntervalMs: envNumber(`${prefix}_MARKET_LOG_INTERVAL_MS`, 1000),
        recordIntervalMs: envNumber(`${prefix}_RECORD_INTERVAL_MS`, 1000), btcPriceRefreshMs: envNumber(`${prefix}_BTC_PRICE_REFRESH_MS`, Math.min(250, btc.refreshIntervalMs)),
        btcPriceMaxStaleMs: envNumber(`${prefix}_BTC_PRICE_MAX_STALE_MS`, btc.maxStalenessMs), btcPriceUrls: parseList(envString(`${prefix}_BTC_PRICE_URLS`, btc.urls.join("|"))),
        recordEnabled: envBool(`${prefix}_RECORD_ENABLED`, true), recordPath: resolve(envString(`${prefix}_RECORD_FILE`, `data/btc5m-${mode}-live.csv`)),
        params: {
            minSignalPrice: envNumber("LATENCY_SCALP_MIN_SIGNAL_PRICE", 0.72),
            triggerConfirmSeconds: envNumber("LATENCY_SCALP_TRIGGER_CONFIRM_SECONDS", 2),
            signalLookbackSeconds: envNumber("LATENCY_SCALP_SIGNAL_LOOKBACK_SECONDS", 5),
            minContractMomentum: envNumber("LATENCY_SCALP_MIN_CONTRACT_MOMENTUM", 0.03),
            minBtcMomentumBps: envNumber("LATENCY_SCALP_MIN_BTC_MOMENTUM_BPS", 0),
            entryPrice: envNumber("LATENCY_SCALP_ENTRY_PRICE", 0.75),
            takeProfitPrice: envNumber("LATENCY_SCALP_TAKE_PROFIT_PRICE", 0.80),
            orderUsdc: envNumber("LATENCY_SCALP_ORDER_USDC", 3.75),
            maxSecondsLeftToTrigger: envNumber("LATENCY_SCALP_MAX_SECONDS_LEFT_TO_TRIGGER", 180),
            minSecondsLeftToTrigger: envNumber("LATENCY_SCALP_MIN_SECONDS_LEFT_TO_TRIGGER", 45),
            maxEntryOrderAgeSeconds: envNumber("LATENCY_SCALP_MAX_ENTRY_ORDER_AGE_SECONDS", 15),
            maxHoldSeconds: envNumber("LATENCY_SCALP_MAX_HOLD_SECONDS", 30),
            minBtcMoveBps: envNumber("LATENCY_SCALP_MIN_BTC_MOVE_BPS", 3),
            maxBtcReversalBps: envNumber("LATENCY_SCALP_MAX_BTC_REVERSAL_BPS", 3),
            stopLossPrice: envNumber("LATENCY_SCALP_STOP_LOSS_PRICE", 0.70),
            forceExitSecondsLeft: envNumber("LATENCY_SCALP_FORCE_EXIT_SECONDS_LEFT", 20),
        },
        deepParams: {
            intervalMinutes: envNumber("DEEP_REBOUND_INTERVAL_MINUTES", 5),
            volPerInterval: envNumber("DEEP_REBOUND_VOL_PER_INTERVAL", 0.0015),
            minEntryPrice: envNumber("DEEP_REBOUND_MIN_ENTRY_PRICE", 0.03),
            maxEntryPrice: envNumber("DEEP_REBOUND_MAX_ENTRY_PRICE", 0.10),
            orderUsdc: envNumber("DEEP_REBOUND_ORDER_USDC", 1.01),
            maxUsdcPerLeg: envNumber("DEEP_REBOUND_MAX_USDC_PER_LEG", 1.01),
            scoreThreshold: envNumber("DEEP_REBOUND_SCORE_THRESHOLD", 0.20),
            minDiscount: envNumber("DEEP_REBOUND_MIN_DISCOUNT", 0.05),
            takeProfitPrice: envNumber("DEEP_REBOUND_TAKE_PROFIT_PRICE", 0.05),
            stopLossPct: envNumber("DEEP_REBOUND_STOP_LOSS_PCT", 0.50),
            minSecondsLeftToOpen: envNumber("DEEP_REBOUND_MIN_SECONDS_LEFT_TO_OPEN", 60),
            maxSecondsLeftToOpen: envNumber("DEEP_REBOUND_MAX_SECONDS_LEFT_TO_OPEN", 240),
            forceExitSecondsLeft: envNumber("DEEP_REBOUND_FORCE_EXIT_SECONDS_LEFT", 30),
        },
        final30HighParams: {
            triggerPrice: envNumber("FINAL_30_HIGH_TRIGGER_PRICE", 0.85),
            earlyTriggerPrice: envNumber("FINAL_30_HIGH_EARLY_TRIGGER_PRICE", 0.90),
            maxEntryPrice: envNumber("FINAL_30_HIGH_MAX_ENTRY_PRICE", 0.90),
            orderShares: envNumber("FINAL_30_HIGH_ORDER_SHARES", 5),
            maxSecondsLeftToOpen: envNumber("FINAL_30_HIGH_MAX_SECONDS_LEFT_TO_OPEN", 30),
            earlyMaxSecondsLeftToOpen: envNumber("FINAL_30_HIGH_EARLY_MAX_SECONDS_LEFT_TO_OPEN", 30),
            minSecondsLeftToOpen: envNumber("FINAL_30_HIGH_MIN_SECONDS_LEFT_TO_OPEN", 0),
        },
    };
    if (!deep && !(cfg.params.minSignalPrice > 0 && cfg.params.minSignalPrice <= cfg.params.entryPrice && cfg.params.entryPrice < cfg.params.takeProfitPrice && cfg.params.takeProfitPrice < 1)) throw new Error("Invalid latency-scalp prices");
    if (deep && !(cfg.deepParams.minEntryPrice > 0 && cfg.deepParams.minEntryPrice < cfg.deepParams.maxEntryPrice && cfg.deepParams.maxEntryPrice < 1)) throw new Error("Invalid deep-rebound prices");
    if (deep && (cfg.deepParams.orderUsdc < 1.01 || cfg.deepParams.maxUsdcPerLeg < cfg.deepParams.orderUsdc)) throw new Error("Marketable deep-rebound BUY requires DEEP_REBOUND_ORDER_USDC >= 1.01 and matching max budget");
    if (final30High && (!(cfg.final30HighParams.triggerPrice > 0.5 && cfg.final30HighParams.triggerPrice < 1 && cfg.final30HighParams.earlyTriggerPrice >= cfg.final30HighParams.triggerPrice && cfg.final30HighParams.earlyTriggerPrice <= cfg.final30HighParams.maxEntryPrice && cfg.final30HighParams.maxEntryPrice < 1) || cfg.final30HighParams.orderShares <= 0 || cfg.final30HighParams.earlyMaxSecondsLeftToOpen < cfg.final30HighParams.maxSecondsLeftToOpen)) throw new Error("Invalid FINAL_30_HIGH tiered configuration");
    if ((deep ? cfg.deepParams.orderUsdc : cfg.params.orderUsdc) <= 0 || cfg.evaluationIntervalMs < 50 || cfg.orderPollIntervalMs < 100) throw new Error("Invalid scalp budget or intervals");
    return cfg;
}

function cycleNow(market: string, intervalMinutes: number): { slug: string; startMs: number; endMs: number } {
    const intervalMs = intervalMinutes * 60_000;
    const startMs = Math.floor(Date.now() / intervalMs) * intervalMs;
    return { slug: `${market}-updown-${intervalMinutes}m-${Math.floor(startMs / 1000)}`, startMs, endMs: startMs + intervalMs };
}

function parseArray(raw: unknown): string[] { if (typeof raw !== "string") throw new Error("Expected JSON array string"); const value = JSON.parse(raw); if (!Array.isArray(value)) throw new Error("Expected JSON array"); return value.map(String); }

async function fetchTokens(cycle: { slug: string; startMs: number; endMs: number }): Promise<Tokens> {
    const response = await fetch(`https://gamma-api.polymarket.com/markets/slug/${cycle.slug}`);
    if (!response.ok) throw new Error(`Gamma API ${response.status} for ${cycle.slug}`);
    const market = await response.json() as any;
    const outcomes = parseArray(market.outcomes); const ids = parseArray(market.clobTokenIds);
    const up = outcomes.indexOf("Up"); const down = outcomes.indexOf("Down");
    if (up < 0 || down < 0 || !ids[up] || !ids[down]) throw new Error(`Missing tokens for ${cycle.slug}`);
    return { ...cycle, conditionId: String(market.conditionId || ""), upTokenId: ids[up], downTokenId: ids[down] };
}

class LatencyScalpBot {
    private ws: WebSocketOrderBook | null = null;
    private btc: BtcPriceProvider;
    private tokens: Tokens | null = null;
    private state: Btc5mLatencyScalpState = {};
    private history: Btc5mRegimeSnapshot[] = [];
    private btcOpenPrice?: number;
    private lastBtcPrice?: number;
    private entryOrder: TrackedOrder | null = null;
    private exitOrder: TrackedOrder | null = null;
    private accounting: Accounting | null = null;
    private accountingByAsset = new Map<string, Accounting>();
    private timers: NodeJS.Timeout[] = [];
    private evaluating = false;
    private switching = false;
    private stopped = false;
    private lastRecordAt = 0;

    constructor(private client: ClobClient, private cfg: RunnerConfig) {
        this.btc = new BtcPriceProvider({ urls: cfg.btcPriceUrls, refreshIntervalMs: cfg.btcPriceRefreshMs, maxStalenessMs: cfg.btcPriceMaxStaleMs });
    }

    async start(): Promise<void> {
        const p = this.cfg.params;
        const description = this.cfg.mode === "deep-rebound"
            ? `entry=${this.cfg.deepParams.minEntryPrice}-${this.cfg.deepParams.maxEntryPrice}, score=${this.cfg.deepParams.scoreThreshold}, takeProfitDelta=${this.cfg.deepParams.takeProfitPrice}`
            : this.cfg.mode === "final-30-high"
                ? `ask>=${this.cfg.final30HighParams.earlyTriggerPrice} until ${this.cfg.final30HighParams.earlyMaxSecondsLeftToOpen}s, then >=${this.cfg.final30HighParams.triggerPrice} in final ${this.cfg.final30HighParams.maxSecondsLeftToOpen}s, max=${this.cfg.final30HighParams.maxEntryPrice}, shares=${this.cfg.final30HighParams.orderShares}`
                : `signal=${p.minSignalPrice}-${p.entryPrice}, momentum=${p.minContractMomentum}, entry=${p.entryPrice}, takeProfit=${p.takeProfitPrice}`;
        logger.info(`Starting ${this.cfg.mode}: ${description}, dryRun=${this.cfg.dryRun}`);
        logger.info(`Trajectory CSV: ${this.cfg.recordPath}`);
        await this.btc.start();
        this.ws = new WebSocketOrderBook("market", [], null, this.cfg.marketLogIntervalMs);
        await this.ws.connect();
        this.ws.onMarketResolved((payload) => this.handleResolution(payload));
        await this.initializeCycle();
        this.timers.push(setInterval(() => void this.cycleTick(), 1_000));
        this.timers.push(setInterval(() => void this.evaluate(), this.cfg.evaluationIntervalMs));
        this.timers.push(setInterval(() => void this.pollOrders(), this.cfg.orderPollIntervalMs));
    }

    async stop(): Promise<void> {
        this.stopped = true;
        for (const timer of this.timers) clearInterval(timer);
        await this.cancelOrder(this.entryOrder, "shutdown");
        await this.cancelOrder(this.exitOrder, "shutdown");
        this.btc.stop(); this.ws?.disconnect();
    }

    private async cycleTick(): Promise<void> {
        if (this.stopped || this.switching) return;
        const cycle = cycleNow(this.cfg.market, this.cfg.intervalMinutes);
        if (this.tokens?.slug === cycle.slug) return;
        this.switching = true;
        try {
            await this.cancelOrder(this.entryOrder, "new cycle");
            await this.cancelOrder(this.exitOrder, "new cycle");
            this.resetCycle();
            await this.initializeCycle();
        } finally { this.switching = false; }
    }

    private resetCycle(): void {
        this.tokens = null; this.state = {}; this.history = []; this.btcOpenPrice = undefined; this.lastBtcPrice = undefined;
        this.entryOrder = null; this.exitOrder = null; this.accounting = null; this.lastRecordAt = 0;
    }

    private async initializeCycle(): Promise<void> {
        try {
            const tokens = await fetchTokens(cycleNow(this.cfg.market, this.cfg.intervalMinutes));
            if (!this.cfg.dryRun) {
                const [upBook, downBook] = await Promise.all([this.client.getOrderBook(tokens.upTokenId), this.client.getOrderBook(tokens.downTokenId)]);
                tokens.upMinOrderSize = minimumOrderSize(upBook); tokens.downMinOrderSize = minimumOrderSize(downBook);
            }
            this.tokens = tokens;
            this.accounting = { tokens, cost: 0, shares: 0, proceeds: 0, soldShares: 0, resolved: false };
            this.accountingByAsset.set(tokens.upTokenId, this.accounting); this.accountingByAsset.set(tokens.downTokenId, this.accounting);
            if (!this.ws) throw new Error("WebSocket unavailable");
            this.ws.subscribeToTokenIds([tokens.upTokenId, tokens.downTokenId]);
            this.ws.setTokenLabel(tokens.upTokenId, "Up"); this.ws.setTokenLabel(tokens.downTokenId, "Down"); this.ws.setTokenPair(tokens.upTokenId, tokens.downTokenId);
            this.ws.onPriceUpdate(tokens.upTokenId, () => undefined); this.ws.onPriceUpdate(tokens.downTokenId, () => undefined);
            logger.info(`Cycle ready: ${tokens.slug}`);
        } catch (error) { logger.error(`Failed to initialize latency-scalp cycle: ${error instanceof Error ? error.message : String(error)}`); }
    }

    private async evaluate(): Promise<void> {
        if (this.stopped || this.switching || this.evaluating || !this.tokens || !this.ws) return;
        this.evaluating = true;
        try {
            const now = Date.now(); const secondsLeft = Math.max(0, (this.tokens.endMs - now) / 1000);
            const up = this.ws.getPrice(this.tokens.upTokenId); const down = this.ws.getPrice(this.tokens.downTokenId);
            if (!up?.bestAsk || !down?.bestAsk) return;
            const btcPrice = this.btc.getPrice() ?? undefined; this.lastBtcPrice = btcPrice;
            if (btcPrice !== undefined && this.btcOpenPrice === undefined) this.btcOpenPrice = btcPrice;
            await this.fillDryOrders(now, up.bestAsk, down.bestAsk, up.bestBid ?? undefined, down.bestBid ?? undefined);
            if (btcPrice !== undefined && (this.history.length === 0 || now - this.history[this.history.length - 1].t >= 250)) {
                this.history.push({ t: now, upAsk: up.bestAsk, downAsk: down.bestAsk, btcPrice });
                const cutoff = now - 60_000; while (this.history.length > 0 && this.history[0].t < cutoff) this.history.shift();
            }
            const decision = this.cfg.mode === "deep-rebound"
                ? buildBtc5mDeepReboundOrders({
                    timestampMs: now,
                    endMs: this.tokens.endMs,
                    btcPrice,
                    openPrice: this.btcOpenPrice,
                    up,
                    down,
                    positions: {
                        UP: this.position("UP"),
                        DOWN: this.position("DOWN"),
                    },
                    history: this.history,
                    params: this.cfg.deepParams,
                    emitRestingTakeProfit: true,
                })
                : this.cfg.mode === "final-30-high"
                    ? buildBtc5mFinal30HighOrders({ timestampMs: now, endMs: this.tokens.endMs, upAsk: up.bestAsk, downAsk: down.bestAsk, entered: Boolean(this.state.filled || this.state.cancelled || this.active(this.entryOrder)), params: this.cfg.final30HighParams })
                    : buildBtc5mLatencyScalpOrders({ timestampMs: now, endMs: this.tokens.endMs, upAsk: up.bestAsk, downAsk: down.bestAsk, upBid: up.bestBid ?? undefined, downBid: down.bestBid ?? undefined, btcPrice, openPrice: this.btcOpenPrice, state: this.state, params: this.cfg.params });
            if ("state" in decision) {
                const wasCancelled = Boolean(this.state.cancelled); this.state = decision.state;
                if (!wasCancelled && this.state.cancelled) await this.cancelOrder(this.entryOrder, decision.reason || "strategy cancelled");
            }
            if (this.cfg.mode === "final-30-high" && decision.reason?.includes("blocked:")) this.state = { ...this.state, cancelled: true };
            const quote = decision.quotes[0];
            if (this.cfg.mode === "deep-rebound" && quote?.side !== "BUY" && !this.state.filled && this.active(this.entryOrder)) {
                await this.cancelOrder(this.entryOrder, "deep-rebound signal disappeared");
            }
            if (quote?.side === "BUY" && !this.state.exited && !this.active(this.entryOrder)) await this.placeOrder("entry", quote.leg, quote.side, quote.price, quote.size);
            if (quote?.side === "SELL") {
                const role: Role = quote.note?.includes("take profit") ? "take-profit" : "risk-exit";
                if (this.active(this.exitOrder) && (this.exitOrder!.role !== role || Math.abs(this.exitOrder!.price - quote.price) > 1e-9)) await this.cancelOrder(this.exitOrder, "exit quote changed");
                if (!this.active(this.exitOrder)) await this.placeOrder(role, quote.leg, quote.side, quote.price, quote.size);
            }
            this.recordDecision(now, secondsLeft, up, down, btcPrice, decision.reason, decision.quotes);
        } finally { this.evaluating = false; }
    }

    private active(order: TrackedOrder | null): boolean { return Boolean(order && !isFinal(order.status)); }

    private position(leg: Leg): { shares: number; cost: number; tookProfit: boolean } {
        if (!this.accounting || this.accounting.entryLeg !== leg) return { shares: 0, cost: 0, tookProfit: false };
        const shares = Math.max(0, this.accounting.shares - this.accounting.soldShares);
        const averagePrice = this.accounting.shares > 0 ? this.accounting.cost / this.accounting.shares : 0;
        return { shares, cost: shares * averagePrice, tookProfit: Boolean(this.state.exited) };
    }

    private async placeOrder(role: Role, leg: Leg, side: "BUY" | "SELL", price: number, size: number): Promise<void> {
        if (!this.tokens) return;
        const minSize = leg === "UP" ? this.tokens.upMinOrderSize : this.tokens.downMinOrderSize;
        if (minSize !== undefined && size + 1e-9 < minSize) { logger.error(`Skipped ${role}: ${size.toFixed(4)} shares is below CLOB minimum ${minSize.toFixed(4)}; minimum cost at ${price.toFixed(2)} is ${(minSize * price).toFixed(4)} USDC`); if (this.cfg.mode === "final-30-high") this.state = { ...this.state, cancelled: true }; return; }
        const tokenId = leg === "UP" ? this.tokens.upTokenId : this.tokens.downTokenId;
        const base = { role, leg, side, tokenId, price, size, filledSize: 0, accountedFilledSize: 0, status: "NEW", placedAtMs: Date.now() };
        if (this.cfg.dryRun) {
            const order = { ...base, orderId: `dry-${role}-${Date.now()}` } satisfies TrackedOrder;
            if (side === "BUY") this.entryOrder = order; else this.exitOrder = order;
            this.recordOrder("dry_run_order_posted", order); return;
        }
        try {
            const response = await this.client.createAndPostOrder({ tokenID: tokenId, side: side === "BUY" ? Side.BUY : Side.SELL, price, size } satisfies UserOrder, { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk }, OrderType.GTC);
            const orderId = response?.orderID ?? response?.orderId;
            if (!orderId || response?.success === false) throw new Error(String(response?.errorMsg ?? response?.status ?? "CLOB returned no orderID"));
            const order = { ...base, orderId } satisfies TrackedOrder;
            if (side === "BUY") this.entryOrder = order; else this.exitOrder = order;
            logger.info(`Posted ${role} ${side} ${leg} ${size.toFixed(4)} @ ${price.toFixed(2)}`); this.recordOrder("order_posted", order);
        } catch (error) { logger.error(`Failed to post ${role}: ${error instanceof Error ? error.message : String(error)}`); if (this.cfg.mode === "final-30-high") this.state = { ...this.state, cancelled: true }; }
    }

    private async fillDryOrders(now: number, upAsk: number, downAsk: number, upBid?: number, downBid?: number): Promise<void> {
        if (!this.cfg.dryRun) return;
        if (this.active(this.entryOrder) && now > this.entryOrder!.placedAtMs) {
            const ask = this.entryOrder!.leg === "UP" ? upAsk : downAsk;
            if (ask <= this.entryOrder!.price) this.fillOrder(this.entryOrder!, this.entryOrder!.size, "dry_run_entry_fill", ask);
        }
        if (this.active(this.exitOrder) && now > this.exitOrder!.placedAtMs) {
            const bid = this.exitOrder!.leg === "UP" ? upBid : downBid;
            if (bid !== undefined && (this.exitOrder!.role === "risk-exit" || bid >= this.exitOrder!.price)) this.fillOrder(this.exitOrder!, this.exitOrder!.size, "dry_run_exit_fill", this.exitOrder!.role === "risk-exit" ? bid : this.exitOrder!.price);
        }
    }

    private async pollOrders(): Promise<void> {
        if (this.cfg.dryRun || this.stopped) return;
        for (const order of [this.entryOrder, this.exitOrder]) {
            if (!this.active(order)) continue;
            try {
                const latest = await this.client.getOrder(order!.orderId); if (!latest) continue;
                order!.status = String((latest as any).status || order!.status); order!.filledSize = orderFilledSize(latest);
                const newlyFilled = Math.max(0, order!.filledSize - order!.accountedFilledSize);
                if (newlyFilled > 0) {
                    order!.accountedFilledSize = order!.filledSize; this.accountFill(order!, newlyFilled, order!.price); this.recordOrder("order_fill", order!);
                    if (order!.filledSize + 1e-9 < order!.size) await this.cancelOrder(order, "partial fill; cancel remainder");
                }
            } catch (error) { logger.error(`Failed to poll order: ${error instanceof Error ? error.message : String(error)}`); }
        }
    }

    private fillOrder(order: TrackedOrder, shares: number, event: string, executionPrice: number): void {
        order.filledSize += shares; order.accountedFilledSize += shares; order.status = "FILLED"; this.accountFill(order, shares, executionPrice); this.recordOrder(event, order, executionPrice);
    }

    private accountFill(order: TrackedOrder, shares: number, executionPrice: number): void {
        if (!this.accounting) return;
        if (order.side === "BUY") {
            this.accounting.entryLeg = order.leg; this.accounting.cost += shares * executionPrice; this.accounting.shares += shares;
            this.state = { ...this.state, filled: true, filledAtMs: this.state.filledAtMs ?? Date.now(), fillBtcPrice: this.lastBtcPrice, filledShares: this.accounting.shares - this.accounting.soldShares };
        } else {
            this.accounting.proceeds += shares * executionPrice; this.accounting.soldShares += shares;
            if (order.filledSize + 1e-9 >= order.size) this.state = { ...this.state, exited: true };
        }
    }

    private async cancelOrder(order: TrackedOrder | null, reason: string): Promise<void> {
        if (!this.active(order)) return;
        if (this.cfg.dryRun) { order!.status = "CANCELLED"; this.recordOrder("dry_run_order_cancelled", order!); return; }
        try { await this.client.cancelOrder({ orderID: order!.orderId }); order!.status = "CANCELLED"; this.recordOrder("order_cancelled", order!); logger.info(`Cancelled ${order!.role} (${reason})`); }
        catch (error) { logger.error(`Failed to cancel ${order!.role}: ${error instanceof Error ? error.message : String(error)}`); }
    }

    private handleResolution(payload: MarketResolvedPayload): void {
        const accounting = this.accountingByAsset.get(payload.winningAssetId) ?? payload.assetIds.map((id) => this.accountingByAsset.get(id)).find(Boolean);
        if (!accounting || accounting.resolved) return;
        const outcome = payload.winningOutcome.toUpperCase();
        const winner: Leg | undefined = payload.winningAssetId === accounting.tokens.upTokenId || outcome === "UP" ? "UP" : payload.winningAssetId === accounting.tokens.downTokenId || outcome === "DOWN" ? "DOWN" : undefined;
        if (!winner) return; accounting.resolved = true;
        const remaining = Math.max(0, accounting.shares - accounting.soldShares);
        const settlement = accounting.entryLeg === winner ? remaining : 0; const pnl = accounting.proceeds + settlement - accounting.cost;
        logger.info(`${this.cfg.mode} resolved ${accounting.tokens.slug}: winner=${winner}, pnl=${pnl.toFixed(4)}`);
        this.write({ row_type: "resolution", timestamp: new Date().toISOString(), timestamp_ms: Date.now(), slug: accounting.tokens.slug, condition_id: accounting.tokens.conditionId, dry_run: this.cfg.dryRun, winning_outcome: winner, entry_cost: accounting.cost.toFixed(6), exit_proceeds: accounting.proceeds.toFixed(6), settlement_payout: settlement.toFixed(6), pnl: pnl.toFixed(6) });
        this.accountingByAsset.delete(accounting.tokens.upTokenId); this.accountingByAsset.delete(accounting.tokens.downTokenId);
    }

    private recordDecision(now: number, secondsLeft: number, up: any, down: any, btcPrice: number | undefined, reason: string | undefined, quotes: any[]): void {
        if (now - this.lastRecordAt < this.cfg.recordIntervalMs) return; this.lastRecordAt = now;
        this.write({ row_type: "decision", timestamp: new Date(now).toISOString(), timestamp_ms: now, slug: this.tokens?.slug, condition_id: this.tokens?.conditionId, dry_run: this.cfg.dryRun, btc_price: optional(btcPrice, 2), open_price: optional(this.btcOpenPrice, 2), seconds_left: secondsLeft.toFixed(3), up_bid: optional(up.bestBid), up_ask: optional(up.bestAsk), down_bid: optional(down.bestBid), down_ask: optional(down.bestAsk), candidate_leg: this.state.candidateLeg, triggered_leg: this.state.triggeredLeg, state_filled: Boolean(this.state.filled), state_cancelled: Boolean(this.state.cancelled), state_exited: Boolean(this.state.exited), decision_reason: reason, quotes: quotes.map((quote) => `${quote.side} ${quote.leg}@${quote.price.toFixed(2)}x${quote.size.toFixed(4)}`).join("|") });
    }

    private recordOrder(rowType: string, order: TrackedOrder, executionPrice = order.price): void {
        this.write({ row_type: rowType, timestamp: new Date().toISOString(), timestamp_ms: Date.now(), slug: this.tokens?.slug, condition_id: this.tokens?.conditionId, dry_run: this.cfg.dryRun, event_role: order.role, event_leg: order.leg, event_side: order.side, event_price: executionPrice.toFixed(6), event_size: order.size.toFixed(6), event_cost: (executionPrice * order.size).toFixed(6), order_id: order.orderId, order_status: order.status, filled_size: order.filledSize.toFixed(6) });
    }

    private write(row: RecordRow): void { if (this.cfg.recordEnabled) appendRecord(this.cfg.recordPath, row); }
}

async function bootstrap(cfg: RunnerConfig): Promise<ClobClient> {
    if (cfg.dryRun) return {} as ClobClient;
    if (!validatePrivateKey()) throw new Error("WALLET_PRIVATE_KEY is invalid or missing");
    await createCredential(); const client = await getClobClient();
    if (process.env.SKIP_ALLOWANCE_APPROVE !== "true") { try { await approveUSDCAllowance(); await updateClobBalanceAllowance(client); } catch (error) { logger.error(`Allowance approval failed: ${error instanceof Error ? error.message : String(error)}`); } }
    const orderUsdc = cfg.mode === "deep-rebound" ? cfg.deepParams.orderUsdc : cfg.mode === "final-30-high" ? cfg.final30HighParams.orderShares * 0.99 : cfg.params.orderUsdc;
    const gate = await waitForMinimumUsdcBalance(client, Math.max(config.bot.minUsdcBalance, orderUsdc), { pollIntervalMs: 15_000, timeoutMs: 0, logEveryPoll: true });
    if (!gate.ok) throw new Error("USDC balance gate failed"); return client;
}

async function main(): Promise<void> {
    const cfg = loadConfig(); setupConsoleFileLogging({ logFilePath: config.logging.logFilePath, logDir: config.logging.logDir, filePrefix: config.logging.logFilePrefix });
    const bot = new LatencyScalpBot(await bootstrap(cfg), cfg);
    const shutdown = async (signal: string) => { logger.info(`Received ${signal}, shutting down...`); await bot.stop(); process.exit(0); };
    process.once("SIGINT", () => void shutdown("SIGINT")); process.once("SIGTERM", () => void shutdown("SIGTERM")); await bot.start();
}

main().catch((error) => { logger.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
