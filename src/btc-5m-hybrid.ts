// Setup global fetch proxy FIRST (before any other imports that might call fetch)
import "./setup-proxy";

// Patch Exchange protocol version to V2 (npm package still ships V1)
import "./patch-exchange-v2";

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
import { buildBtc5mHybridOrders, MarketRegime, PriceSnapshot } from "./strategies/btc5m/hybrid";
import { Btc5mStrategyQuote } from "./strategies/btc5m/types";

type HybridConfig = {
    dryRun: boolean;
    market: string;
    intervalMinutes: number;
    tickSize: CreateOrderOptions["tickSize"];
    negRisk: boolean;
    // Edge params
    volPerInterval: number;
    minEdge: number;
    minMoveBps: number;
    minElapsedSeconds: number;
    orderUsdc: number;
    maxUsdcPerLeg: number;
    maxPrice: number;
    minSecondsLeftToTrade: number;
    cancelSecondsBeforeEnd: number;
    // Range-Arb params
    rangePriceX: number;
    rangeUsdcPerLeg: number;
    // Hybrid regime detection
    lookbackSeconds: number;
    oscillationThreshold: number;
    rangeThreshold: number;
    trendThreshold: number;
    // BTC price
    btcPriceRefreshMs: number;
    btcPriceMaxStaleMs: number;
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

function loadHybridConfig(): HybridConfig {
    const cfg: HybridConfig = {
        dryRun: envBool("HYBRID_DRY_RUN", true),
        market: envString("HYBRID_MARKET", "btc").toLowerCase(),
        intervalMinutes: envNumber("HYBRID_INTERVAL_MINUTES", 5),
        tickSize: envString("HYBRID_TICK_SIZE", "0.01") as CreateOrderOptions["tickSize"],
        negRisk: envBool("HYBRID_NEG_RISK", config.copytrade.negRisk),
        // Edge params
        volPerInterval: envNumber("HYBRID_VOL_PER_INTERVAL", 0.0006),
        minEdge: envNumber("HYBRID_MIN_EDGE", 0.10),
        minMoveBps: envNumber("HYBRID_EDGE_MIN_MOVE_BPS", 0),
        minElapsedSeconds: envNumber("HYBRID_EDGE_MIN_ELAPSED_SECONDS", 0),
        orderUsdc: envNumber("HYBRID_ORDER_USDC", 5),
        maxUsdcPerLeg: envNumber("HYBRID_MAX_USDC_PER_LEG", 10),
        maxPrice: envNumber("HYBRID_MAX_PRICE", 0.85),
        minSecondsLeftToTrade: envNumber("HYBRID_MIN_SECONDS_LEFT_TO_TRADE", 30),
        cancelSecondsBeforeEnd: envNumber("HYBRID_CANCEL_SECONDS_BEFORE_END", 5),
        // Range-Arb params
        rangePriceX: envNumber("HYBRID_RANGE_PRICE_X", 0.35),
        rangeUsdcPerLeg: envNumber("HYBRID_RANGE_USDC_PER_LEG", 5),
        // Hybrid regime detection
        lookbackSeconds: envNumber("HYBRID_LOOKBACK_SECONDS", 60),
        oscillationThreshold: envNumber("HYBRID_OSC_THRESHOLD", 2),
        rangeThreshold: envNumber("HYBRID_RANGE_THRESHOLD", 0.25),
        trendThreshold: envNumber("HYBRID_TREND_THRESHOLD", 0.10),
        // BTC price
        btcPriceRefreshMs: envNumber("HYBRID_BTC_PRICE_REFRESH_MS", 1000),
        btcPriceMaxStaleMs: envNumber("HYBRID_BTC_PRICE_MAX_STALE_MS", 10000),
    };

    if (cfg.intervalMinutes <= 0) throw new Error("HYBRID_INTERVAL_MINUTES must be > 0");
    if (!(cfg.volPerInterval > 0)) throw new Error("HYBRID_VOL_PER_INTERVAL must be > 0");
    if (cfg.minEdge < 0) throw new Error("HYBRID_MIN_EDGE must be >= 0");
    if (cfg.minMoveBps < 0) throw new Error("HYBRID_EDGE_MIN_MOVE_BPS must be >= 0");
    if (cfg.minElapsedSeconds < 0) throw new Error("HYBRID_EDGE_MIN_ELAPSED_SECONDS must be >= 0");
    if (cfg.orderUsdc <= 0) throw new Error("HYBRID_ORDER_USDC must be > 0");
    if (!(cfg.rangePriceX > 0 && cfg.rangePriceX < 0.5)) throw new Error("HYBRID_RANGE_PRICE_X must be > 0 and < 0.5");
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

class BtcFiveMinuteHybridBot {
    private ws: WebSocketOrderBook | null = null;
    private btcProvider: BtcPriceProvider;
    private tokens: MarketTokens | null = null;
    private orders: PlacedOrder[] = [];
    private priceHistory: PriceSnapshot[] = [];
    private openPrice: number | undefined;
    private spentUp = 0;
    private spentDown = 0;
    private hasUpPosition = false;
    private hasDownPosition = false;
    private timers: NodeJS.Timeout[] = [];
    private stopped = false;
    private currentRegime: MarketRegime = "unknown";

    constructor(private client: ClobClient, private cfg: HybridConfig) {
        this.btcProvider = new BtcPriceProvider({
            ...defaultBtcPriceConfig(),
            refreshIntervalMs: cfg.btcPriceRefreshMs,
            maxStalenessMs: cfg.btcPriceMaxStaleMs,
        });
    }

    async start(): Promise<void> {
        logger.info(`Starting BTC 5m HYBRID bot: market=${this.cfg.market}, dryRun=${this.cfg.dryRun}`);
        logger.info(`Edge params: vol=${this.cfg.volPerInterval}, minEdge=${this.cfg.minEdge}, orderUsdc=${this.cfg.orderUsdc}, maxUsdcPerLeg=${this.cfg.maxUsdcPerLeg}`);
        logger.info(`RangeArb params: priceX=${this.cfg.rangePriceX}, usdcPerLeg=${this.cfg.rangeUsdcPerLeg}`);
        logger.info(`Regime detection: lookback=${this.cfg.lookbackSeconds}s, oscThreshold=${this.cfg.oscillationThreshold}, rangeThreshold=${this.cfg.rangeThreshold}, trendThreshold=${this.cfg.trendThreshold}`);

        await this.btcProvider.start();
        this.ws = new WebSocketOrderBook("market", [], null);
        await this.ws.connect();
        await this.initializeCurrentCycle();

        this.timers.push(setInterval(() => void this.handleCycleTick(), 5_000));
        this.timers.push(setInterval(() => void this.pollOrders(), 2_000));
    }

    async stop(): Promise<void> {
        this.stopped = true;
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        this.btcProvider.stop();
        await this.cancelOpenOrders("shutdown");
        if (this.ws) this.ws.disconnect();
        logger.info("BTC 5m hybrid bot stopped");
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
            await this.cancelOpenOrders(`cycle ending in ${secondsLeft.toFixed(1)}s`);
        }
    }

    private resetCycleState(): void {
        this.tokens = null;
        this.orders = [];
        this.priceHistory = [];
        this.openPrice = undefined;
        this.spentUp = 0;
        this.spentDown = 0;
        this.hasUpPosition = false;
        this.hasDownPosition = false;
        this.currentRegime = "unknown";
    }

    private async initializeCurrentCycle(): Promise<void> {
        const cycle = slugForCycle(this.cfg.market, this.cfg.intervalMinutes);
        try {
            const tokens = await fetchTokenIdsForSlug(cycle.slug, cycle.startMs, cycle.endMs);
            this.tokens = tokens;
            logger.info(`Cycle ready: ${tokens.slug}`);

            if (!this.ws) throw new Error("WebSocket is not initialized");
            this.ws.subscribeToTokenIds([tokens.upTokenId, tokens.downTokenId]);
            this.ws.setTokenLabel(tokens.upTokenId, "Up");
            this.ws.setTokenLabel(tokens.downTokenId, "Down");
            this.ws.setTokenPair(tokens.upTokenId, tokens.downTokenId);
            this.ws.onPriceUpdate(tokens.upTokenId, () => void this.onPriceUpdate());
            this.ws.onPriceUpdate(tokens.downTokenId, () => void this.onPriceUpdate());

            // Capture open price from BTC
            const btcPrice = this.btcProvider.getPrice();
            if (btcPrice) this.openPrice = btcPrice;
        } catch (error) {
            logger.error(`Failed to initialize cycle: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private onPriceUpdate(): void {
        if (!this.tokens || !this.ws || this.stopped) return;
        const up = this.ws.getPrice(this.tokens.upTokenId);
        if (up?.bestAsk && Number.isFinite(up.bestAsk)) {
            this.priceHistory.push({ t: Date.now(), upAsk: up.bestAsk });
            // Trim to lookback window
            const cutoff = Date.now() - this.cfg.lookbackSeconds * 1000;
            this.priceHistory = this.priceHistory.filter((p) => p.t >= cutoff);
        }
        void this.maybeExecuteStrategy();
    }

    private async maybeExecuteStrategy(): Promise<void> {
        if (!this.tokens || this.stopped) return;
        const now = Date.now();
        const secondsLeft = (this.tokens.endMs - now) / 1000;
        if (secondsLeft < this.cfg.minSecondsLeftToTrade) return;

        if (!this.ws) return;
        const upPrice = this.ws.getPrice(this.tokens.upTokenId);
        const downPrice = this.ws.getPrice(this.tokens.downTokenId);
        if (!upPrice?.bestAsk || !downPrice?.bestAsk) return;

        const btcPrice = this.btcProvider.getPrice() ?? undefined;
        if (!this.openPrice && btcPrice) this.openPrice = btcPrice;

        const decision = buildBtc5mHybridOrders({
            timestampMs: now,
            endMs: this.tokens.endMs,
            btcPrice,
            openPrice: this.openPrice,
            upAsk: upPrice.bestAsk,
            downAsk: downPrice.bestAsk,
            spentUp: this.spentUp,
            spentDown: this.spentDown,
            hasUpPosition: this.hasUpPosition,
            hasDownPosition: this.hasDownPosition,
            params: {
                lookbackSeconds: this.cfg.lookbackSeconds,
                oscillationThreshold: this.cfg.oscillationThreshold,
                rangeThreshold: this.cfg.rangeThreshold,
                trendThreshold: this.cfg.trendThreshold,
                edge: {
                    intervalMinutes: this.cfg.intervalMinutes,
                    volPerInterval: this.cfg.volPerInterval,
                    minEdge: this.cfg.minEdge,
                    minMoveBps: this.cfg.minMoveBps,
                    minElapsedSeconds: this.cfg.minElapsedSeconds,
                    orderUsdc: this.cfg.orderUsdc,
                    maxUsdcPerLeg: this.cfg.maxUsdcPerLeg,
                    maxPrice: this.cfg.maxPrice,
                },
                rangeArb: {
                    priceX: this.cfg.rangePriceX,
                    usdcPerLeg: this.cfg.rangeUsdcPerLeg,
                },
            },
            priceHistory: this.priceHistory,
        });

        // Log regime changes
        if (decision.regime !== this.currentRegime) {
            logger.info(`Regime changed: ${this.currentRegime} → ${decision.regime} (${decision.reason})`);
            this.currentRegime = decision.regime;
        }

        // Execute quotes
        for (const quote of decision.quotes) {
            if (quote.side === "BUY") {
                await this.executeBuy(quote);
            }
        }
    }

    private async executeBuy(quote: Btc5mStrategyQuote): Promise<void> {
        if (!this.tokens) return;
        const tokenId = quote.leg === "UP" ? this.tokens.upTokenId : this.tokens.downTokenId;
        const cost = quote.price * quote.size;

        if (this.cfg.dryRun) {
            logger.info(`[DRY-RUN][${this.currentRegime}] BUY ${quote.leg} ${quote.size.toFixed(4)} @ ${quote.price.toFixed(4)} (${cost.toFixed(4)} USDC) edge=${quote.edge?.toFixed(4) ?? "n/a"}`);
            // Track positions even in dry-run for accurate state
            if (quote.leg === "UP") {
                this.spentUp += cost;
                this.hasUpPosition = true;
            } else {
                this.spentDown += cost;
                this.hasDownPosition = true;
            }
            return;
        }

        try {
            const order: UserOrder = {
                tokenID: tokenId,
                side: Side.BUY,
                price: quote.price,
                size: quote.size,
            };
            const response = await this.client.createAndPostOrder(
                order,
                { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk },
                OrderType.GTC
            );
            const orderId = response?.orderID;
            if (!orderId) {
                logger.error(`Order for ${quote.leg} returned no orderID`);
                return;
            }
            logger.info(`[${this.currentRegime}] Posted ${quote.leg} order ${orderId.slice(0, 12)}...: ${quote.size.toFixed(4)} @ ${quote.price.toFixed(4)}`);
            this.orders.push({ leg: quote.leg, orderId, tokenId, price: quote.price, size: quote.size, filledSize: 0, status: "NEW" });
            if (quote.leg === "UP") {
                this.spentUp += cost;
                this.hasUpPosition = true;
            } else {
                this.spentDown += cost;
                this.hasDownPosition = true;
            }
        } catch (error) {
            logger.error(`Failed to post ${quote.leg} order: ${error instanceof Error ? error.message : String(error)}`);
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
            } catch (error) {
                logger.error(`Failed to poll ${order.leg} order: ${error instanceof Error ? error.message : String(error)}`);
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
            } catch (error) {
                logger.error(`Failed to cancel ${order.leg} order: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}

async function bootstrapLiveClient(cfg: HybridConfig): Promise<ClobClient> {
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
    const cfg = loadHybridConfig();
    setupConsoleFileLogging({
        logFilePath: config.logging.logFilePath,
        logDir: config.logging.logDir,
        filePrefix: config.logging.logFilePrefix,
    });

    const client = await bootstrapLiveClient(cfg);
    const bot = new BtcFiveMinuteHybridBot(client, cfg);

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
