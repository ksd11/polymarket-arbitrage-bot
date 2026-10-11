/**
 * Fill-rate report for the BTC-5m executors.
 *
 * Reads one or more executor record CSVs (the files written by
 * `src/btc-5m-latency-scalp.ts` via `*_RECORD_FILE`) and reports, per order type
 * (GTC / FOK / GTD / FAK) and per side, how many orders were posted, how many
 * actually filled (any / full), how many were rejected / skipped / deferred, and
 * the fill latency distribution.
 *
 * It exists so a GTC vs FAK A/B run can be compared with one command:
 *   npm run report:fill-rate -- data/fill-ab-gtc.csv data/fill-ab-fak.csv
 *
 * Usage:
 *   tsx src/utils/fill-rate-report.ts <csv...> [--json]
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

type Row = Record<string, string>;

/** Minimal RFC-4180-ish reader: handles quoted fields, escaped quotes and CRLF. */
function parseCsv(text: string): Row[] {
    const rows: string[][] = [];
    let field = "";
    let record: string[] = [];
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (quoted) {
            if (char === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 1; }
                else quoted = false;
            } else field += char;
        } else if (char === '"') quoted = true;
        else if (char === ",") { record.push(field); field = ""; }
        else if (char === "\n") { record.push(field); rows.push(record); record = []; field = ""; }
        else if (char === "\r") { /* swallow */ }
        else field += char;
    }
    if (field.length > 0 || record.length > 0) { record.push(field); rows.push(record); }
    if (rows.length === 0) return [];
    const header = rows[0].map((name) => name.trim());
    return rows.slice(1)
        .filter((cells) => cells.some((cell) => cell !== ""))
        .map((cells) => {
            const row: Row = {};
            header.forEach((name, index) => { row[name] = cells[index] ?? ""; });
            return row;
        });
}

const FILL_ROWS = new Set(["order_fill", "order_trade_fill", "order_fill_during_cancel", "order_trade_correction", "dry_run_entry_fill", "dry_run_exit_fill", "dry_run_order_fill"]);
const POST_ROWS = new Set(["order_posted", "dry_run_order_posted"]);
const REJECT_ROWS = new Set(["order_rejected"]);
const SKIP_ROWS = new Set(["order_skipped"]);
const DEFER_ROWS = new Set(["order_deferred"]);

type Bucket = {
    posted: number;
    rejected: number;
    skipped: number;
    deferred: number;
    postedNotional: number;
    /** orderId -> filled shares (max seen). */
    filledShares: Map<string, number>;
    /** orderId -> order size (max seen). */
    orderSizes: Map<string, number>;
    fillLatenciesMs: number[];
    errors: Map<string, number>;
};

function newBucket(): Bucket {
    return { posted: 0, rejected: 0, skipped: 0, deferred: 0, postedNotional: 0, filledShares: new Map(), orderSizes: new Map(), fillLatenciesMs: [], errors: new Map() };
}

function num(value: string | undefined): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function quantile(sorted: number[], q: number): number | undefined {
    if (sorted.length === 0) return undefined;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
    return sorted[index];
}

function consume(bucket: Bucket, row: Row): void {
    const rowType = row.row_type ?? "";
    const orderId = (row.order_id ?? "").trim();
    if (POST_ROWS.has(rowType)) {
        bucket.posted += 1;
        bucket.postedNotional += num(row.event_notional) || num(row.event_cost);
        if (orderId) {
            bucket.orderSizes.set(orderId, Math.max(bucket.orderSizes.get(orderId) ?? 0, num(row.event_size)));
        }
    } else if (REJECT_ROWS.has(rowType)) {
        bucket.rejected += 1;
        const reason = (row.event_error ?? "").slice(0, 60);
        if (reason) bucket.errors.set(reason, (bucket.errors.get(reason) ?? 0) + 1);
    } else if (SKIP_ROWS.has(rowType)) {
        bucket.skipped += 1;
    } else if (DEFER_ROWS.has(rowType)) {
        bucket.deferred += 1;
    }
    const filled = num(row.filled_size);
    if (orderId && (FILL_ROWS.has(rowType) || filled > 0)) {
        if (filled > 0) bucket.filledShares.set(orderId, Math.max(bucket.filledShares.get(orderId) ?? 0, filled));
        const size = num(row.event_size);
        if (size > 0) bucket.orderSizes.set(orderId, Math.max(bucket.orderSizes.get(orderId) ?? 0, size));
        const latency = row.fill_latency_ms !== undefined && row.fill_latency_ms !== "" ? num(row.fill_latency_ms) : NaN;
        if (Number.isFinite(latency)) bucket.fillLatenciesMs.push(latency);
    }
}

type Stats = {
    key: string;
    posted: number;
    rejected: number;
    skipped: number;
    deferred: number;
    filled: number;
    fullFilled: number;
    fillRate: number;
    fullFillRate: number;
    rejectRate: number;
    avgFillLatencyMs?: number;
    p50FillLatencyMs?: number;
    p90FillLatencyMs?: number;
};

