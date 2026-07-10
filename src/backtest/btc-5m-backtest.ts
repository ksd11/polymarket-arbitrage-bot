import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { buildBtc5mEdgeOrders } from "../strategies/btc5m/edge";
import { buildBtc5mMarketMakerQuotes } from "../strategies/btc5m/market-maker";
import { buildBtc5mRangeArbOrders } from "../strategies/btc5m/range-arb";
import { Btc5mStrategyQuote } from "../strategies/btc5m/types";

type Leg = "UP" | "DOWN";
type BacktestStrategy = "edge" | "range-arb" | "market-maker";

type BacktestConfig = {
    strategy: BacktestStrategy;
    csvPath: string;
    outputTradesPath: string;
    intervalMinutes: number;
    volPerInterval: number;
    minEdge: number;
    orderUsdc: number;
    maxUsdcPerLeg: number;
    minSecondsLeft: number;
    maxPrice: number;
    rangePriceX: number;
    rangeUsdcPerLeg: number;
    marketMakerQuoteShares: number;
    marketMakerQuoteSpread: number;
    marketMakerMinLockedEdge: number;
    marketMakerInventorySkewPerShare: number;
    marketMakerMaxUsdcPerLeg: number;
    marketMakerMaxInventoryShares: number;
};

type MarketRow = {
    timestampMs: number;
    slug: string;
    rowType: string;
    btcPrice?: number;
    upAsk: number;
    downAsk: number;
    upBid?: number;
    downBid?: number;
    upMid?: number;
    downMid?: number;
    openPrice?: number;
    winningOutcome?: Leg;
    winningAssetId?: string;
    upTokenId?: string;
    downTokenId?: string;
};

type CycleState = {
    slug: string;
    startMs: number;
    endMs: number;
    openPrice?: number;
    finalPrice?: number;
    winner?: Leg;
    spentUp: number;
    spentDown: number;
    inventoryUp: number;
    inventoryDown: number;
    trades: Trade[];
};

type Trade = {
    slug: string;
    timestampMs: number;
    leg: Leg;
    price: number;
    shares: number;
    cost: number;
    fair?: number;
    edge?: number;
    openPrice?: number;
    btcPrice?: number;
    finalPrice?: number;
    payout?: number;
    pnl?: number;
    note?: string;
};

function getArgValue(name: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
    const withEquals = process.argv.find((arg) => arg.startsWith(`${name}=`));
    return withEquals?.slice(name.length + 1);
}

