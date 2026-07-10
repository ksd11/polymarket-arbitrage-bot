import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

type Leg = "UP" | "DOWN";

type BacktestConfig = {
    csvPath: string;
    outputTradesPath: string;
    intervalMinutes: number;
    volPerInterval: number;
    minEdge: number;
    orderUsdc: number;
    maxUsdcPerLeg: number;
    minSecondsLeft: number;
    maxPrice: number;
};

type MarketRow = {
    timestampMs: number;
    slug: string;
    btcPrice: number;
    upAsk: number;
    downAsk: number;
    openPrice?: number;
};

type CycleState = {
    slug: string;
    startMs: number;
    endMs: number;
    openPrice: number;
    finalPrice: number;
    spentUp: number;
    spentDown: number;
    trades: Trade[];
};

type Trade = {
    slug: string;
    timestampMs: number;
    leg: Leg;
    price: number;
    shares: number;
    cost: number;
    fair: number;
    edge: number;
    openPrice: number;
    btcPrice: number;
    finalPrice?: number;
    payout?: number;
    pnl?: number;
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

function loadConfig(): BacktestConfig {
    const csvPath = getArgValue("--csv") ?? envString("BACKTEST_CSV", "");
    const cfg: BacktestConfig = {
        csvPath,
        outputTradesPath: getArgValue("--out") ?? envString("BACKTEST_TRADES_OUT", "logs/backtest-btc5m-trades.csv"),
        intervalMinutes: Number(getArgValue("--interval-minutes") ?? envNumber("BACKTEST_INTERVAL_MINUTES", 5)),
        volPerInterval: Number(getArgValue("--vol-per-interval") ?? envNumber("BACKTEST_VOL_PER_INTERVAL", 0.0015)),
        minEdge: Number(getArgValue("--min-edge") ?? envNumber("BACKTEST_MIN_EDGE", 0.03)),
        orderUsdc: Number(getArgValue("--order-usdc") ?? envNumber("BACKTEST_ORDER_USDC", 5)),
        maxUsdcPerLeg: Number(getArgValue("--max-usdc-per-leg") ?? envNumber("BACKTEST_MAX_USDC_PER_LEG", 10)),
        minSecondsLeft: Number(getArgValue("--min-seconds-left") ?? envNumber("BACKTEST_MIN_SECONDS_LEFT", 10)),
        maxPrice: Number(getArgValue("--max-price") ?? envNumber("BACKTEST_MAX_PRICE", 0.98)),
    };

    if (!cfg.csvPath) throw new Error("Missing --csv <path> or BACKTEST_CSV");
    if (cfg.intervalMinutes <= 0) throw new Error("BACKTEST_INTERVAL_MINUTES must be > 0");
    if (cfg.volPerInterval <= 0) throw new Error("BACKTEST_VOL_PER_INTERVAL must be > 0");
    if (cfg.minEdge < 0) throw new Error("BACKTEST_MIN_EDGE must be >= 0");
    if (cfg.orderUsdc <= 0) throw new Error("BACKTEST_ORDER_USDC must be > 0");
    if (cfg.maxUsdcPerLeg < 0) throw new Error("BACKTEST_MAX_USDC_PER_LEG must be >= 0");
    if (cfg.minSecondsLeft < 0) throw new Error("BACKTEST_MIN_SECONDS_LEFT must be >= 0");
    if (!(cfg.maxPrice > 0 && cfg.maxPrice <= 1)) throw new Error("BACKTEST_MAX_PRICE must be > 0 and <= 1");
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
        if (timestampMs === undefined || btcPrice === undefined || upAsk === undefined || downAsk === undefined) {
            throw new Error(`CSV row ${idx + 2} missing required timestamp/btcPrice/upAsk/downAsk`);
        }
        const startMs = Math.floor(timestampMs / intervalMs) * intervalMs;
        return {
            timestampMs,
            slug: pick(record, ["slug", "market", "market_slug"]) ?? `cycle-${Math.floor(startMs / 1000)}`,
            btcPrice,
            upAsk,
            downAsk,
            openPrice: parseNumber(pick(record, ["open_price", "cycle_open", "start_price"])),
        };
    }).sort((a, b) => a.timestampMs - b.timestampMs);
}

function normalCdf(x: number): number {
    return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x: number): number {
    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const t = 1 / (1 + p * absX);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
    return sign * y;
}

