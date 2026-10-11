// Setup global fetch proxy FIRST (before any other imports that might call fetch)
import "./setup-proxy";

// Patch Exchange protocol version to V2 (npm package still ships V1)
import "./patch-exchange-v2";

import { ClobClient, CreateOrderOptions, OrderType, Side, UserOrderV2 as UserOrder } from "@polymarket/clob-client-v2";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { config } from "./config";
import { getClobClient } from "./providers/clobclient";
import { WebSocketOrderBook, TokenPrice } from "./providers/websocketOrderbook";
import { validatePrivateKey } from "./security/validatePrivateKey";
import { createCredential } from "./security/createCredential";
import { approveUSDCAllowance, updateClobBalanceAllowance } from "./security/allowance";
import { waitForMinimumUsdcBalance } from "./utils/balance";
import { logger } from "./utils/logger";
import { setupConsoleFileLogging } from "./utils/console-file";
import { estimatedMakerRebate, evaluateBtc5mMakerRangeRisk, polymarketFeeEquivalent } from "./strategies/btc5m/maker-range";

type ArbConfig = {
    mode: "range-arb" | "maker-range";
    dryRun: boolean;
    market: string;
    intervalMinutes: number;
    priceX: number;
    usdcPerLeg: number;
    tickSize: CreateOrderOptions["tickSize"];
    negRisk: boolean;
    minSecondsLeftToOpen: number;
    cancelSecondsBeforeEnd: number;
    requireAmplitude: boolean;
    amplitudeLookbackSeconds: number;
    amplitudeBuffer: number;
    orderShares: number;
    maxUnpairedSeconds: number;
    stopLossDelta: number;
    forceExitSecondsLeft: number;
    orderPollIntervalMs: number;
    marketLogIntervalMs: number;
    recordIntervalMs: number;
    recordEnabled: boolean;
    recordPath: string;
    takerFeeRate: number;
    makerRebateRate: number;
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
    side: "BUY" | "SELL";
    role: "entry" | "risk-exit";
    orderId: string;
    tokenId: string;
    price: number;
    size: number;
    filledSize: number;
    status: string;
    createdAtMs: number;
    maker: boolean;
};

type PricePoint = {
    t: number;
    upAsk: number;
};