function hasArg(name: string): boolean {
    return process.argv.includes(name);
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

function usage(): string {
    return [
        "Usage:",
        "  npm run backtest:btc5m -- --strategy <edge|range-arb|market-maker> --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:edge --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:range-arb --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:market-maker --csv <path>",
        "",
        "Required:",
        "  --strategy <name>   Strategy name. Also supports btc5m:edge, btc5m:range-arb, btc5m:market-maker",
        "  --csv <path>        Historical CSV file, e.g. data/btc5m-history.csv",
        "",
        "Optional:",
        "  --out <path>                 Trades output CSV",
        "  --min-edge <number>          Default: BACKTEST_MIN_EDGE or 0.03",
        "  --order-usdc <number>        Default: BACKTEST_ORDER_USDC or 5",
        "  --max-usdc-per-leg <number>  Default: BACKTEST_MAX_USDC_PER_LEG or 10",
    ].join("\n");
}

function parseStrategy(value: string | undefined): BacktestStrategy {
    if (value === "edge" || value === "btc5m:edge") return "edge";
    if (value === "range-arb" || value === "btc5m:range-arb") return "range-arb";
    if (value === "market-maker" || value === "btc5m:market-maker") return "market-maker";
    throw new Error(`Unsupported or missing strategy: ${value || "(empty)"}\n\n${usage()}`);
}

function loadConfig(): BacktestConfig {
    if (hasArg("--help") || hasArg("-h")) {
        console.log(usage());
        process.exit(0);
    }

    const strategyArg = getArgValue("--strategy") ?? envString("BACKTEST_STRATEGY", "");
    const csvPath = getArgValue("--csv") ?? envString("BACKTEST_CSV", "");
    const cfg: BacktestConfig = {
        strategy: parseStrategy(strategyArg),
        csvPath,
        outputTradesPath: getArgValue("--out") ?? envString("BACKTEST_TRADES_OUT", "logs/backtest-btc5m-trades.csv"),
        intervalMinutes: Number(getArgValue("--interval-minutes") ?? envNumber("BACKTEST_INTERVAL_MINUTES", 5)),
        volPerInterval: Number(getArgValue("--vol-per-interval") ?? envNumber("BACKTEST_VOL_PER_INTERVAL", 0.0015)),
        minEdge: Number(getArgValue("--min-edge") ?? envNumber("BACKTEST_MIN_EDGE", 0.03)),
        orderUsdc: Number(getArgValue("--order-usdc") ?? envNumber("BACKTEST_ORDER_USDC", 5)),
        maxUsdcPerLeg: Number(getArgValue("--max-usdc-per-leg") ?? envNumber("BACKTEST_MAX_USDC_PER_LEG", 10)),
        minSecondsLeft: Number(getArgValue("--min-seconds-left") ?? envNumber("BACKTEST_MIN_SECONDS_LEFT", 10)),
        maxPrice: Number(getArgValue("--max-price") ?? envNumber("BACKTEST_MAX_PRICE", 0.98)),
        rangePriceX: Number(getArgValue("--range-price-x") ?? envNumber("RANGE_ARB_PRICE_X", 0.4)),
        rangeUsdcPerLeg: Number(getArgValue("--range-usdc-per-leg") ?? envNumber("RANGE_ARB_USDC_PER_LEG", 5)),
        marketMakerQuoteShares: Number(getArgValue("--mm-quote-shares") ?? envNumber("MM_QUOTE_SHARES", 5)),
        marketMakerQuoteSpread: Number(getArgValue("--mm-quote-spread") ?? envNumber("MM_QUOTE_SPREAD", 0.06)),
        marketMakerMinLockedEdge: Number(getArgValue("--mm-min-locked-edge") ?? envNumber("MM_MIN_LOCKED_EDGE", 0.02)),
        marketMakerInventorySkewPerShare: Number(getArgValue("--mm-inventory-skew-per-share") ?? envNumber("MM_INVENTORY_SKEW_PER_SHARE", 0.002)),
        marketMakerMaxUsdcPerLeg: Number(getArgValue("--mm-max-usdc-per-leg") ?? envNumber("MM_MAX_USDC_PER_LEG", 0)),
        marketMakerMaxInventoryShares: Number(getArgValue("--mm-max-inventory-shares") ?? envNumber("MM_MAX_INVENTORY_SHARES", 30)),
    };

    if (!cfg.csvPath) throw new Error(`Missing --csv <path> or BACKTEST_CSV\n\n${usage()}`);
    if (cfg.intervalMinutes <= 0) throw new Error("BACKTEST_INTERVAL_MINUTES must be > 0");
    if (cfg.volPerInterval <= 0) throw new Error("BACKTEST_VOL_PER_INTERVAL must be > 0");
    if (cfg.minEdge < 0) throw new Error("BACKTEST_MIN_EDGE must be >= 0");
    if (cfg.orderUsdc <= 0) throw new Error("BACKTEST_ORDER_USDC must be > 0");
    if (cfg.maxUsdcPerLeg < 0) throw new Error("BACKTEST_MAX_USDC_PER_LEG must be >= 0");
    if (cfg.minSecondsLeft < 0) throw new Error("BACKTEST_MIN_SECONDS_LEFT must be >= 0");
    if (!(cfg.maxPrice > 0 && cfg.maxPrice <= 1)) throw new Error("BACKTEST_MAX_PRICE must be > 0 and <= 1");
    if (!(cfg.rangePriceX > 0 && cfg.rangePriceX < 1)) throw new Error("RANGE_ARB_PRICE_X must be > 0 and < 1");
    if (cfg.rangeUsdcPerLeg <= 0) throw new Error("RANGE_ARB_USDC_PER_LEG must be > 0");
    if (cfg.marketMakerQuoteShares <= 0) throw new Error("MM_QUOTE_SHARES must be > 0");
    if (!(cfg.marketMakerQuoteSpread > 0 && cfg.marketMakerQuoteSpread < 1)) throw new Error("MM_QUOTE_SPREAD must be > 0 and < 1");
    if (cfg.marketMakerMinLockedEdge < 0) throw new Error("MM_MIN_LOCKED_EDGE must be >= 0");
    if (cfg.marketMakerInventorySkewPerShare < 0) throw new Error("MM_INVENTORY_SKEW_PER_SHARE must be >= 0");
    if (cfg.marketMakerMaxUsdcPerLeg < 0) throw new Error("MM_MAX_USDC_PER_LEG must be >= 0");
    if (cfg.marketMakerMaxInventoryShares < cfg.marketMakerQuoteShares) throw new Error("MM_MAX_INVENTORY_SHARES must be >= MM_QUOTE_SHARES");
    return cfg;
}

function parseCsv(text: string): Record<string, string>[] {
    const rows: string[][] = [];
    let field = "";
    let row: string[] = [];
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const next = text[i + 1];
        if (quoted) {
            if (char === "\"" && next === "\"") {
                field += "\"";
                i++;
            } else if (char === "\"") {
                quoted = false;
            } else {
                field += char;
            }
        } else if (char === "\"") {
            quoted = true;
        } else if (char === ",") {
            row.push(field);
            field = "";
        } else if (char === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else if (char !== "\r") {
            field += char;
        }
    }

    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    if (rows.length === 0) return [];

    const headers = rows[0].map((header) => normalizeHeader(header));
    return rows.slice(1)
        .filter((values) => values.some((value) => value.trim().length > 0))
        .map((values) => Object.fromEntries(headers.map((header, idx) => [header, values[idx]?.trim() ?? ""])));
}

function normalizeHeader(header: string): string {
    return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function pick(row: Record<string, string>, names: string[]): string | undefined {
    for (const name of names) {
        const value = row[normalizeHeader(name)];
        if (value !== undefined && value !== "") return value;
    }
    return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function parseTimestamp(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
        return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function toMarketRows(records: Record<string, string>[], intervalMinutes: number): MarketRow[] {
    const intervalMs = intervalMinutes * 60_000;
    return records.map((record, idx) => {
        const timestampMs = parseTimestamp(pick(record, ["timestamp", "time", "ts", "datetime", "date"]));
        const btcPrice = parseNumber(pick(record, ["btc_price", "btc", "index_price", "underlying_price", "price"]));
        const upAsk = parseNumber(pick(record, ["up_ask", "ask_up", "upask", "yes_ask"]));
        const downAsk = parseNumber(pick(record, ["down_ask", "ask_down", "downask", "no_ask"]));
        if (timestampMs === undefined || upAsk === undefined || downAsk === undefined) {
            throw new Error(`CSV row ${idx + 2} missing required timestamp/upAsk/downAsk`);
        }
        const startMs = Math.floor(timestampMs / intervalMs) * intervalMs;
        const upTokenId = pick(record, ["up_token_id", "up_token", "yes_token_id"]);
        const downTokenId = pick(record, ["down_token_id", "down_token", "no_token_id"]);
        return {
            timestampMs,
            rowType: pick(record, ["row_type", "type"]) ?? "sample",
            slug: pick(record, ["slug", "market", "market_slug"]) ?? `cycle-${Math.floor(startMs / 1000)}`,
            btcPrice,
            upAsk,
            downAsk,
            upBid: parseNumber(pick(record, ["up_bid", "bid_up", "upbid", "yes_bid"])),
            downBid: parseNumber(pick(record, ["down_bid", "bid_down", "downbid", "no_bid"])),
            upMid: parseNumber(pick(record, ["up_mid", "mid_up", "upmid", "yes_mid"])),
            downMid: parseNumber(pick(record, ["down_mid", "mid_down", "downmid", "no_mid"])),
            openPrice: parseNumber(pick(record, ["open_price", "cycle_open", "start_price"])),
            winningOutcome: parseWinningOutcome(pick(record, ["winning_outcome", "winner", "outcome"])),
            winningAssetId: pick(record, ["winning_asset_id", "winning_token_id"]),
            upTokenId,
            downTokenId,
        };
    }).sort((a, b) => a.timestampMs - b.timestampMs);
}

function parseWinningOutcome(value: string | undefined): Leg | undefined {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === "up" || normalized === "yes") return "UP";
    if (normalized === "down" || normalized === "no") return "DOWN";
    return undefined;
}

function runBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const intervalMs = cfg.intervalMinutes * 60_000;
    const cycles = new Map<string, CycleState>();

    for (const row of rows) {
        const startMs = Math.floor(row.timestampMs / intervalMs) * intervalMs;
        const cycle = cycles.get(row.slug) ?? {
            slug: row.slug,
            startMs,
            endMs: startMs + intervalMs,
            openPrice: row.openPrice ?? row.btcPrice,
            finalPrice: row.btcPrice,
            spentUp: 0,
            spentDown: 0,
            inventoryUp: 0,
            inventoryDown: 0,
            trades: [],
        };
        if (!cycles.has(row.slug)) cycles.set(row.slug, cycle);
        if (row.btcPrice !== undefined) cycle.finalPrice = row.btcPrice;
        updateWinner(cycle, row);

        const secondsLeft = (cycle.endMs - row.timestampMs) / 1000;
        if (secondsLeft < cfg.minSecondsLeft) continue;

        const decision = buildBtc5mEdgeOrders({
            timestampMs: row.timestampMs,
            endMs: cycle.endMs,
            btcPrice: row.btcPrice,
            openPrice: cycle.openPrice,
            upAsk: row.upAsk,
            downAsk: row.downAsk,
            spentUp: cycle.spentUp,
            spentDown: cycle.spentDown,
            params: {
                intervalMinutes: cfg.intervalMinutes,
                volPerInterval: cfg.volPerInterval,
                minEdge: cfg.minEdge,
                orderUsdc: cfg.orderUsdc,
                maxUsdcPerLeg: cfg.maxUsdcPerLeg,
                maxPrice: cfg.maxPrice,
            },
        });
        applyBuyQuotes(cycle, row, decision.quotes, "edge");
    }

    settleCycles(cycles);

    const cycleList = Array.from(cycles.values()).sort((a, b) => a.startMs - b.startMs);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function updateWinner(cycle: CycleState, row: MarketRow): void {
    if (row.winningOutcome) {
        cycle.winner = row.winningOutcome;
        return;
    }
    if (row.winningAssetId && row.upTokenId && row.winningAssetId === row.upTokenId) {
        cycle.winner = "UP";
        return;
    }
    if (row.winningAssetId && row.downTokenId && row.winningAssetId === row.downTokenId) {
        cycle.winner = "DOWN";
    }
}

function inferWinner(cycle: CycleState): Leg | undefined {
    if (cycle.winner) return cycle.winner;
    if (cycle.openPrice !== undefined && cycle.finalPrice !== undefined) {
        return cycle.finalPrice > cycle.openPrice ? "UP" : "DOWN";
    }
    return undefined;
}

function settleCycles(cycles: Map<string, CycleState>): void {
    for (const cycle of cycles.values()) {
        const winner = inferWinner(cycle);
        for (const trade of cycle.trades) {
            const wins = winner !== undefined && trade.leg === winner;
            trade.finalPrice = cycle.finalPrice;
            trade.payout = wins ? trade.shares : 0;
            trade.pnl = trade.payout - trade.cost;
        }
    }
}

function runRangeArbBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;
        const secondsLeft = (cycle.endMs - row.timestampMs) / 1000;
        if (secondsLeft < cfg.minSecondsLeft) continue;

        const decision = buildBtc5mRangeArbOrders({
            upAsk: row.upAsk,
            downAsk: row.downAsk,
            hasUpPosition: cycle.spentUp > 0,
            hasDownPosition: cycle.spentDown > 0,
            params: { priceX: cfg.rangePriceX, usdcPerLeg: cfg.rangeUsdcPerLeg },
        });
        applyBuyQuotes(cycle, row, decision.quotes, "range-arb fixed limit");
    }
    settleCycles(cycles);
    const cycleList = Array.from(cycles.values()).sort((a, b) => a.startMs - b.startMs);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function runMarketMakerBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;
        const secondsLeft = (cycle.endMs - row.timestampMs) / 1000;
        if (secondsLeft < cfg.minSecondsLeft) continue;

        const decision = buildBtc5mMarketMakerQuotes({
            up: { bestBid: row.upBid, bestAsk: row.upAsk, mid: row.upMid },
            down: { bestBid: row.downBid, bestAsk: row.downAsk, mid: row.downMid },
            secondsLeft,
            params: {
                quoteShares: cfg.marketMakerQuoteShares,
                maxUsdcPerLeg: cfg.marketMakerMaxUsdcPerLeg,
                maxInventoryShares: cfg.marketMakerMaxInventoryShares,
                quoteSpread: cfg.marketMakerQuoteSpread,
                minLockedEdge: cfg.marketMakerMinLockedEdge,
                inventorySkewPerShare: cfg.marketMakerInventorySkewPerShare,
                enableSellExcess: false,
                minSecondsLeftToQuote: cfg.minSecondsLeft,
                tick: 0.01,
            },
            state: {
                qUp: cycle.inventoryUp,
                qDown: cycle.inventoryDown,
                buyCostUp: cycle.spentUp,
                buyCostDown: cycle.spentDown,
            },
        });
        for (const quote of decision.quotes.filter((quote) => quote.side === "BUY")) {
            const ask = quote.leg === "UP" ? row.upAsk : row.downAsk;
            if (ask <= quote.price) applyBuyQuotes(cycle, row, [quote], "market-maker simulated bid fill");
        }
    }
    settleCycles(cycles);
    const cycleList = Array.from(cycles.values()).sort((a, b) => a.startMs - b.startMs);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function createCycleMap(rows: MarketRow[], cfg: BacktestConfig): Map<string, CycleState> {
    const intervalMs = cfg.intervalMinutes * 60_000;
    const cycles = new Map<string, CycleState>();
    for (const row of rows) {
        const startMs = Math.floor(row.timestampMs / intervalMs) * intervalMs;
        const cycle = cycles.get(row.slug) ?? {
            slug: row.slug,
            startMs,
            endMs: startMs + intervalMs,
            openPrice: row.openPrice ?? row.btcPrice,
            finalPrice: row.btcPrice,
            spentUp: 0,
            spentDown: 0,
            inventoryUp: 0,
            inventoryDown: 0,
            trades: [],
        };
        if (row.btcPrice !== undefined) cycle.finalPrice = row.btcPrice;
        updateWinner(cycle, row);
        cycles.set(row.slug, cycle);
    }
    return cycles;
}

function buyAtPrice(cycle: CycleState, row: MarketRow, leg: Leg, price: number, cost: number, fair?: number, edge?: number, note?: string): void {
    const shares = cost / price;
    cycle.trades.push({
        slug: cycle.slug,
        timestampMs: row.timestampMs,
        leg,
        price,
        shares,
        cost,
        fair,
        edge,
        openPrice: cycle.openPrice,
        btcPrice: row.btcPrice,
        note,
    });
    if (leg === "UP") {
        cycle.spentUp += cost;
        cycle.inventoryUp += shares;
    } else {
        cycle.spentDown += cost;
        cycle.inventoryDown += shares;
    }
}

function applyBuyQuotes(cycle: CycleState, row: MarketRow, quotes: Btc5mStrategyQuote[], note: string): void {
    for (const quote of quotes) {
        if (quote.side !== "BUY") continue;
        buyAtPrice(cycle, row, quote.leg, quote.price, quote.price * quote.size, quote.fair, quote.edge, note);
    }
}

function tradeCsv(trades: Trade[]): string {
    const header = ["timestamp", "slug", "leg", "price", "shares", "cost", "fair", "edge", "openPrice", "btcPrice", "finalPrice", "payout", "pnl", "note"];
    const lines = trades.map((trade) => [
        new Date(trade.timestampMs).toISOString(),
        trade.slug,
        trade.leg,
        trade.price.toFixed(6),
        trade.shares.toFixed(6),
        trade.cost.toFixed(6),
        formatOptional(trade.fair, 6),
        formatOptional(trade.edge, 6),
        formatOptional(trade.openPrice, 2),
        formatOptional(trade.btcPrice, 2),
        formatOptional(trade.finalPrice, 2),
        (trade.payout ?? 0).toFixed(6),
        (trade.pnl ?? 0).toFixed(6),
        trade.note ?? "",
    ].join(","));
    return `${header.join(",")}\n${lines.join("\n")}\n`;
}

function formatOptional(value: number | undefined, decimals: number): string {
    return value === undefined ? "" : value.toFixed(decimals);
}

function printSummary(cycles: CycleState[], trades: Trade[], cfg: BacktestConfig): void {
    const totalCost = trades.reduce((sum, trade) => sum + trade.cost, 0);
    const totalPayout = trades.reduce((sum, trade) => sum + (trade.payout ?? 0), 0);
    const totalPnl = totalPayout - totalCost;
    const winners = trades.filter((trade) => (trade.pnl ?? 0) > 0).length;
    const tradedCycles = cycles.filter((cycle) => cycle.trades.length > 0).length;
    const roi = totalCost > 0 ? totalPnl / totalCost : 0;

    console.log("=== BTC 5m Backtest ===");
    console.log(`Strategy: ${cfg.strategy}`);
    console.log(`CSV: ${cfg.csvPath}`);
    console.log(`Cycles: ${cycles.length}, traded cycles: ${tradedCycles}`);
    console.log(`Trades: ${trades.length}, winners: ${winners}, win rate: ${trades.length ? (winners / trades.length * 100).toFixed(2) : "0.00"}%`);
    console.log(`Cost: ${totalCost.toFixed(4)}, payout: ${totalPayout.toFixed(4)}, PnL: ${totalPnl.toFixed(4)}, ROI: ${(roi * 100).toFixed(2)}%`);
    console.log(`Params: minEdge=${cfg.minEdge}, orderUsdc=${cfg.orderUsdc}, maxUsdcPerLeg=${cfg.maxUsdcPerLeg}, volPerInterval=${cfg.volPerInterval}`);
    console.log(`Trades CSV: ${cfg.outputTradesPath}`);
}

function main(): void {
    const cfg = loadConfig();
    const csvPath = resolve(cfg.csvPath);
    if (!existsSync(csvPath)) throw new Error(`CSV file not found: ${csvPath}`);

    const records = parseCsv(readFileSync(csvPath, "utf-8"));
    const { cycles, trades } = runStrategy(cfg, records);

    const outPath = resolve(cfg.outputTradesPath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, tradeCsv(trades));
    printSummary(cycles, trades, cfg);
}

function runStrategy(cfg: BacktestConfig, records: Record<string, string>[]): { cycles: CycleState[]; trades: Trade[] } {
    const rows = toMarketRows(records, cfg.intervalMinutes);
    switch (cfg.strategy) {
        case "edge": {
            return runBacktest(rows, cfg);
        }
        case "range-arb":
            return runRangeArbBacktest(rows, cfg);
        case "market-maker":
            return runMarketMakerBacktest(rows, cfg);
        default:
            throw new Error(`Unsupported strategy: ${cfg.strategy}`);
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
