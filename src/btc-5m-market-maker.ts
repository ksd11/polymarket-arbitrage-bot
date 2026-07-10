// Setup global fetch proxy FIRST (before any other imports that might call fetch)
import "./setup-proxy";

// Patch Exchange protocol version to V2 (npm package still ships V1)
import "./patch-exchange-v2";

import { ClobClient, CreateOrderOptions, OrderType, Side, UserOrderV2 as UserOrder } from "@polymarket/clob-client-v2";
import { config } from "./config";
import { getClobClient } from "./providers/clobclient";
import { WebSocketOrderBook } from "./providers/websocketOrderbook";
import { validatePrivateKey } from "./security/validatePrivateKey";
import { createCredential } from "./security/createCredential";
import { approveUSDCAllowance, updateClobBalanceAllowance } from "./security/allowance";
import { waitForMinimumUsdcBalance } from "./utils/balance";
import { logger } from "./utils/logger";
import { setupConsoleFileLogging } from "./utils/console-file";

type Leg = "UP" | "DOWN";
type QuoteSide = "BUY" | "SELL";
type OrderKey = `${Leg}:${QuoteSide}`;

type MarketMakerConfig = {
    dryRun: boolean;
    market: string;
    intervalMinutes: number;
    quoteShares: number;
    maxUsdcPerLeg: number;
    maxInventoryShares: number;
    quoteSpread: number;
    minLockedEdge: number;
    inventorySkewPerShare: number;
    requoteThreshold: number;
    tickSize: CreateOrderOptions["tickSize"];
    negRisk: boolean;
    minSecondsLeftToQuote: number;
    cancelSecondsBeforeEnd: number;
    quoteIntervalMs: number;
    pollIntervalMs: number;
    enableSellExcess: boolean;
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

type ActiveOrder = {
    key: OrderKey;
    leg: Leg;
    side: QuoteSide;
    orderId: string;
    tokenId: string;
    price: number;
    size: number;
    filledSize: number;
    status: string;
};

type Quote = {
    key: OrderKey;
    leg: Leg;
    side: QuoteSide;
    tokenId: string;
    price: number;
    size: number;
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

function loadMarketMakerConfig(): MarketMakerConfig {
    const cfg: MarketMakerConfig = {
        dryRun: envBool("MM_DRY_RUN", true),
        market: envString("MM_MARKET", "btc").toLowerCase(),
        intervalMinutes: envNumber("MM_INTERVAL_MINUTES", 5),
        quoteShares: envNumber("MM_QUOTE_SHARES", 5),
        maxUsdcPerLeg: envNumber("MM_MAX_USDC_PER_LEG", 0),
        maxInventoryShares: envNumber("MM_MAX_INVENTORY_SHARES", 30),
        quoteSpread: envNumber("MM_QUOTE_SPREAD", 0.06),
        minLockedEdge: envNumber("MM_MIN_LOCKED_EDGE", 0.02),
        inventorySkewPerShare: envNumber("MM_INVENTORY_SKEW_PER_SHARE", 0.002),
        requoteThreshold: envNumber("MM_REQUOTE_THRESHOLD", 0.01),
        tickSize: envString("MM_TICK_SIZE", "0.01") as CreateOrderOptions["tickSize"],
        negRisk: envBool("MM_NEG_RISK", config.copytrade.negRisk),
        minSecondsLeftToQuote: envNumber("MM_MIN_SECONDS_LEFT_TO_QUOTE", 45),
        cancelSecondsBeforeEnd: envNumber("MM_CANCEL_SECONDS_BEFORE_END", 8),
        quoteIntervalMs: envNumber("MM_QUOTE_INTERVAL_MS", 1000),
        pollIntervalMs: envNumber("MM_POLL_INTERVAL_MS", 2000),
        enableSellExcess: envBool("MM_ENABLE_SELL_EXCESS", true),
    };

    if (cfg.intervalMinutes <= 0) throw new Error("MM_INTERVAL_MINUTES must be > 0");
    if (cfg.quoteShares <= 0) throw new Error("MM_QUOTE_SHARES must be > 0");
    if (cfg.maxUsdcPerLeg < 0) throw new Error("MM_MAX_USDC_PER_LEG must be >= 0");
    if (cfg.maxInventoryShares < cfg.quoteShares) throw new Error("MM_MAX_INVENTORY_SHARES must be >= MM_QUOTE_SHARES");
    if (!(cfg.quoteSpread > 0 && cfg.quoteSpread < 1)) throw new Error("MM_QUOTE_SPREAD must be > 0 and < 1");
    if (cfg.minLockedEdge < 0) throw new Error("MM_MIN_LOCKED_EDGE must be >= 0");
    if (cfg.inventorySkewPerShare < 0) throw new Error("MM_INVENTORY_SKEW_PER_SHARE must be >= 0");
    if (cfg.requoteThreshold <= 0) throw new Error("MM_REQUOTE_THRESHOLD must be > 0");
    if (cfg.minSecondsLeftToQuote < 0) throw new Error("MM_MIN_SECONDS_LEFT_TO_QUOTE must be >= 0");
    if (cfg.cancelSecondsBeforeEnd < 0) throw new Error("MM_CANCEL_SECONDS_BEFORE_END must be >= 0");
    if (cfg.quoteIntervalMs <= 0) throw new Error("MM_QUOTE_INTERVAL_MS must be > 0");
    if (cfg.pollIntervalMs <= 0) throw new Error("MM_POLL_INTERVAL_MS must be > 0");
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

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function tickToNumber(tickSize: CreateOrderOptions["tickSize"]): number {
    const parsed = Number(tickSize);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.01;
}

function tickDecimals(tick: number): number {
    const [, fraction = ""] = tick.toString().split(".");
    return fraction.length;
}

function roundToTick(price: number, tick: number, mode: "floor" | "ceil"): number {
    const rounded = mode === "floor" ? Math.floor(price / tick) * tick : Math.ceil(price / tick) * tick;
    return Number(clamp(rounded, tick, 1 - tick).toFixed(tickDecimals(tick)));
}

class BtcFiveMinuteMarketMakerBot {
    private ws: WebSocketOrderBook | null = null;
    private tokens: MarketTokens | null = null;
    private activeOrders = new Map<OrderKey, ActiveOrder>();
    private timers: NodeJS.Timeout[] = [];
    private stopped = false;
    private requoteInFlight = false;
    private qUp = 0;
    private qDown = 0;
    private buyCostUp = 0;
    private buyCostDown = 0;
    private realizedCost = 0;
    private readonly tick: number;

    constructor(private client: ClobClient, private cfg: MarketMakerConfig) {
        this.tick = tickToNumber(cfg.tickSize);
    }

    async start(): Promise<void> {
        logger.info(
            `Starting BTC 5m market maker: market=${this.cfg.market}, spread=${this.cfg.quoteSpread}, minEdge=${this.cfg.minLockedEdge}, shares=${this.cfg.quoteShares}, maxUsdcPerLeg=${this.cfg.maxUsdcPerLeg || "unlimited"}, dryRun=${this.cfg.dryRun}`
        );
        this.ws = new WebSocketOrderBook("market", [], null);
        await this.ws.connect();
        await this.initializeCurrentCycle();

        this.timers.push(setInterval(() => void this.handleCycleTick(), 5_000));
        this.timers.push(setInterval(() => void this.requote(), this.cfg.quoteIntervalMs));
        this.timers.push(setInterval(() => void this.pollOrders(), this.cfg.pollIntervalMs));
    }

    async stop(): Promise<void> {
        this.stopped = true;
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        await this.cancelAllOpenOrders("shutdown");
        if (this.ws) this.ws.disconnect();
        logger.info("BTC 5m market maker stopped");
    }

    private async handleCycleTick(): Promise<void> {
        if (this.stopped) return;
        const current = slugForCycle(this.cfg.market, this.cfg.intervalMinutes);
        if (!this.tokens || this.tokens.slug !== current.slug) {
            await this.cancelAllOpenOrders("new cycle");
            this.resetCycleState();
            await this.initializeCurrentCycle();
            return;
        }

        const secondsLeft = (this.tokens.endMs - Date.now()) / 1000;
        if (secondsLeft <= this.cfg.cancelSecondsBeforeEnd) {
            await this.cancelAllOpenOrders(`cycle ending in ${secondsLeft.toFixed(1)}s`);
        }
    }

    private resetCycleState(): void {
        this.tokens = null;
        this.activeOrders.clear();
        this.qUp = 0;
        this.qDown = 0;
        this.buyCostUp = 0;
        this.buyCostDown = 0;
        this.realizedCost = 0;
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
            this.ws.onPriceUpdate(tokens.upTokenId, () => void this.requote());
            this.ws.onPriceUpdate(tokens.downTokenId, () => void this.requote());

            await this.requote();
        } catch (error) {
            logger.error(`Failed to initialize current ${this.cfg.intervalMinutes}m market: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private buildQuotes(): Quote[] {
        if (!this.tokens || !this.ws) return [];

        const upPrice = this.ws.getPrice(this.tokens.upTokenId);
        const downPrice = this.ws.getPrice(this.tokens.downTokenId);
        if (!upPrice || !downPrice) return [];

        const upMid = upPrice.mid;
        const downMid = downPrice.mid;
        if (upMid === null && downMid === null) return [];

        const fairUp = clamp(
            upMid !== null && downMid !== null ? (upMid + (1 - downMid)) / 2 : upMid ?? 1 - (downMid as number),
            this.tick,
            1 - this.tick
        );
        const fairDown = 1 - fairUp;
        const netInventory = this.qUp - this.qDown;
        const inventorySkew = this.cfg.inventorySkewPerShare * netInventory;

        const bidUp = roundToTick(fairUp - this.cfg.quoteSpread / 2 - inventorySkew, this.tick, "floor");
        const bidDown = roundToTick(fairDown - this.cfg.quoteSpread / 2 + inventorySkew, this.tick, "floor");
        const buyCost = bidUp + bidDown;
        const secondsLeft = this.tokens ? (this.tokens.endMs - Date.now()) / 1000 : 0;
        const quotes: Quote[] = [];

        if (secondsLeft >= this.cfg.minSecondsLeftToQuote && buyCost <= 1 - this.cfg.minLockedEdge) {
            const buyCapacity = this.cfg.maxInventoryShares - Math.max(this.qUp, this.qDown);
            const upBuySize = Math.min(this.cfg.quoteShares, buyCapacity, this.buyBudgetSize("UP", bidUp, "UP:BUY"));
            const downBuySize = Math.min(this.cfg.quoteShares, buyCapacity, this.buyBudgetSize("DOWN", bidDown, "DOWN:BUY"));
            if (upBuySize > 0) quotes.push({ key: "UP:BUY", leg: "UP", side: "BUY", tokenId: this.tokens.upTokenId, price: bidUp, size: upBuySize });
            if (downBuySize > 0) quotes.push({ key: "DOWN:BUY", leg: "DOWN", side: "BUY", tokenId: this.tokens.downTokenId, price: bidDown, size: downBuySize });
        }

        if (this.cfg.enableSellExcess) {
            const askUp = roundToTick(fairUp + this.cfg.quoteSpread / 2 - inventorySkew, this.tick, "ceil");
            const askDown = roundToTick(fairDown + this.cfg.quoteSpread / 2 + inventorySkew, this.tick, "ceil");
            const excessUp = Math.max(0, this.qUp - this.qDown);
            const excessDown = Math.max(0, this.qDown - this.qUp);
            const sellUpSize = Math.min(this.cfg.quoteShares, excessUp);
            const sellDownSize = Math.min(this.cfg.quoteShares, excessDown);
            if (sellUpSize > 0) quotes.push({ key: "UP:SELL", leg: "UP", side: "SELL", tokenId: this.tokens.upTokenId, price: askUp, size: sellUpSize });
            if (sellDownSize > 0) quotes.push({ key: "DOWN:SELL", leg: "DOWN", side: "SELL", tokenId: this.tokens.downTokenId, price: askDown, size: sellDownSize });
        }

        logger.info(
            `MM fair: UP=${fairUp.toFixed(4)} DOWN=${fairDown.toFixed(4)} | bidCost=${buyCost.toFixed(4)} | inv UP=${this.qUp.toFixed(4)} DOWN=${this.qDown.toFixed(4)} net=${netInventory.toFixed(4)} | buyCost UP=${this.buyCostUp.toFixed(4)} DOWN=${this.buyCostDown.toFixed(4)}`
        );
        return quotes;
    }

    private buyBudgetSize(leg: Leg, price: number, excludeKey: OrderKey): number {
        if (this.cfg.maxUsdcPerLeg <= 0) return Number.POSITIVE_INFINITY;
        const spent = leg === "UP" ? this.buyCostUp : this.buyCostDown;
        const reserved = this.pendingBuyNotional(leg, excludeKey);
        const available = this.cfg.maxUsdcPerLeg - spent - reserved;
        if (available <= 0) return 0;
        return available / price;
    }

    private pendingBuyNotional(leg: Leg, excludeKey?: OrderKey): number {
        let total = 0;
        for (const [key, order] of this.activeOrders.entries()) {
            if (key === excludeKey || order.leg !== leg || order.side !== "BUY" || isFinalOrderStatus(order.status)) continue;
            total += Math.max(0, order.size - order.filledSize) * order.price;
        }
        return total;
    }

    private async requote(): Promise<void> {
        if (this.stopped || this.requoteInFlight) return;
        this.requoteInFlight = true;
        try {
            const desired = new Map<OrderKey, Quote>(this.buildQuotes().map((quote) => [quote.key, quote]));
            for (const [key, order] of Array.from(this.activeOrders.entries())) {
                const quote = desired.get(key);
                const priceMoved = quote ? Math.abs(order.price - quote.price) >= this.cfg.requoteThreshold : true;
                const sizeMoved = quote ? Math.abs(order.size - quote.size) >= this.tick : true;
                if (!quote || priceMoved || sizeMoved || isFinalOrderStatus(order.status)) {
                    await this.cancelOrder(order, quote ? "requote" : "quote removed");
                    this.activeOrders.delete(key);
                }
            }

            for (const quote of desired.values()) {
                if (!this.activeOrders.has(quote.key)) {
                    const placed = await this.placeOrder(quote);
                    if (placed) this.activeOrders.set(quote.key, placed);
                }
            }
        } finally {
            this.requoteInFlight = false;
        }
    }

    private async placeOrder(quote: Quote): Promise<ActiveOrder | null> {
        const side = quote.side === "BUY" ? Side.BUY : Side.SELL;
        const order: UserOrder = {
            tokenID: quote.tokenId,
            side,
            price: quote.price,
            size: quote.size,
        };

        const notional = quote.price * quote.size;
        if (this.cfg.dryRun) {
            logger.info(`[DRY-RUN] ${quote.side} ${quote.leg} ${quote.size.toFixed(4)} @ ${quote.price.toFixed(4)} (${notional.toFixed(4)} USDC)`);
            return {
                key: quote.key,
                leg: quote.leg,
                side: quote.side,
                orderId: `dry-${quote.key}`,
                tokenId: quote.tokenId,
                price: quote.price,
                size: quote.size,
                filledSize: 0,
                status: "DRY_RUN",
            };
        }

        try {
            const response = await this.client.createAndPostOrder(
                order,
                { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                OrderType.GTC
            );
            const orderId = response?.orderID;
            if (!orderId) {
                logger.error(`${quote.side} ${quote.leg} returned no orderID`);
                return null;
            }
            logger.info(`Posted ${quote.side} ${quote.leg} ${orderId.slice(0, 12)}...: ${quote.size.toFixed(4)} @ ${quote.price.toFixed(4)}`);
            return {
                key: quote.key,
                leg: quote.leg,
                side: quote.side,
                orderId,
                tokenId: quote.tokenId,
                price: quote.price,
                size: quote.size,
                filledSize: 0,
                status: "NEW",
            };
        } catch (error) {
            logger.error(`Failed to post ${quote.side} ${quote.leg}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    private async pollOrders(): Promise<void> {
        if (this.cfg.dryRun || this.activeOrders.size === 0 || this.stopped) return;
        for (const [key, order] of Array.from(this.activeOrders.entries())) {
            if (isFinalOrderStatus(order.status)) continue;
            try {
                await this.refreshOrder(order);
                logger.info(`${order.side} ${order.leg}: status=${order.status}, filled=${order.filledSize.toFixed(4)}/${order.size.toFixed(4)}`);
                if (isFinalOrderStatus(order.status)) this.activeOrders.delete(key);
            } catch (error) {
                logger.error(`Failed to poll ${order.side} ${order.leg} ${order.orderId.slice(0, 12)}...: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const lockedPairs = Math.min(this.qUp, this.qDown);
        const markCost = this.realizedCost;
        logger.info(`Inventory: UP=${this.qUp.toFixed(4)} DOWN=${this.qDown.toFixed(4)} lockedPairs=${lockedPairs.toFixed(4)} netCost=${markCost.toFixed(4)}`);
    }

    private async refreshOrder(order: ActiveOrder): Promise<void> {
        const latest = await this.client.getOrder(order.orderId);
        if (!latest) return;
        order.status = String((latest as any).status || order.status);
        const latestFilledSize = orderFilledSize(latest);
        const fillDelta = Math.max(0, latestFilledSize - order.filledSize);
        if (fillDelta > 0) this.applyFill(order, fillDelta);
        order.filledSize = latestFilledSize;
    }

    private applyFill(order: ActiveOrder, fillDelta: number): void {
        const signedShares = order.side === "BUY" ? fillDelta : -fillDelta;
        const signedCost = order.side === "BUY" ? order.price * fillDelta : -order.price * fillDelta;
        if (order.leg === "UP") this.qUp += signedShares;
        else this.qDown += signedShares;
        if (order.side === "BUY" && order.leg === "UP") this.buyCostUp += order.price * fillDelta;
        if (order.side === "BUY" && order.leg === "DOWN") this.buyCostDown += order.price * fillDelta;
        this.qUp = Math.max(0, this.qUp);
        this.qDown = Math.max(0, this.qDown);
        this.realizedCost += signedCost;
        logger.info(`FILL ${order.side} ${order.leg}: ${fillDelta.toFixed(4)} @ ${order.price.toFixed(4)} | netCost=${this.realizedCost.toFixed(4)}`);
    }

    private async cancelOrder(order: ActiveOrder, reason: string): Promise<void> {
        if (this.cfg.dryRun || isFinalOrderStatus(order.status)) return;
        try {
            await this.refreshOrder(order);
            if (isFinalOrderStatus(order.status)) return;
            await this.client.cancelOrder({ orderID: order.orderId });
            order.status = "CANCELLED";
            logger.info(`Cancelled ${order.side} ${order.leg} ${order.orderId.slice(0, 12)}... (${reason})`);
        } catch (error) {
            logger.error(`Failed to cancel ${order.side} ${order.leg} ${order.orderId.slice(0, 12)}...: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async cancelAllOpenOrders(reason: string): Promise<void> {
        for (const order of Array.from(this.activeOrders.values())) {
            await this.cancelOrder(order, reason);
        }
        this.activeOrders.clear();
    }
}

async function bootstrapLiveClient(cfg: MarketMakerConfig): Promise<ClobClient> {
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

    const requiredBalance = Math.max(config.bot.minUsdcBalance, cfg.maxUsdcPerLeg > 0 ? cfg.maxUsdcPerLeg * 2 : cfg.quoteShares * 2);
    const gate = await waitForMinimumUsdcBalance(client, requiredBalance, {
        pollIntervalMs: 15_000,
        timeoutMs: 0,
        logEveryPoll: true,
    });
    if (!gate.ok) throw new Error(`USDC balance gate failed: required>=${requiredBalance}`);

    return client;
}

async function main(): Promise<void> {
    const cfg = loadMarketMakerConfig();
    setupConsoleFileLogging({
        logFilePath: config.logging.logFilePath,
        logDir: config.logging.logDir,
        filePrefix: config.logging.logFilePrefix,
    });

    const client = await bootstrapLiveClient(cfg);
    const bot = new BtcFiveMinuteMarketMakerBot(client, cfg);

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