function summarize(key: string, bucket: Bucket): Stats {
    const filled = bucket.filledShares.size;
    let fullFilled = 0;
    for (const [orderId, shares] of bucket.filledShares) {
        const size = bucket.orderSizes.get(orderId) ?? 0;
        if (size > 0 && shares + 1e-9 >= size) fullFilled += 1;
    }
    const latencies = [...bucket.fillLatenciesMs].sort((a, b) => a - b);
    const avg = latencies.length ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : undefined;
    const attempts = bucket.posted + bucket.rejected + bucket.skipped + bucket.deferred;
    return {
        key,
        posted: bucket.posted,
        rejected: bucket.rejected,
        skipped: bucket.skipped,
        deferred: bucket.deferred,
        filled,
        fullFilled,
        fillRate: bucket.posted > 0 ? filled / bucket.posted : 0,
        fullFillRate: bucket.posted > 0 ? fullFilled / bucket.posted : 0,
        rejectRate: attempts > 0 ? bucket.rejected / attempts : 0,
        avgFillLatencyMs: avg,
        p50FillLatencyMs: quantile(latencies, 0.5),
        p90FillLatencyMs: quantile(latencies, 0.9),
    };
}

function pct(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

function fmt(value: number | undefined, digits = 0): string {
    return value === undefined ? "-" : value.toFixed(digits);
}

function printTable(stats: Stats[]): void {
    const header = ["order_type", "side", "posted", "filled", "full", "fill%", "full%", "rej", "skip", "defer", "rej%", "p50ms", "p90ms"];
    const lines = [header.join("\t")];
    for (const row of stats) {
        const [orderType, side = "-"] = row.key.split("|");
        lines.push([
            orderType, side, row.posted, row.filled, row.fullFilled, pct(row.fillRate), pct(row.fullFillRate),
            row.rejected, row.skipped, row.deferred, pct(row.rejectRate),
            fmt(row.p50FillLatencyMs), fmt(row.p90FillLatencyMs),
        ].join("\t"));
    }
    console.log(lines.join("\n"));
}

function main(): void {
    const args = process.argv.slice(2);
    const asJson = args.includes("--json");
    const files = args.filter((arg) => !arg.startsWith("--"));
    if (files.length === 0) {
        console.error("usage: tsx src/utils/fill-rate-report.ts <csv...> [--json]");
        process.exit(1);
    }
    const byType = new Map<string, Bucket>();
    const byTypeSide = new Map<string, Bucket>();
    let totalRows = 0;
    const fileSummary: Array<{ file: string; rows: number; dryRun: boolean; orderTypes: string[] }> = [];

    for (const file of files) {
        if (!existsSync(file)) { console.error(`skip (missing): ${file}`); continue; }
        const rows = parseCsv(readFileSync(file, "utf8"));
        totalRows += rows.length;
        const orderTypes = new Set<string>();
        let dryRun = false;
        for (const row of rows) {
            if (row.row_type === "decision" || row.row_type === "resolution") continue;
            const orderType = (row.order_type ?? "").trim() || "UNKNOWN";
            const side = (row.event_side ?? "").trim() || "-";
            if (row.dry_run === "true") dryRun = true;
            orderTypes.add(orderType);
            const typeKey = orderType;
            const typeSideKey = `${orderType}|${side}`;
            if (!byType.has(typeKey)) byType.set(typeKey, newBucket());
            if (!byTypeSide.has(typeSideKey)) byTypeSide.set(typeSideKey, newBucket());
            consume(byType.get(typeKey)!, row);
            consume(byTypeSide.get(typeSideKey)!, row);
        }
        fileSummary.push({ file: basename(file), rows: rows.length, dryRun, orderTypes: [...orderTypes] });
    }

    const overall = [...byType.entries()].map(([key, bucket]) => summarize(key, bucket)).sort((a, b) => a.key.localeCompare(b.key));
    const perSide = [...byTypeSide.entries()].map(([key, bucket]) => summarize(key, bucket)).sort((a, b) => a.key.localeCompare(b.key));

    if (asJson) {
        console.log(JSON.stringify({ files: fileSummary, totalRows, byOrderType: overall, byOrderTypeSide: perSide }, null, 2));
        return;
    }

    console.log("=== Fill-rate report ===");
    for (const summary of fileSummary) console.log(`  ${summary.file}: ${summary.rows} rows, dry_run=${summary.dryRun}, order_types=[${summary.orderTypes.join(",")}]`);
    console.log("");
    console.log(`Total data rows: ${totalRows}`);
    console.log("");
    console.log("--- by order type ---");
    printTable(overall);
    console.log("");
    console.log("--- by order type x side ---");
    printTable(perSide);
    console.log("");
    const rejectionNotes = [...byType.entries()].flatMap(([key, bucket]) => [...bucket.errors.entries()].map(([reason, count]) => ({ key, reason, count })));
    if (rejectionNotes.length > 0) {
        console.log("--- top rejection reasons ---");
        rejectionNotes.sort((a, b) => b.count - a.count).slice(0, 10).forEach((note) => console.log(`  [${note.key}] x${note.count} ${note.reason}`));
    }
}

main();
