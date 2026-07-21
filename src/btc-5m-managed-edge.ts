// Setup global fetch proxy FIRST (before any other imports that might call fetch)
import "./setup-proxy";

// Patch Exchange protocol version to V2 (npm package still ships V1)
import "./patch-exchange-v2";

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { ClobClient, CreateOrderOptions, OrderType, Side, UserOrderV2 as UserOrder } from "@polymarket/clob-client-v2";
import { config } from "./config";
import { getClobClient } from "./providers/clobclient";
import { WebSocketOrderBook } from "./providers/websocketOrderbook";
import { BtcPriceProvider, defaultBtcPriceConfig } from "./providers/btcPriceProvider";
import { validatePrivateKey } from "./security/validatePrivateKey";
import { createCredential } from "./security/createCredential";
import { approveUSDCAllowance, updateClobBalanceAllowance } from "./security/allowance";
import { waitForMinimumUsdcBalance } from "./utils/balance";
import { logger } from "./utils/logger";
import { setupConsoleFileLogging } from "./utils/console-file";
import { buildBtc5mManagedEdgeOrders, Btc5mManagedEdgeParams } from "./strategies/btc5m/managed-edge";
import { Btc5mStrategyQuote } from "./strategies/btc5m/types";

type EdgeConfig = {
    dryRun: boolean;
    market: string;
    intervalMinutes: number;
    volPerInterval: number;
    minEdge: number;
    minMoveBps: number;
    minElapsedSeconds: number;
    orderUsdc: number;
    maxUsdcPerLeg: number;
    maxPrice: number;
    tickSize: CreateOrderOptions["tickSize"];
    negRisk: boolean;
    minSecondsLeftToTrade: number;
    cancelSecondsBeforeEnd: number;
    btcPriceRefreshMs: number;
    btcPriceMaxStaleMs: number;
    recordEnabled: boolean;
    recordPath: string;
    managedMinSecondsLeftToOpen: number;
    managedMaxSecondsLeftToOpen: number;
    managedNoCheapBuySecondsLeft: number;
    managedMinCheapPrice: number;
    managedMinEntryPrice: number;
    managedTakeProfitPct: number;
    managedTakeProfitSellRatio: number;
    managedStopLossPct: number;
    managedForceExitSecondsLeft: number;
    managedMinExitPrice: number;
};

type MarketTokens = {
    slug: string;
    upTokenId: string;
    downTokenId: string;
    conditionId: string;
    upIdx: number;
    downIdx: number;
    startMs: number;
    endMs: number;
};

type PlacedOrder = {
    leg: "UP" | "DOWN";
    side?: "BUY" | "SELL";
    orderId: string;
    tokenId: string;
    price: number;
    size: number;
    filledSize: number;
    status: string;
};

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
    if (!raw) return fallback;
    return raw.toLowerCase() === "true";
}