function formatBook(price: TokenPrice | null): string {
    return `bid=${price?.bestBid?.toFixed(2) ?? "--"} ask=${price?.bestAsk?.toFixed(2) ?? "--"}`;
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

function envBool(name: string, fallback: boolean): boolean {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    return raw.toLowerCase() === "true";
}

function loadArbConfig(): ArbConfig {
    const mode = process.env.BTC5M_RANGE_MODE === "maker-range" ? "maker-range" : "range-arb";
    const makerRange = mode === "maker-range";
    const priceX = makerRange ? envNumber("MAKER_RANGE_PRICE", 0.4) : envNumber("RANGE_ARB_PRICE_X", 0.4);
    const orderShares = makerRange ? envNumber("MAKER_RANGE_ORDER_SHARES", 5) : 0;
    const cfg: ArbConfig = {
        mode,
        dryRun: makerRange ? envBool("MAKER_RANGE_DRY_RUN", true) : envBool("RANGE_ARB_DRY_RUN", true),
        market: envString("RANGE_ARB_MARKET", envString("BTC5M_MARKET", "btc")).toLowerCase(),
        intervalMinutes: envNumber("RANGE_ARB_INTERVAL_MINUTES", envNumber("BTC5M_INTERVAL_MINUTES", 5)),
        priceX,
        usdcPerLeg: makerRange ? priceX * orderShares : envNumber("RANGE_ARB_USDC_PER_LEG", 5),
        tickSize: envString("RANGE_ARB_TICK_SIZE", envString("BTC5M_TICK_SIZE", "0.01")) as CreateOrderOptions["tickSize"],
        negRisk: envBool("RANGE_ARB_NEG_RISK", envBool("BTC5M_NEG_RISK", config.copytrade.negRisk)),
        minSecondsLeftToOpen: makerRange ? envNumber("MAKER_RANGE_MIN_SECONDS_LEFT_TO_OPEN", 90) : envNumber("RANGE_ARB_MIN_SECONDS_LEFT_TO_OPEN", 60),
        cancelSecondsBeforeEnd: makerRange ? envNumber("MAKER_RANGE_CANCEL_SECONDS_BEFORE_END", 30) : envNumber("RANGE_ARB_CANCEL_SECONDS_BEFORE_END", envNumber("BTC5M_CANCEL_SECONDS_BEFORE_END", 8)),
        requireAmplitude: envBool("RANGE_ARB_REQUIRE_AMPLITUDE", false),
        amplitudeLookbackSeconds: envNumber("RANGE_ARB_AMPLITUDE_LOOKBACK_SECONDS", 120),
        amplitudeBuffer: envNumber("RANGE_ARB_AMPLITUDE_BUFFER", 0.03),
        orderShares,
        maxUnpairedSeconds: envNumber("MAKER_RANGE_MAX_UNPAIRED_SECONDS", 45),
        stopLossDelta: envNumber("MAKER_RANGE_STOP_LOSS_DELTA", 0.10),
        forceExitSecondsLeft: envNumber("MAKER_RANGE_FORCE_EXIT_SECONDS_LEFT", 60),
        orderPollIntervalMs: envNumber("MAKER_RANGE_ORDER_POLL_INTERVAL_MS", 1000),
        marketLogIntervalMs: envNumber("MAKER_RANGE_MARKET_LOG_INTERVAL_MS", 1000),
        recordIntervalMs: envNumber("MAKER_RANGE_RECORD_INTERVAL_MS", 1000),
        recordEnabled: makerRange && envBool("MAKER_RANGE_RECORD_ENABLED", true),
        recordPath: resolve(envString("MAKER_RANGE_RECORD_FILE", "data/btc5m-maker-range-live.csv")),
        takerFeeRate: envNumber("MAKER_RANGE_TAKER_FEE_RATE", 0.07),
        makerRebateRate: envNumber("MAKER_RANGE_REBATE_RATE", 0.20),
    };

    if (cfg.intervalMinutes <= 0) throw new Error("RANGE_ARB_INTERVAL_MINUTES must be > 0");
    if (!(cfg.priceX > 0 && cfg.priceX < 0.5)) throw new Error("RANGE_ARB_PRICE_X must be > 0 and < 0.5");
    if (!(cfg.usdcPerLeg > 0)) throw new Error("RANGE_ARB_USDC_PER_LEG must be > 0");
    if (cfg.minSecondsLeftToOpen < 0) throw new Error("RANGE_ARB_MIN_SECONDS_LEFT_TO_OPEN must be >= 0");
    if (cfg.cancelSecondsBeforeEnd < 0) throw new Error("RANGE_ARB_CANCEL_SECONDS_BEFORE_END must be >= 0");
    if (makerRange && (!(cfg.orderShares >= 5) || cfg.maxUnpairedSeconds <= 0 || cfg.stopLossDelta <= 0 || cfg.stopLossDelta >= cfg.priceX || cfg.forceExitSecondsLeft < cfg.cancelSecondsBeforeEnd || cfg.orderPollIntervalMs <= 0 || cfg.recordIntervalMs <= 0)) throw new Error("Invalid MAKER_RANGE configuration");
    return cfg;
}

const RECORD_HEADERS = ["row_type", "timestamp", "timestamp_ms", "slug", "condition_id", "seconds_left", "up_bid", "up_ask", "down_bid", "down_ask", "event_leg", "event_side", "event_role", "event_price", "event_size", "order_id", "order_status", "filled_size", "inventory_up", "inventory_down", "buy_cost", "sell_proceeds", "maker_fee_equivalent", "estimated_rebate", "estimated_taker_fees", "note"] as const;

function csvValue(value: unknown): string {
    const text = value === undefined || value === null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function appendRecord(path: string, row: Record<string, unknown>): void {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) appendFileSync(path, `${RECORD_HEADERS.join(",")}\n`);
    appendFileSync(path, `${RECORD_HEADERS.map((header) => csvValue(row[header])).join(",")}\n`);
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

class BtcFiveMinuteRangeArbBot {
    private ws: WebSocketOrderBook | null = null;
    private tokens: MarketTokens | null = null;
    private placed = false;
    private orders: PlacedOrder[] = [];
    private priceHistory: PricePoint[] = [];
    private timers: NodeJS.Timeout[] = [];
    private stopped = false;
    private inventoryUp = 0;
    private inventoryDown = 0;
    private buyCost = 0;
    private sellProceeds = 0;
    private makerFeeEquivalent = 0;
    private estimatedRebate = 0;
    private estimatedTakerFees = 0;
    private firstFillAtMs?: number;
    private pairLocked = false;
    private riskExitStarted = false;
    private lastMarketLogAtMs = 0;
    private lastRecordAtMs = 0;
    private riskManagementInFlight = false;

    constructor(private client: ClobClient, private cfg: ArbConfig) {}

    async start(): Promise<void> {
        logger.info(`Starting BTC 5m ${this.cfg.mode}: market=${this.cfg.market}, price=${this.cfg.priceX}, shares=${this.cfg.mode === "maker-range" ? this.cfg.orderShares : (this.cfg.usdcPerLeg / this.cfg.priceX).toFixed(4)}, postOnly=${this.cfg.mode === "maker-range"}, dryRun=${this.cfg.dryRun}`);
        if (this.cfg.recordEnabled) logger.info(`Maker-range trajectory CSV: ${this.cfg.recordPath}`);
        this.ws = new WebSocketOrderBook("market", [], null);
        await this.ws.connect();
        await this.initializeCurrentCycle();

        this.timers.push(setInterval(() => void this.handleCycleTick(), 5_000));
        this.timers.push(setInterval(() => void this.pollOrders(), this.cfg.mode === "maker-range" ? this.cfg.orderPollIntervalMs : 2_000));
    }

    async stop(): Promise<void> {
        this.stopped = true;
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        await this.cancelOpenOrders("shutdown");
        if (this.ws) this.ws.disconnect();
        logger.info("BTC 5m range arb stopped");
    }

    private async handleCycleTick(): Promise<void> {
        if (this.stopped) return;
        const current = slugForCycle(this.cfg.market, this.cfg.intervalMinutes);
        if (!this.tokens || this.tokens.slug !== current.slug) {
            await this.cancelOpenOrders("new cycle");
            this.resetCycleState();
            await this.initializeCurrentCycle();
            return;
        }

        const secondsLeft = (this.tokens.endMs - Date.now()) / 1000;
        if (secondsLeft <= this.cfg.cancelSecondsBeforeEnd) {
            if (this.cfg.mode === "maker-range") {
                await this.cancelEntryOrders(`cycle ending in ${secondsLeft.toFixed(1)}s`);
                await this.manageMakerRangeRisk();
            } else {
                await this.cancelOpenOrders(`cycle ending in ${secondsLeft.toFixed(1)}s`);
            }
        }
    }

    private resetCycleState(): void {
        this.tokens = null;
        this.placed = false;
        this.orders = [];
        this.priceHistory = [];
        this.inventoryUp = 0;
        this.inventoryDown = 0;
        this.buyCost = 0;
        this.sellProceeds = 0;
        this.makerFeeEquivalent = 0;
        this.estimatedRebate = 0;
        this.estimatedTakerFees = 0;
        this.firstFillAtMs = undefined;
        this.pairLocked = false;
        this.riskExitStarted = false;
        this.lastMarketLogAtMs = 0;
        this.lastRecordAtMs = 0;
        this.riskManagementInFlight = false;
    }

    private async initializeCurrentCycle(): Promise<void> {
        const cycle = slugForCycle(this.cfg.market, this.cfg.intervalMinutes);
        try {
            const tokens = await fetchTokenIdsForSlug(cycle.slug, cycle.startMs, cycle.endMs);
            this.tokens = tokens;
            logger.info(`Cycle ready: ${tokens.slug}`);
            logger.info(`UP=${tokens.upTokenId.slice(0, 20)}..., DOWN=${tokens.downTokenId.slice(0, 20)}...`);

            if (!this.ws) throw new Error("WebSocket is not initialized");
            this.ws.subscribeToTokenIds([tokens.upTokenId, tokens.downTokenId]);
            this.ws.setTokenLabel(tokens.upTokenId, "Up");
            this.ws.setTokenLabel(tokens.downTokenId, "Down");
            this.ws.setTokenPair(tokens.upTokenId, tokens.downTokenId);
            this.ws.onPriceUpdate(tokens.upTokenId, () => void this.onPriceUpdate());
            this.ws.onPriceUpdate(tokens.downTokenId, () => void this.onPriceUpdate());

            await this.maybePlaceCycleOrders();
        } catch (error) {
            logger.error(`Failed to initialize current ${this.cfg.intervalMinutes}m market: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private onPriceUpdate(): void {
        if (!this.tokens || !this.ws || this.stopped) return;
        const up = this.ws.getPrice(this.tokens.upTokenId);
        if (up?.bestAsk && Number.isFinite(up.bestAsk)) {
            this.priceHistory.push({ t: Date.now(), upAsk: up.bestAsk });
            const cutoff = Date.now() - this.cfg.amplitudeLookbackSeconds * 1000;
            this.priceHistory = this.priceHistory.filter((p) => p.t >= cutoff);
        }
        if (this.cfg.mode === "maker-range") {
            this.logAndRecordMarket();
            void this.manageMakerRangeRisk();
        }
        void this.maybePlaceCycleOrders();
    }

    private logAndRecordMarket(): void {
        if (!this.tokens || !this.ws) return;
        const now = Date.now();
        const up = this.ws.getPrice(this.tokens.upTokenId);
        const down = this.ws.getPrice(this.tokens.downTokenId);
        const secondsLeft = (this.tokens.endMs - now) / 1000;
        if (now - this.lastMarketLogAtMs >= this.cfg.marketLogIntervalMs) {
            logger.info(`📊 Up ${formatBook(up)} | Down ${formatBook(down)} | Left ${secondsLeft.toFixed(1)}s | Inventory ${this.inventoryUp.toFixed(4)}/${this.inventoryDown.toFixed(4)}`);
            this.lastMarketLogAtMs = now;
        }
        if (this.cfg.recordEnabled && now - this.lastRecordAtMs >= this.cfg.recordIntervalMs) {
            this.record("market", { seconds_left: secondsLeft.toFixed(3), up_bid: up?.bestBid, up_ask: up?.bestAsk, down_bid: down?.bestBid, down_ask: down?.bestAsk });
            this.lastRecordAtMs = now;
        }
    }

    private amplitudeOk(): boolean {
        if (!this.cfg.requireAmplitude) return true;
        const requiredMove = 1 - 2 * this.cfg.priceX;
        const requiredRange = requiredMove + this.cfg.amplitudeBuffer;
        if (this.priceHistory.length < 3) return false;
        const values = this.priceHistory.map((p) => p.upAsk);
        const range = Math.max(...values) - Math.min(...values);
        if (range < requiredRange) {
            logger.info(`Amplitude gate waiting: range=${range.toFixed(4)}, required>=${requiredRange.toFixed(4)}`);
            return false;
        }
        return true;
    }

    private async maybePlaceCycleOrders(): Promise<void> {
        if (!this.tokens || this.placed || this.stopped) return;
        const secondsLeft = (this.tokens.endMs - Date.now()) / 1000;
        if (secondsLeft < this.cfg.minSecondsLeftToOpen) {
            logger.info(`Skip placing orders: only ${secondsLeft.toFixed(1)}s left in ${this.tokens.slug}`);
            this.placed = true;
            return;
        }
        if (!this.amplitudeOk()) return;

        if (this.cfg.mode === "maker-range" && this.ws) {
            const upAsk = this.ws.getPrice(this.tokens.upTokenId)?.bestAsk;
            const downAsk = this.ws.getPrice(this.tokens.downTokenId)?.bestAsk;
            if (upAsk === null || upAsk === undefined || downAsk === null || downAsk === undefined) return;
            if (upAsk <= this.cfg.priceX || downAsk <= this.cfg.priceX) {
                logger.info(`Post-only gate waiting: asks=${upAsk.toFixed(2)}/${downAsk.toFixed(2)} must both be above ${this.cfg.priceX.toFixed(2)}`);
                return;
            }
        }

        const size = this.cfg.mode === "maker-range" ? this.cfg.orderShares : this.cfg.usdcPerLeg / this.cfg.priceX;
        const lockedProfit = size - 2 * this.cfg.usdcPerLeg;
        logger.info(`Placing pair orders for ${this.tokens.slug}: BUY UP ${size.toFixed(4)} @ ${this.cfg.priceX}, BUY DOWN ${size.toFixed(4)} @ ${this.cfg.priceX}`);
        logger.info(`If both legs fill: cost=${(2 * this.cfg.usdcPerLeg).toFixed(4)} USDC, payout=${size.toFixed(4)} USDC, profit=${lockedProfit.toFixed(4)} USDC`);

        this.placed = true;
        const [upOrder, downOrder] = await Promise.all([
            this.placeBuy("UP", this.tokens.upTokenId, size),
            this.placeBuy("DOWN", this.tokens.downTokenId, size),
        ]);
        this.orders = [upOrder, downOrder].filter(Boolean) as PlacedOrder[];
        if (this.cfg.mode === "maker-range" && this.orders.length !== 2) await this.cancelOpenOrders("incomplete post-only pair placement");
    }

    private async placeBuy(leg: "UP" | "DOWN", tokenId: string, size: number): Promise<PlacedOrder | null> {
        const order: UserOrder = {
            tokenID: tokenId,
            side: Side.BUY,
            price: this.cfg.priceX,
            size,
        };

        const cost = this.cfg.priceX * size;
        if (this.cfg.dryRun) {
            logger.info(`[DRY-RUN] BUY ${leg} ${size.toFixed(4)} shares @ ${this.cfg.priceX.toFixed(4)} (${cost.toFixed(4)} USDC)`);
            return null;
        }

        try {
            const response = await this.client.createAndPostOrder(
                order,
                { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                OrderType.GTC,
                this.cfg.mode === "maker-range"
            );
            const orderId = response?.orderID;
            if (!orderId) {
                logger.error(`Order for ${leg} returned no orderID`);
                return null;
            }
            logger.info(`Posted ${this.cfg.mode === "maker-range" ? "post-only " : ""}${leg} order ${orderId.slice(0, 12)}...: ${size.toFixed(4)} @ ${this.cfg.priceX.toFixed(4)}`);
            const placed: PlacedOrder = { leg, side: "BUY", role: "entry", orderId, tokenId, price: this.cfg.priceX, size, filledSize: 0, status: "NEW", createdAtMs: Date.now(), maker: this.cfg.mode === "maker-range" };
            this.recordOrder("order_posted", placed);
            return placed;
        } catch (error) {
            logger.error(`Failed to post ${leg} order: ${error instanceof Error ? error.message : String(error)}`);
            return null;
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
                const latestFilledSize = orderFilledSize(latest);
                const fillDelta = Math.max(0, latestFilledSize - order.filledSize);
                if (fillDelta > 0) this.applyFill(order, fillDelta);
                order.filledSize = latestFilledSize;
                logger.info(`Order ${order.leg}: status=${order.status}, filled=${order.filledSize.toFixed(4)}/${order.size.toFixed(4)}`);
            } catch (error) {
                logger.error(`Failed to poll ${order.leg} order ${order.orderId.slice(0, 12)}...: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const up = this.orders.find((o) => o.leg === "UP");
        const down = this.orders.find((o) => o.leg === "DOWN");
        if (!this.pairLocked && up && down && up.filledSize >= up.size && down.filledSize >= down.size) {
            const payout = Math.min(up.filledSize, down.filledSize);
            const cost = up.filledSize * up.price + down.filledSize * down.price;
            logger.info(`PAIR LOCKED: payout=${payout.toFixed(4)}, cost=${cost.toFixed(4)}, expectedProfit=${(payout - cost).toFixed(4)} USDC`);
        }
        if (this.cfg.mode === "maker-range") await this.manageMakerRangeRisk();
    }

    private applyFill(order: PlacedOrder, fillDelta: number): void {
        if (order.side === "BUY") {
            if (order.leg === "UP") this.inventoryUp += fillDelta;
            else this.inventoryDown += fillDelta;
            this.buyCost += order.price * fillDelta;
            if (order.maker) {
                const feeEquivalent = polymarketFeeEquivalent(fillDelta, order.price, this.cfg.takerFeeRate);
                this.makerFeeEquivalent += feeEquivalent;
                this.estimatedRebate += estimatedMakerRebate(fillDelta, order.price, this.cfg);
            }
        } else {
            if (order.leg === "UP") this.inventoryUp = Math.max(0, this.inventoryUp - fillDelta);
            else this.inventoryDown = Math.max(0, this.inventoryDown - fillDelta);
            this.sellProceeds += order.price * fillDelta;
            if (!order.maker) this.estimatedTakerFees += polymarketFeeEquivalent(fillDelta, order.price, this.cfg.takerFeeRate);
        }
        if (!this.firstFillAtMs && Math.abs(this.inventoryUp - this.inventoryDown) > 1e-9) this.firstFillAtMs = Date.now();
        logger.info(`FILL ${order.maker ? "MAKER" : "TAKER"} ${order.side} ${order.leg} ${fillDelta.toFixed(4)} @ ${order.price.toFixed(4)} | inventory=${this.inventoryUp.toFixed(4)}/${this.inventoryDown.toFixed(4)} rebate≈${this.estimatedRebate.toFixed(5)}`);
        this.recordOrder("order_fill", { ...order, filledSize: order.filledSize + fillDelta }, fillDelta);
    }

    private async manageMakerRangeRisk(): Promise<void> {
        if (this.riskManagementInFlight) return;
        this.riskManagementInFlight = true;
        try {
            await this.manageMakerRangeRiskInner();
        } finally {
            this.riskManagementInFlight = false;
        }
    }

    private async manageMakerRangeRiskInner(): Promise<void> {
        if (this.cfg.mode !== "maker-range" || !this.tokens || !this.ws || this.stopped || this.pairLocked) return;
        const imbalance = this.inventoryUp - this.inventoryDown;
        if (Math.abs(imbalance) <= 1e-9) {
            if (this.inventoryUp > 0) {
                this.pairLocked = true;
                await this.cancelEntryOrders("pair locked");
                const locked = Math.min(this.inventoryUp, this.inventoryDown);
                const expectedProfit = locked - this.buyCost;
                logger.info(`MAKER PAIR LOCKED: shares=${locked.toFixed(4)}, cost=${this.buyCost.toFixed(4)}, tradingProfit=${expectedProfit.toFixed(4)}, estimatedRebate=${this.estimatedRebate.toFixed(5)}`);
                this.record("pair_locked", { note: `tradingProfit=${expectedProfit.toFixed(6)}` });
            }
            return;
        }
        if (!this.firstFillAtMs) return;
        if (this.riskExitStarted) {
            const activeExit = this.orders.find((order) => order.role === "risk-exit" && !isFinalOrderStatus(order.status));
            if (activeExit && Date.now() - activeExit.createdAtMs < 2_000) return;
            if (activeExit) await this.cancelOrder(activeExit, "reprice risk exit");
            const remainingImbalance = this.inventoryUp - this.inventoryDown;
            if (Math.abs(remainingImbalance) <= 1e-9) return;
            const exitLeg = remainingImbalance > 0 ? "UP" : "DOWN";
            const exitBook = this.ws.getPrice(exitLeg === "UP" ? this.tokens.upTokenId : this.tokens.downTokenId);
            if (!exitBook?.bestBid) return;
            const replacement = await this.placeRiskExit(exitLeg, Math.abs(remainingImbalance), exitBook.bestBid, "reprice");
            if (replacement) this.orders.push(replacement);
            else this.riskExitStarted = false;
            return;
        }
        const heldLeg = imbalance > 0 ? "UP" : "DOWN";
        const heldBook = this.ws.getPrice(heldLeg === "UP" ? this.tokens.upTokenId : this.tokens.downTokenId);
        const secondsLeft = (this.tokens.endMs - Date.now()) / 1000;
        const decision = evaluateBtc5mMakerRangeRisk({
            heldLeg,
            heldBid: heldBook?.bestBid ?? undefined,
            firstFillAtMs: this.firstFillAtMs,
            timestampMs: Date.now(),
            secondsLeft,
            params: {
                price: this.cfg.priceX,
                shares: this.cfg.orderShares,
                maxUnpairedSeconds: this.cfg.maxUnpairedSeconds,
                stopLossDelta: this.cfg.stopLossDelta,
                forceExitSecondsLeft: this.cfg.forceExitSecondsLeft,
                takerFeeRate: this.cfg.takerFeeRate,
                makerRebateRate: this.cfg.makerRebateRate,
            },
        });
        if (!decision.exit) return;
        logger.warning(`Maker-range risk exit: ${decision.reason}, held=${heldLeg}, bid=${heldBook?.bestBid?.toFixed(2) ?? "--"}, imbalance=${Math.abs(imbalance).toFixed(4)}`);
        await this.cancelEntryOrders(`risk exit ${decision.reason}`);
        const refreshedImbalance = this.inventoryUp - this.inventoryDown;
        if (Math.abs(refreshedImbalance) <= 1e-9) return;
        const exitLeg = refreshedImbalance > 0 ? "UP" : "DOWN";
        const exitBook = this.ws.getPrice(exitLeg === "UP" ? this.tokens.upTokenId : this.tokens.downTokenId);
        if (!exitBook?.bestBid) {
            logger.error(`Cannot risk-exit ${exitLeg}: no best bid`);
            return;
        }
        const placed = await this.placeRiskExit(exitLeg, Math.abs(refreshedImbalance), exitBook.bestBid, decision.reason ?? "risk");
        if (placed) {
            this.orders.push(placed);
            this.riskExitStarted = true;
        }
    }

    private async placeRiskExit(leg: "UP" | "DOWN", size: number, price: number, reason: string): Promise<PlacedOrder | null> {
        if (!this.tokens) return null;
        const tokenId = leg === "UP" ? this.tokens.upTokenId : this.tokens.downTokenId;
        if (this.cfg.dryRun) {
            logger.info(`[DRY-RUN] risk-exit SELL ${leg} ${size.toFixed(4)} @ ${price.toFixed(4)} (${reason})`);
            return null;
        }
        try {
            const response = await this.client.createAndPostOrder({ tokenID: tokenId, side: Side.SELL, price, size }, { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk }, OrderType.GTC, false);
            const orderId = response?.orderID;
            if (!orderId) {
                logger.error(`Risk-exit SELL ${leg} returned no orderID: ${JSON.stringify(response)}`);
                return null;
            }
            const placed: PlacedOrder = { leg, side: "SELL", role: "risk-exit", orderId, tokenId, price, size, filledSize: 0, status: "NEW", createdAtMs: Date.now(), maker: false };
            logger.info(`Posted risk-exit SELL ${leg} ${size.toFixed(4)} @ ${price.toFixed(4)} (${reason})`);
            this.recordOrder("order_posted", placed);
            return placed;
        } catch (error) {
            logger.error(`Failed risk-exit SELL ${leg}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    private async cancelEntryOrders(reason: string): Promise<void> {
        for (const order of this.orders) {
            if (order.role !== "entry" || isFinalOrderStatus(order.status)) continue;
            await this.cancelOrder(order, reason);
        }
    }

    private async cancelOrder(order: PlacedOrder, reason: string): Promise<void> {
        try {
            const latest = await this.client.getOrder(order.orderId);
            if (latest) {
                const latestFilledSize = orderFilledSize(latest);
                const fillDelta = Math.max(0, latestFilledSize - order.filledSize);
                if (fillDelta > 0) this.applyFill(order, fillDelta);
                order.filledSize = latestFilledSize;
                order.status = String((latest as any).status || order.status);
            }
            if (isFinalOrderStatus(order.status)) return;
            await this.client.cancelOrder({ orderID: order.orderId });
            order.status = "CANCELLED";
            logger.info(`Cancelled ${order.leg} ${order.side} ${order.orderId.slice(0, 12)}... (${reason})`);
            this.recordOrder("order_cancelled", order, undefined, reason);
        } catch (error) {
            logger.error(`Failed to cancel ${order.leg} order ${order.orderId.slice(0, 12)}...: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private record(rowType: string, values: Record<string, unknown> = {}): void {
        if (!this.cfg.recordEnabled || !this.tokens) return;
        appendRecord(this.cfg.recordPath, {
            row_type: rowType,
            timestamp: new Date().toISOString(),
            timestamp_ms: Date.now(),
            slug: this.tokens.slug,
            condition_id: this.tokens.conditionId,
            inventory_up: this.inventoryUp.toFixed(6),
            inventory_down: this.inventoryDown.toFixed(6),
            buy_cost: this.buyCost.toFixed(6),
            sell_proceeds: this.sellProceeds.toFixed(6),
            maker_fee_equivalent: this.makerFeeEquivalent.toFixed(6),
            estimated_rebate: this.estimatedRebate.toFixed(6),
            estimated_taker_fees: this.estimatedTakerFees.toFixed(6),
            ...values,
        });
    }

    private recordOrder(rowType: string, order: PlacedOrder, fillSize?: number, note?: string): void {
        this.record(rowType, {
            event_leg: order.leg,
            event_side: order.side,
            event_role: order.role,
            event_price: order.price.toFixed(6),
            event_size: order.size.toFixed(6),
            order_id: order.orderId,
            order_status: order.status,
            filled_size: (fillSize ?? order.filledSize).toFixed(6),
            note,
        });
    }

    private async cancelOpenOrders(reason: string): Promise<void> {
        if (this.cfg.dryRun || this.orders.length === 0) return;
        for (const order of this.orders) {
            if (isFinalOrderStatus(order.status)) continue;
            await this.cancelOrder(order, reason);
        }
    }
}

async function bootstrapLiveClient(cfg: ArbConfig): Promise<ClobClient> {
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

    const requiredBalance = Math.max(config.bot.minUsdcBalance, cfg.usdcPerLeg * 2);
    const gate = await waitForMinimumUsdcBalance(client, requiredBalance, {
        pollIntervalMs: 15_000,
        timeoutMs: 0,
        logEveryPoll: true,
    });
    if (!gate.ok) throw new Error(`USDC balance gate failed: required>=${requiredBalance}`);

    return client;
}

async function main(): Promise<void> {
    const cfg = loadArbConfig();
    setupConsoleFileLogging({
        logFilePath: config.logging.logFilePath,
        logDir: config.logging.logDir,
        filePrefix: config.logging.logFilePrefix,
    });

    const client = await bootstrapLiveClient(cfg);
    const bot = new BtcFiveMinuteRangeArbBot(client, cfg);

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