function fairUpProbability(row: MarketRow, cycle: CycleState, cfg: BacktestConfig): number {
    const secondsLeft = Math.max(1, (cycle.endMs - row.timestampMs) / 1000);
    const intervalSeconds = cfg.intervalMinutes * 60;
    const expectedMove = cycle.openPrice * cfg.volPerInterval * Math.sqrt(secondsLeft / intervalSeconds);
    if (expectedMove <= 0) return 0.5;
    return Math.min(0.995, Math.max(0.005, normalCdf((row.btcPrice - cycle.openPrice) / expectedMove)));
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
            trades: [],
        };
        if (!cycles.has(row.slug)) cycles.set(row.slug, cycle);
        cycle.finalPrice = row.btcPrice;

        const secondsLeft = (cycle.endMs - row.timestampMs) / 1000;
        if (secondsLeft < cfg.minSecondsLeft) continue;

        const fairUp = fairUpProbability(row, cycle, cfg);
        const fairDown = 1 - fairUp;
        maybeBuy(cycle, row, "UP", row.upAsk, fairUp, cfg);
        maybeBuy(cycle, row, "DOWN", row.downAsk, fairDown, cfg);
    }

    for (const cycle of cycles.values()) {
        const upWins = cycle.finalPrice > cycle.openPrice;
        for (const trade of cycle.trades) {
            const wins = trade.leg === "UP" ? upWins : !upWins;
            trade.finalPrice = cycle.finalPrice;
            trade.payout = wins ? trade.shares : 0;
            trade.pnl = trade.payout - trade.cost;
        }
    }

    const cycleList = Array.from(cycles.values()).sort((a, b) => a.startMs - b.startMs);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function maybeBuy(cycle: CycleState, row: MarketRow, leg: Leg, ask: number, fair: number, cfg: BacktestConfig): void {
    if (!(ask > 0 && ask <= cfg.maxPrice)) return;
    const edge = fair - ask;
    if (edge < cfg.minEdge) return;

    const spent = leg === "UP" ? cycle.spentUp : cycle.spentDown;
    const budgetLeft = cfg.maxUsdcPerLeg > 0 ? Math.max(0, cfg.maxUsdcPerLeg - spent) : cfg.orderUsdc;
    const cost = Math.min(cfg.orderUsdc, budgetLeft);
    if (cost <= 0) return;

    const shares = cost / ask;
    const trade: Trade = {
        slug: cycle.slug,
        timestampMs: row.timestampMs,
        leg,
        price: ask,
        shares,
        cost,
        fair,
        edge,
        openPrice: cycle.openPrice,
        btcPrice: row.btcPrice,
    };
    cycle.trades.push(trade);
    if (leg === "UP") cycle.spentUp += cost;
    else cycle.spentDown += cost;
}

function tradeCsv(trades: Trade[]): string {
    const header = ["timestamp", "slug", "leg", "price", "shares", "cost", "fair", "edge", "openPrice", "btcPrice", "finalPrice", "payout", "pnl"];
    const lines = trades.map((trade) => [
        new Date(trade.timestampMs).toISOString(),
        trade.slug,
        trade.leg,
        trade.price.toFixed(6),
        trade.shares.toFixed(6),
        trade.cost.toFixed(6),
        trade.fair.toFixed(6),
        trade.edge.toFixed(6),
        trade.openPrice.toFixed(2),
        trade.btcPrice.toFixed(2),
        (trade.finalPrice ?? 0).toFixed(2),
        (trade.payout ?? 0).toFixed(6),
        (trade.pnl ?? 0).toFixed(6),
    ].join(","));
    return `${header.join(",")}\n${lines.join("\n")}\n`;
}

function printSummary(cycles: CycleState[], trades: Trade[], cfg: BacktestConfig): void {
    const totalCost = trades.reduce((sum, trade) => sum + trade.cost, 0);
    const totalPayout = trades.reduce((sum, trade) => sum + (trade.payout ?? 0), 0);
    const totalPnl = totalPayout - totalCost;
    const winners = trades.filter((trade) => (trade.pnl ?? 0) > 0).length;
    const tradedCycles = cycles.filter((cycle) => cycle.trades.length > 0).length;
    const roi = totalCost > 0 ? totalPnl / totalCost : 0;

    console.log("=== BTC 5m Edge Backtest ===");
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
    const rows = toMarketRows(records, cfg.intervalMinutes);
    const { cycles, trades } = runBacktest(rows, cfg);

    const outPath = resolve(cfg.outputTradesPath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, tradeCsv(trades));
    printSummary(cycles, trades, cfg);
}

main();