function loadEdgeConfig(): EdgeConfig {
    const cfg: EdgeConfig = {
        dryRun: envBool("MANAGED_EDGE_DRY_RUN", true),
        market: envString("MANAGED_EDGE_MARKET", envString("BTC5M_MARKET", "btc")).toLowerCase(),
        intervalMinutes: envNumber("MANAGED_EDGE_INTERVAL_MINUTES", envNumber("BTC5M_INTERVAL_MINUTES", 5)),
        volPerInterval: envNumber("MANAGED_EDGE_VOL_PER_INTERVAL", envNumber("EDGE_VOL_PER_INTERVAL", 0.0015)),
        minEdge: envNumber("MANAGED_EDGE_MIN_EDGE", envNumber("EDGE_MIN_EDGE", 0.25)),
        minMoveBps: envNumber("MANAGED_EDGE_MIN_MOVE_BPS", envNumber("EDGE_MIN_MOVE_BPS", 0)),
        minElapsedSeconds: envNumber("MANAGED_EDGE_MIN_ELAPSED_SECONDS", envNumber("EDGE_MIN_ELAPSED_SECONDS", 0)),
        orderUsdc: envNumber("MANAGED_EDGE_ORDER_USDC", envNumber("EDGE_ORDER_USDC", 3)),
        maxUsdcPerLeg: envNumber("MANAGED_EDGE_MAX_USDC_PER_LEG", envNumber("EDGE_MAX_USDC_PER_LEG", 5)),
        maxPrice: envNumber("MANAGED_EDGE_MAX_PRICE", envNumber("EDGE_MAX_PRICE", 0.85)),
        tickSize: envString("MANAGED_EDGE_TICK_SIZE", envString("BTC5M_TICK_SIZE", "0.01")) as CreateOrderOptions["tickSize"],
        negRisk: envBool("MANAGED_EDGE_NEG_RISK", envBool("BTC5M_NEG_RISK", config.copytrade.negRisk)),
        minSecondsLeftToTrade: envNumber("MANAGED_EDGE_MIN_SECONDS_LEFT_TO_TRADE", envNumber("BTC5M_MIN_SECONDS_LEFT_TO_TRADE", 30)),
        cancelSecondsBeforeEnd: envNumber("MANAGED_EDGE_CANCEL_SECONDS_BEFORE_END", envNumber("BTC5M_CANCEL_SECONDS_BEFORE_END", 5)),
        btcPriceRefreshMs: envNumber("MANAGED_EDGE_BTC_PRICE_REFRESH_MS", envNumber("BTC5M_BTC_PRICE_REFRESH_MS", 1000)),
        btcPriceMaxStaleMs: envNumber("MANAGED_EDGE_BTC_PRICE_MAX_STALE_MS", envNumber("BTC5M_BTC_PRICE_MAX_STALE_MS", 10000)),
        recordEnabled: envBool("MANAGED_EDGE_RECORD_ENABLED", true),
        recordPath: resolve(envString("MANAGED_EDGE_RECORD_FILE", "data/btc5m-managed-edge-live.csv")),
        managedMinSecondsLeftToOpen: envNumber("MANAGED_EDGE_MIN_SECONDS_LEFT_TO_OPEN", 60),
        managedMaxSecondsLeftToOpen: envNumber("MANAGED_EDGE_MAX_SECONDS_LEFT_TO_OPEN", 240),
        managedNoCheapBuySecondsLeft: envNumber("MANAGED_EDGE_NO_CHEAP_BUY_SECONDS_LEFT", 90),
        managedMinCheapPrice: envNumber("MANAGED_EDGE_MIN_CHEAP_PRICE", 0.20),
        managedMinEntryPrice: envNumber("MANAGED_EDGE_MIN_ENTRY_PRICE", 0.15),
        managedTakeProfitPct: envNumber("MANAGED_EDGE_TAKE_PROFIT_PCT", 0.20),
        managedTakeProfitSellRatio: envNumber("MANAGED_EDGE_TAKE_PROFIT_SELL_RATIO", 0.50),
        managedStopLossPct: envNumber("MANAGED_EDGE_STOP_LOSS_PCT", 0.30),
        managedForceExitSecondsLeft: envNumber("MANAGED_EDGE_FORCE_EXIT_SECONDS_LEFT", 30),
        managedMinExitPrice: envNumber("MANAGED_EDGE_MIN_EXIT_PRICE", 0.05),
    };

    if (cfg.intervalMinutes <= 0) throw new Error("EDGE_INTERVAL_MINUTES must be > 0");
    if (!(cfg.volPerInterval > 0)) throw new Error("EDGE_VOL_PER_INTERVAL must be > 0");
    if (!(cfg.minEdge > 0 && cfg.minEdge < 1)) throw new Error("EDGE_MIN_EDGE must be > 0 and < 1");
    if (cfg.minMoveBps < 0) throw new Error("EDGE_MIN_MOVE_BPS must be >= 0");
    if (cfg.minElapsedSeconds < 0) throw new Error("EDGE_MIN_ELAPSED_SECONDS must be >= 0");
    if (!(cfg.orderUsdc > 0)) throw new Error("EDGE_ORDER_USDC must be > 0");
    if (cfg.maxUsdcPerLeg < 0) throw new Error("EDGE_MAX_USDC_PER_LEG must be >= 0");
    if (!(cfg.maxPrice > 0 && cfg.maxPrice <= 1)) throw new Error("EDGE_MAX_PRICE must be > 0 and <= 1");
    if (cfg.minSecondsLeftToTrade < 0) throw new Error("EDGE_MIN_SECONDS_LEFT_TO_TRADE must be >= 0");
    if (cfg.cancelSecondsBeforeEnd < 0) throw new Error("EDGE_CANCEL_SECONDS_BEFORE_END must be >= 0");
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
        upIdx,
        downIdx,
        startMs,
        endMs,
    };
}

