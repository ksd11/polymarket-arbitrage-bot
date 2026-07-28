import { readFileSync } from "fs";

type Component = "dynamic" | "final" | "unknown";
type ActualRow = { marketName: string; action: string; usdcAmount: number; tokenAmount: number; tokenName: string; timestamp: number; hash: string; marketStart: number };
type PostedOrder = { marketStart: number; timestamp: number; role: string; leg: string; side: string; size: number; orderId: string; matched: boolean };
type Lot = { component: Component; shares: number };

function parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
            if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
            else quoted = !quoted;
        } else if (character === "," && !quoted) { values.push(value); value = ""; }
        else value += character;
    }
    values.push(value);
    return values;
}

function parseArgs(): { history: string; bot: string } {
    const args = process.argv.slice(2);
    const value = (name: string): string | undefined => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
    const history = value("--history") ?? args[0];
    const bot = value("--bot") ?? args[1];
    if (!history || !bot) throw new Error("Usage: npm run analyze:btc5m-live-ledger -- --history <Polymarket-History.csv> --bot <strategy-record.csv>");
    return { history, bot };
}

function easternMarketStart(name: string, referenceTimestamp: number): number {
    const match = name.match(/- ([A-Za-z]+) (\d+), (\d+):(\d+)(AM|PM)-/);
    if (!match) throw new Error(`Unsupported market name: ${name}`);
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    let hour = Number(match[3]) % 12;
    if (match[5] === "PM") hour += 12;
    const month = months.indexOf(match[1]);
    const year = new Date(referenceTimestamp * 1000).getUTCFullYear();
    for (const offsetHours of [4, 5]) {
        const timestamp = Date.UTC(year, month, Number(match[2]), hour + offsetHours, Number(match[4])) / 1000;
        const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(timestamp * 1000));
        if (parts.includes(match[1]) && parts.includes(String(Number(match[2]))) && parts.replace(/\s/g, "").includes(`${Number(match[3])}:${match[4]}${match[5]}`)) return timestamp;
    }
    throw new Error(`Unable to resolve Eastern timestamp: ${name}`);
}

function readActual(path: string): ActualRow[] {
    const lines = readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    const header = parseCsvLine(lines[0]);
    return lines.slice(1).map((line) => {
        const values = parseCsvLine(line);
        const row = Object.fromEntries(header.map((key, index) => [key, values[index]]));
        const timestamp = Number(row.timestamp);
        return { marketName: row.marketName, action: row.action.toUpperCase(), usdcAmount: Number(row.usdcAmount), tokenAmount: Number(row.tokenAmount), tokenName: row.tokenName.toUpperCase(), timestamp, hash: row.hash, marketStart: easternMarketStart(row.marketName, timestamp) };
    }).sort((left, right) => left.timestamp - right.timestamp);
}

function readPostedOrders(path: string): PostedOrder[] {
    const lines = readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    const header = parseCsvLine(lines[0]);
    const indexes = Object.fromEntries(header.map((key, index) => [key, index]));
    return lines.slice(1).map(parseCsvLine).filter((values) => values[indexes.row_type] === "order_posted").map((values) => ({
        marketStart: Number((values[indexes.slug] ?? "").match(/(\d+)$/)?.[1]),
        timestamp: Date.parse(values[indexes.timestamp]) / 1000,
        role: values[indexes.event_role], leg: values[indexes.event_leg], side: values[indexes.event_side],
        size: Number(values[indexes.event_size]), orderId: values[indexes.order_id], matched: false,
    }));
}

function componentForRole(role: string): Component {
    if (role.startsWith("dynamic-")) return "dynamic";
    if (role === "final-entry") return "final";
    return "unknown";
}

function matchOrder(row: ActualRow, orders: PostedOrder[]): PostedOrder | undefined {
    const candidates = orders.filter((order) => !order.matched && order.marketStart === row.marketStart && order.side === row.action && order.leg === row.tokenName && order.timestamp <= row.timestamp + 5 && row.timestamp - order.timestamp <= 180);
    candidates.sort((left, right) => {
        const leftSize = Math.abs(left.size - row.tokenAmount); const rightSize = Math.abs(right.size - row.tokenAmount);
        if (Math.abs(leftSize - rightSize) > 0.01) return leftSize - rightSize;
        return Math.abs(row.timestamp - left.timestamp) - Math.abs(row.timestamp - right.timestamp);
    });
    const match = candidates.find((order) => Math.abs(order.size - row.tokenAmount) <= Math.max(0.031, row.tokenAmount * 0.015));
    if (match) match.matched = true;
    return match;
}

