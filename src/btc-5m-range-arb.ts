// Setup global fetch proxy FIRST (before any other imports that might call fetch)
import "./setup-proxy";

// Patch Exchange protocol version to V2 (npm package still ships V1)
import "./patch-exchange-v2";

import { ClobClient, CreateOrderOptions, OrderType, Side, UserOrderV2 as UserOrder } from "@polymarket/clob-client-v2";
import { config } from "./config";
import { getClobClient } from "./providers/clobclient";
import { WebSocketOrderBook, TokenPrice } from "./providers/websocketOrderbook";
import { validatePrivateKey } from "./security/validatePrivateKey";
import { createCredential } from "./security/createCredential";
import { approveUSDCAllowance, updateClobBalanceAllowance } from "./security/allowance";
import { waitForMinimumUsdcBalance } from "./utils/balance";
import { logger } from "./utils/logger";
import { setupConsoleFileLogging } from "./utils/console-file";

type ArbConfig = {
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

type PricePoint = {
    t: number;
    upAsk: number;
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

function loadArbConfig(): ArbConfig {
    const cfg: ArbConfig = {
        dryRun: envBool("RANGE_ARB_DRY_RUN", true),
        market: envString("RANGE_ARB_MARKET", envString("BTC5M_MARKET", "btc")).toLowerCase(),
        intervalMinutes: envNumber("RANGE_ARB_INTERVAL_MINUTES", envNumber("BTC5M_INTERVAL_MINUTES", 5)),
        priceX: envNumber("RANGE_ARB_PRICE_X", 0.4),
        usdcPerLeg: envNumber("RANGE_ARB_USDC_PER_LEG", 5),
        tickSize: envString("RANGE_ARB_TICK_SIZE", envString("BTC5M_TICK_SIZE", "0.01")) as CreateOrderOptions["tickSize"],
        negRisk: envBool("RANGE_ARB_NEG_RISK", envBool("BTC5M_NEG_RISK", config.copytrade.negRisk)),
        minSecondsLeftToOpen: envNumber("RANGE_ARB_MIN_SECONDS_LEFT_TO_OPEN", 60),
        cancelSecondsBeforeEnd: envNumber("RANGE_ARB_CANCEL_SECONDS_BEFORE_END", envNumber("BTC5M_CANCEL_SECONDS_BEFORE_END", 8)),
        requireAmplitude: envBool("RANGE_ARB_REQUIRE_AMPLITUDE", false),
        amplitudeLookbackSeconds: envNumber("RANGE_ARB_AMPLITUDE_LOOKBACK_SECONDS", 120),
        amplitudeBuffer: envNumber("RANGE_ARB_AMPLITUDE_BUFFER", 0.03),
    };

    if (cfg.intervalMinutes <= 0) throw new Error("RANGE_ARB_INTERVAL_MINUTES must be > 0");
    if (!(cfg.priceX > 0 && cfg.priceX < 0.5)) throw new Error("RANGE_ARB_PRICE_X must be > 0 and < 0.5");
    if (!(cfg.usdcPerLeg > 0)) throw new Error("RANGE_ARB_USDC_PER_LEG must be > 0");
    if (cfg.minSecondsLeftToOpen < 0) throw new Error("RANGE_ARB_MIN_SECONDS_LEFT_TO_OPEN must be >= 0");
    if (cfg.cancelSecondsBeforeEnd < 0) throw new Error("RANGE_ARB_CANCEL_SECONDS_BEFORE_END must be >= 0");
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

class BtcFiveMinuteRangeArbBot {
    private ws: WebSocketOrderBook | null = null;
    private tokens: MarketTokens | null = null;
    private placed = false;
    private orders: PlacedOrder[] = [];
    private priceHistory: PricePoint[] = [];
    private timers: NodeJS.Timeout[] = [];
    private stopped = false;

    constructor(private client: ClobClient, private cfg: ArbConfig) {}

    async start(): Promise<void> {
        logger.info(`Starting BTC 5m range arb: market=${this.cfg.market}, x=${this.cfg.priceX}, y=${this.cfg.usdcPerLeg}, dryRun=${this.cfg.dryRun}`);
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
            await this.cancelOpenOrders(`cycle ending in ${secondsLeft.toFixed(1)}s`);
        }
    }

    private resetCycleState(): void {
        this.tokens = null;
        this.placed = false;
        this.orders = [];
        this.priceHistory = [];
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
        void this.maybePlaceCycleOrders();
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

        const size = this.cfg.usdcPerLeg / this.cfg.priceX;
        const lockedProfit = size - 2 * this.cfg.usdcPerLeg;
        logger.info(`Placing pair orders for ${this.tokens.slug}: BUY UP ${size.toFixed(4)} @ ${this.cfg.priceX}, BUY DOWN ${size.toFixed(4)} @ ${this.cfg.priceX}`);
        logger.info(`If both legs fill: cost=${(2 * this.cfg.usdcPerLeg).toFixed(4)} USDC, payout=${size.toFixed(4)} USDC, profit=${lockedProfit.toFixed(4)} USDC`);

        this.placed = true;
        const upOrder = await this.placeBuy("UP", this.tokens.upTokenId, size);
        const downOrder = await this.placeBuy("DOWN", this.tokens.downTokenId, size);
        this.orders = [upOrder, downOrder].filter(Boolean) as PlacedOrder[];
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
                OrderType.GTC
            );
            const orderId = response?.orderID;
            if (!orderId) {
                logger.error(`Order for ${leg} returned no orderID`);
                return null;
            }
            logger.info(`Posted ${leg} order ${orderId.slice(0, 12)}...: ${size.toFixed(4)} @ ${this.cfg.priceX.toFixed(4)}`);
            return { leg, orderId, tokenId, price: this.cfg.priceX, size, filledSize: 0, status: "NEW" };
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
                order.filledSize = orderFilledSize(latest);
                logger.info(`Order ${order.leg}: status=${order.status}, filled=${order.filledSize.toFixed(4)}/${order.size.toFixed(4)}`);
            } catch (error) {
                logger.error(`Failed to poll ${order.leg} order ${order.orderId.slice(0, 12)}...: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        const up = this.orders.find((o) => o.leg === "UP");
        const down = this.orders.find((o) => o.leg === "DOWN");
        if (up && down && up.filledSize >= up.size && down.filledSize >= down.size) {
            const payout = Math.min(up.filledSize, down.filledSize);
            const cost = up.filledSize * up.price + down.filledSize * down.price;
            logger.info(`PAIR LOCKED: payout=${payout.toFixed(4)}, cost=${cost.toFixed(4)}, expectedProfit=${(payout - cost).toFixed(4)} USDC`);
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
                logger.error(`Failed to cancel ${order.leg} order ${order.orderId.slice(0, 12)}...: ${error instanceof Error ? error.message : String(error)}`);
            }
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