function orderFilledSize(order: any): number {
    const value = order?.size_matched ?? order?.sizeMatched ?? order?.filled_size ?? order?.filledSize ?? 0;
    const parsed = typeof value === "number" ? value : parseFloat(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
}

function isFinalOrderStatus(status: string): boolean {
    return ["FILLED", "MATCHED", "CANCELLED", "CANCELED", "REJECTED", "FAILED"].includes(status.toUpperCase());
}

const EDGE_RECORD_HEADERS = [
    "row_type",
    "timestamp",
    "timestamp_ms",
    "slug",
    "condition_id",
    "dry_run",
    "btc_price",
    "open_price",
    "seconds_left",
    "up_bid",
    "up_ask",
    "up_mid",
    "down_bid",
    "down_ask",
    "down_mid",
    "fair_up",
    "fair_down",
    "decision_reason",
    "quotes",
    "spent_up",
    "spent_down",
    "event_leg",
    "event_price",
    "event_size",
    "event_cost",
    "order_id",
    "order_status",
    "filled_size",
];

type EdgeRecord = Partial<Record<typeof EDGE_RECORD_HEADERS[number], string | number | boolean>>;

function csvValue(value: string | number | boolean | undefined): string {
    if (value === undefined) return "";
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function appendEdgeRecord(path: string, record: EdgeRecord): void {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) appendFileSync(path, `${EDGE_RECORD_HEADERS.join(",")}\n`);
    appendFileSync(path, `${EDGE_RECORD_HEADERS.map((header) => csvValue(record[header])).join(",")}\n`);
}

function formatOptionalNumber(value: number | undefined, digits = 6): string | undefined {
    return value === undefined || !Number.isFinite(value) ? undefined : value.toFixed(digits);
}

class BtcFiveMinuteEdgeBot {
    private ws: WebSocketOrderBook | null = null;
    private btcPrice: BtcPriceProvider;
    private tokens: MarketTokens | null = null;
    private orders: PlacedOrder[] = [];
    private openPrice: number | null = null;
    private spentUp = 0;
    private spentDown = 0;
    private tookProfitUp = false;
    private tookProfitDown = false;
    private timers: NodeJS.Timeout[] = [];
    private stopped = false;
    private lastDecisionMs = 0;

    constructor(private client: ClobClient, private cfg: EdgeConfig) {
        this.btcPrice = new BtcPriceProvider({
            ...defaultBtcPriceConfig(),
            refreshIntervalMs: cfg.btcPriceRefreshMs,
            maxStalenessMs: cfg.btcPriceMaxStaleMs,
        });
    }

    async start(): Promise<void> {
        logger.info(`Starting BTC 5m edge bot: market=${this.cfg.market}, vol=${this.cfg.volPerInterval}, minEdge=${this.cfg.minEdge}, orderUsdc=${this.cfg.orderUsdc}, maxUsdcPerLeg=${this.cfg.maxUsdcPerLeg}, dryRun=${this.cfg.dryRun}`);
        if (this.cfg.recordEnabled) logger.info(`Edge live record CSV: ${this.cfg.recordPath}`);

        // Start BTC price provider first
        await this.btcPrice.start();

        // Start WebSocket for Polymarket orderbook
        this.ws = new WebSocketOrderBook("market", [], null);
        await this.ws.connect();
        await this.initializeCurrentCycle();

        // Main loop timers
        this.timers.push(setInterval(() => void this.handleCycleTick(), 5_000));
        this.timers.push(setInterval(() => void this.evaluateAndTrade(), 2_000));
        this.timers.push(setInterval(() => void this.pollOrders(), 3_000));
    }

    async stop(): Promise<void> {
        this.stopped = true;
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        await this.cancelOpenOrders("shutdown");
        this.btcPrice.stop();
        if (this.ws) this.ws.disconnect();
        logger.info("BTC 5m edge bot stopped");
    }

    private async handleCycleTick(): Promise<void> {
        if (this.stopped) return;
        const current = slugForCycle(this.cfg.market, this.cfg.intervalMinutes);
        if (!this.tokens || this.tokens.slug !== current.slug) {
            // New cycle detected
            await this.cancelOpenOrders("new cycle");
            this.resetCycleState();
            await this.initializeCurrentCycle();
            return;
        }

        const secondsLeft = (this.tokens.endMs - Date.now()) / 1000;
        if (secondsLeft <= this.cfg.cancelSecondsBeforeEnd) {
            await this.cancelOpenOrders(`cycle ending in ${secondsLeft.toFixed(1)}s`);
        }
    }

    private resetCycleState(): void {
        this.tokens = null;
        this.orders = [];
        this.spentUp = 0;
        this.spentDown = 0;
        this.tookProfitUp = false;
        this.tookProfitDown = false;
        this.lastDecisionMs = 0;
        // Capture new open price at cycle start
        this.openPrice = this.btcPrice.getPrice();
        logger.info(`New cycle openPrice: ${this.openPrice ?? "unavailable"}`);
    }

    private async initializeCurrentCycle(): Promise<void> {
        const cycle = slugForCycle(this.cfg.market, this.cfg.intervalMinutes);
        try {
            const tokens = await fetchTokenIdsForSlug(cycle.slug, cycle.startMs, cycle.endMs);
            this.tokens = tokens;

            // Set open price at start of cycle
            if (this.openPrice === null) {
                this.openPrice = this.btcPrice.getPrice();
            }

            logger.info(`Cycle ready: ${tokens.slug} (openPrice=${this.openPrice ?? "pending"})`);
            logger.info(`UP=${tokens.upTokenId.slice(0, 20)}..., DOWN=${tokens.downTokenId.slice(0, 20)}...`);

            if (!this.ws) throw new Error("WebSocket is not initialized");
            this.ws.subscribeToTokenIds([tokens.upTokenId, tokens.downTokenId]);
            this.ws.setTokenLabel(tokens.upTokenId, "Up");
            this.ws.setTokenLabel(tokens.downTokenId, "Down");
            this.ws.setTokenPair(tokens.upTokenId, tokens.downTokenId);
            this.ws.onPriceUpdate(tokens.upTokenId, () => undefined);
            this.ws.onPriceUpdate(tokens.downTokenId, () => undefined);
        } catch (error) {
            logger.error(`Failed to initialize ${this.cfg.intervalMinutes}m market: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async evaluateAndTrade(): Promise<void> {
        if (this.stopped || !this.tokens || !this.ws) return;

        const now = Date.now();
        const secondsLeft = (this.tokens.endMs - now) / 1000;

        // Don't trade if too close to end or too early since last decision
        if (secondsLeft < this.cfg.minSecondsLeftToTrade) return;
        if (now - this.lastDecisionMs < 1500) return; // min 1.5s between decisions

        // Get BTC price
        const btcPrice = this.btcPrice.getPrice();
        if (btcPrice === null) {
            logger.warning("BTC price unavailable, skipping edge evaluation");
            return;
        }

        // Ensure we have open price
        if (this.openPrice === null) {
            this.openPrice = btcPrice;
            logger.info(`Set openPrice to current BTC price: ${btcPrice}`);
        }

        // Get Polymarket prices
        const upPrice = this.ws.getPrice(this.tokens.upTokenId);
        const downPrice = this.ws.getPrice(this.tokens.downTokenId);
        if (!upPrice?.bestAsk || !downPrice?.bestAsk) return;

        const upAsk = upPrice.bestAsk;
        const downAsk = downPrice.bestAsk;

        const params: Btc5mManagedEdgeParams = {
            intervalMinutes: this.cfg.intervalMinutes,
            volPerInterval: this.cfg.volPerInterval,
            minEdge: this.cfg.minEdge,
            minMoveBps: this.cfg.minMoveBps,
            minElapsedSeconds: this.cfg.minElapsedSeconds,
            orderUsdc: this.cfg.orderUsdc,
            maxUsdcPerLeg: this.cfg.maxUsdcPerLeg,
            maxPrice: this.cfg.maxPrice,
            minSecondsLeftToOpen: this.cfg.managedMinSecondsLeftToOpen,
            maxSecondsLeftToOpen: this.cfg.managedMaxSecondsLeftToOpen,
            noCheapBuySecondsLeft: this.cfg.managedNoCheapBuySecondsLeft,
            minCheapPrice: this.cfg.managedMinCheapPrice,
            minEntryPrice: this.cfg.managedMinEntryPrice,
            takeProfitPct: this.cfg.managedTakeProfitPct,
            takeProfitSellRatio: this.cfg.managedTakeProfitSellRatio,
            stopLossPct: this.cfg.managedStopLossPct,
            forceExitSecondsLeft: this.cfg.managedForceExitSecondsLeft,
            minExitPrice: this.cfg.managedMinExitPrice,
        };

        const decision = buildBtc5mManagedEdgeOrders({
            timestampMs: now,
            endMs: this.tokens.endMs,
            btcPrice,
            openPrice: this.openPrice,
            up: upPrice,
            down: downPrice,
            positions: {
                UP: { shares: this.positionShares("UP"), cost: this.spentUp, tookProfit: this.tookProfitUp },
                DOWN: { shares: this.positionShares("DOWN"), cost: this.spentDown, tookProfit: this.tookProfitDown },
            },
            params,
        });

        this.lastDecisionMs = now;

        // Log decision info
        const fairUpStr = decision.fairUp?.toFixed(4) ?? "--";
        const fairDownStr = decision.fairDown?.toFixed(4) ?? "--";
        logger.info(
            `Edge eval: btc=${btcPrice.toFixed(2)} open=${this.openPrice.toFixed(2)} diff=${(btcPrice - this.openPrice).toFixed(2)} | ` +
            `fairUp=${fairUpStr} fairDown=${fairDownStr} | upAsk=${upAsk.toFixed(4)} downAsk=${downAsk.toFixed(4)} | ` +
            `secLeft=${secondsLeft.toFixed(0)} | spentUp=${this.spentUp.toFixed(2)} spentDown=${this.spentDown.toFixed(2)}`
        );
        this.recordDecision(now, secondsLeft, btcPrice, upPrice, downPrice, decision.reason, decision.fairUp, decision.fairDown, decision.quotes);

        for (const quote of decision.quotes) {
            const edgeStr = quote.edge?.toFixed(4) ?? "--";
            logger.info(`Managed-edge signal: ${quote.leg} ${quote.side} @ ${quote.price.toFixed(4)}, size=${quote.size.toFixed(4)}, edge=${edgeStr}, fair=${quote.fair?.toFixed(4) ?? "--"}`);
            await this.executeQuote(quote);
        }
    }

    private positionShares(leg: "UP" | "DOWN"): number {
        return this.orders
            .filter((order) => order.leg === leg && order.status !== "CANCELLED" && order.status !== "REJECTED" && order.status !== "FAILED")
            .reduce((sum, order) => {
                const filled = Math.max(order.filledSize || (this.cfg.dryRun ? order.size : 0), 0);
                return sum + (order.side === "SELL" ? -filled : filled);
            }, 0);
    }

    private async executeQuote(quote: Btc5mStrategyQuote): Promise<void> {
        if (!this.tokens) return;
        const leg = quote.leg as "UP" | "DOWN";
        const tokenId = leg === "UP" ? this.tokens.upTokenId : this.tokens.downTokenId;
        const cost = quote.price * quote.size;

        if (this.cfg.dryRun) {
            logger.info(`[DRY-RUN] ${quote.side} ${leg} ${quote.size.toFixed(4)} shares @ ${quote.price.toFixed(4)} (${cost.toFixed(4)} USDC)`);
            this.applyLocalFill(leg, quote.side, quote.price, quote.size);
            this.recordOrderEvent("dry_run_order", leg, quote.price, quote.size, cost, undefined, "DRY_RUN", quote.size);
            return;
        }

        const order: UserOrder = {
            tokenID: tokenId,
            side: quote.side === "BUY" ? Side.BUY : Side.SELL,
            price: quote.price,
            size: quote.size,
        };

        try {
            const response = await this.client.createAndPostOrder(
                order,
                { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                OrderType.GTC
            );
            const orderId = response?.orderID;
            if (!orderId) {
                logger.error(`BUY ${leg} returned no orderID`);
                return;
            }
            logger.info(`Posted ${quote.side} ${leg} ${orderId.slice(0, 12)}...: ${quote.size.toFixed(4)} @ ${quote.price.toFixed(4)} (${cost.toFixed(4)} USDC)`);
            this.orders.push({ leg, side: quote.side, orderId, tokenId, price: quote.price, size: quote.size, filledSize: 0, status: "NEW" });
            if (quote.side === "BUY") {
                if (leg === "UP") this.spentUp += cost;
                else this.spentDown += cost;
            } else if (leg === "UP") {
                this.tookProfitUp = true;
            } else {
                this.tookProfitDown = true;
            }
            this.recordOrderEvent("order_posted", leg, quote.price, quote.size, cost, orderId, "NEW", 0);
        } catch (error) {
            logger.error(`Failed to post ${quote.side} ${leg}: ${error instanceof Error ? error.message : String(error)}`);
            this.recordOrderEvent("order_error", leg, quote.price, quote.size, cost, undefined, "ERROR", 0);
        }
    }

    private applyLocalFill(leg: "UP" | "DOWN", side: "BUY" | "SELL", price: number, size: number): void {
        if (side === "BUY") {
            this.orders.push({ leg, side, orderId: `dry-${Date.now()}`, tokenId: "", price, size, filledSize: size, status: "FILLED" });
            if (leg === "UP") this.spentUp += price * size;
            else this.spentDown += price * size;
            return;
        }
        const currentShares = this.positionShares(leg);
        if (leg === "UP") {
            const avgCost = currentShares > 0 ? this.spentUp / currentShares : 0;
            this.spentUp = Math.max(0, this.spentUp - avgCost * size);
            this.tookProfitUp = true;
        } else {
            const avgCost = currentShares > 0 ? this.spentDown / currentShares : 0;
            this.spentDown = Math.max(0, this.spentDown - avgCost * size);
            this.tookProfitDown = true;
        }
    }

    private async pollOrders(): Promise<void> {
        if (this.cfg.dryRun || this.orders.length === 0 || this.stopped) return;
        for (const order of this.orders) {
            if (isFinalOrderStatus(order.status)) continue;
            try {
                const latest = await this.client.getOrder(order.orderId);
                if (!latest) continue;
                order.status = String((latest as any).status || order.status);
                order.filledSize = orderFilledSize(latest);
                logger.info(`Order ${order.leg}: status=${order.status}, filled=${order.filledSize.toFixed(4)}/${order.size.toFixed(4)}`);
                this.recordOrderEvent("order_update", order.leg, order.price, order.size, order.price * order.size, order.orderId, order.status, order.filledSize);
            } catch (error) {
                logger.error(`Failed to poll ${order.leg} order ${order.orderId.slice(0, 12)}...: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    private async cancelOpenOrders(reason: string): Promise<void> {
        if (this.cfg.dryRun || this.orders.length === 0) return;
        for (const order of this.orders) {
            if (isFinalOrderStatus(order.status)) continue;
            try {
                await this.client.cancelOrder({ orderID: order.orderId });
                order.status = "CANCELLED";
                logger.info(`Cancelled ${order.leg} order ${order.orderId.slice(0, 12)}... (${reason})`);
                this.recordOrderEvent("order_cancelled", order.leg, order.price, order.size, order.price * order.size, order.orderId, order.status, order.filledSize);
            } catch (error) {
                logger.error(`Failed to cancel ${order.leg} order ${order.orderId.slice(0, 12)}...: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    private recordDecision(
        timestampMs: number,
        secondsLeft: number,
        btcPrice: number,
        upPrice: { bestBid?: number; bestAsk?: number; mid?: number },
        downPrice: { bestBid?: number; bestAsk?: number; mid?: number },
        reason: string | undefined,
        fairUp: number | undefined,
        fairDown: number | undefined,
        quotes: Array<{ leg: string; price: number; size: number; edge?: number }>,
    ): void {
        if (!this.cfg.recordEnabled || !this.tokens) return;
        appendEdgeRecord(this.cfg.recordPath, {
            row_type: "decision",
            timestamp: new Date(timestampMs).toISOString(),
            timestamp_ms: timestampMs,
            slug: this.tokens.slug,
            condition_id: this.tokens.conditionId,
            dry_run: this.cfg.dryRun,
            btc_price: btcPrice,
            open_price: this.openPrice ?? undefined,
            seconds_left: secondsLeft.toFixed(3),
            up_bid: formatOptionalNumber(upPrice.bestBid),
            up_ask: formatOptionalNumber(upPrice.bestAsk),
            up_mid: formatOptionalNumber(upPrice.mid),
            down_bid: formatOptionalNumber(downPrice.bestBid),
            down_ask: formatOptionalNumber(downPrice.bestAsk),
            down_mid: formatOptionalNumber(downPrice.mid),
            fair_up: formatOptionalNumber(fairUp),
            fair_down: formatOptionalNumber(fairDown),
            decision_reason: reason,
            quotes: quotes.map((quote) => `${quote.leg}@${quote.price.toFixed(4)}x${quote.size.toFixed(4)} edge=${quote.edge?.toFixed(4) ?? ""}`).join("|"),
            spent_up: this.spentUp.toFixed(6),
            spent_down: this.spentDown.toFixed(6),
        });
    }

    private recordOrderEvent(rowType: string, leg: "UP" | "DOWN", price: number, size: number, cost: number, orderId: string | undefined, status: string, filledSize: number): void {
        if (!this.cfg.recordEnabled || !this.tokens) return;
        appendEdgeRecord(this.cfg.recordPath, {
            row_type: rowType,
            timestamp: new Date().toISOString(),
            timestamp_ms: Date.now(),
            slug: this.tokens.slug,
            condition_id: this.tokens.conditionId,
            dry_run: this.cfg.dryRun,
            open_price: this.openPrice ?? undefined,
            spent_up: this.spentUp.toFixed(6),
            spent_down: this.spentDown.toFixed(6),
            event_leg: leg,
            event_price: price.toFixed(6),
            event_size: size.toFixed(6),
            event_cost: cost.toFixed(6),
            order_id: orderId,
            order_status: status,
            filled_size: filledSize.toFixed(6),
        });
    }
}

async function bootstrapLiveClient(cfg: EdgeConfig): Promise<ClobClient> {
    if (cfg.dryRun) {
        logger.info("Dry-run mode: skipping wallet, CLOB credential, allowance, and balance checks.");
        return {} as ClobClient;
    }

    const validPrivateKey = validatePrivateKey();
    if (!validPrivateKey) throw new Error("WALLET_PRIVATE_KEY is invalid or missing");

    await createCredential();
    const client = await getClobClient();

    const skipApprove = process.env.SKIP_ALLOWANCE_APPROVE === "true";
    if (!skipApprove) {
        try {
            logger.info("Approving USDC allowances to Polymarket contracts...");
            await approveUSDCAllowance();
            await updateClobBalanceAllowance(client);
        } catch (error) {
            logger.error(`Allowance approval failed: ${error instanceof Error ? error.message : String(error)}`);
            logger.error("Continuing only if existing allowance is sufficient.");
        }
    }

    const requiredBalance = Math.max(config.bot.minUsdcBalance, cfg.maxUsdcPerLeg * 2);
    const gate = await waitForMinimumUsdcBalance(client, requiredBalance, {
        pollIntervalMs: 15_000,
        timeoutMs: 0,
        logEveryPoll: true,
    });
    if (!gate.ok) throw new Error(`USDC balance gate failed: required>=${requiredBalance}`);

    return client;
}

async function main(): Promise<void> {
    const cfg = loadEdgeConfig();
    setupConsoleFileLogging({
        logFilePath: config.logging.logFilePath,
        logDir: config.logging.logDir,
        filePrefix: config.logging.logFilePrefix,
    });

    logger.info("=== BTC 5m Edge Strategy (Live Trading) ===");
    logger.info(`Config: vol=${cfg.volPerInterval}, minEdge=${cfg.minEdge}, orderUsdc=${cfg.orderUsdc}, maxPerLeg=${cfg.maxUsdcPerLeg}`);

    const client = await bootstrapLiveClient(cfg);
    const bot = new BtcFiveMinuteEdgeBot(client, cfg);

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