function allocate(lots: Lot[], shares: number, amount: number, totals: Map<Component, number>): number {
    let remaining = shares;
    let allocatedShares = 0;
    const allocations: { component: Component; shares: number }[] = [];
    for (const lot of lots) {
        if (remaining <= 1e-9 || lot.shares <= 1e-9) continue;
        const used = Math.min(lot.shares, remaining);
        lot.shares -= used; remaining -= used; allocatedShares += used;
        allocations.push({ component: lot.component, shares: used });
    }
    for (const allocation of allocations) totals.set(allocation.component, (totals.get(allocation.component) ?? 0) + amount * allocation.shares / shares);
    if (remaining > 1e-6) totals.set("unknown", (totals.get("unknown") ?? 0) + amount * remaining / shares);
    return allocatedShares;
}

function main(): void {
    const { history, bot } = parseArgs();
    const actual = readActual(history);
    const orders = readPostedOrders(bot);
    const pnl = new Map<Component, number>([["dynamic", 0], ["final", 0], ["unknown", 0]]);
    const costs = new Map<Component, number>([["dynamic", 0], ["final", 0], ["unknown", 0]]);
    const income = new Map<Component, number>([["dynamic", 0], ["final", 0], ["unknown", 0]]);
    const cyclePnl = new Map<string, number>();
    const lots = new Map<string, Lot[]>();
    let matchedBuys = 0, matchedSells = 0, unmatchedBuys = 0, unmatchedSells = 0;

    const addPnl = (component: Component, marketStart: number, amount: number): void => {
        pnl.set(component, (pnl.get(component) ?? 0) + amount);
        const key = `${marketStart}:${component}`;
        cyclePnl.set(key, (cyclePnl.get(key) ?? 0) + amount);
    };

    for (const row of actual) {
        const key = `${row.marketStart}:${row.tokenName}`;
        const marketLots = lots.get(key) ?? [];
        if (row.action === "BUY") {
            const order = matchOrder(row, orders);
            const component = order ? componentForRole(order.role) : "unknown";
            if (order) matchedBuys += 1; else unmatchedBuys += 1;
            marketLots.push({ component, shares: row.tokenAmount });
            lots.set(key, marketLots);
            costs.set(component, (costs.get(component) ?? 0) + row.usdcAmount);
            addPnl(component, row.marketStart, -row.usdcAmount);
        } else if (row.action === "SELL" || row.action === "REDEEM") {
            if (row.action === "SELL") {
                const order = matchOrder(row, orders);
                if (order) matchedSells += 1; else unmatchedSells += 1;
            }
            const allocations = new Map<Component, number>();
            allocate(marketLots, row.tokenAmount, row.usdcAmount, allocations);
            for (const [component, amount] of allocations) {
                income.set(component, (income.get(component) ?? 0) + amount);
                addPnl(component, row.marketStart, amount);
            }
        }
    }

    const stats = (["dynamic", "final", "unknown"] as Component[]).map((component) => {
        const cycles = [...cyclePnl].filter(([key]) => key.endsWith(`:${component}`)).map(([, value]) => value).filter((value) => Math.abs(value) > 1e-9);
        const cost = costs.get(component) ?? 0;
        const profitableCycles = cycles.filter((value) => value > 1e-9);
        const losingCycles = cycles.filter((value) => value < -1e-9);
        return { component, cost, income: income.get(component) ?? 0, pnl: pnl.get(component) ?? 0, roi: cost > 0 ? (pnl.get(component) ?? 0) / cost : 0, cycles: cycles.length, profitable: profitableCycles.length, losing: losingCycles.length, winRate: cycles.length ? profitableCycles.length / cycles.length : 0, grossProfit: profitableCycles.reduce((sum, value) => sum + value, 0), grossLoss: losingCycles.reduce((sum, value) => sum + value, 0), averagePnl: cycles.length ? cycles.reduce((sum, value) => sum + value, 0) / cycles.length : 0, maxProfit: Math.max(0, ...cycles), maxLoss: Math.min(0, ...cycles) };
    });
    console.log(JSON.stringify({ history, bot, rows: actual.length, actualCashflow: actual.reduce((sum, row) => sum + (row.action === "BUY" ? -row.usdcAmount : row.usdcAmount), 0), matching: { matchedBuys, unmatchedBuys, matchedSells, unmatchedSells, postedOrders: orders.length, unmatchedPostedOrders: orders.filter((order) => !order.matched).length }, strategies: stats }, null, 2));
}

main();
