/**
 * GTC-vs-FAK fill-rate A/B runner for the BTC-5m executors.
 *
 * Runs the SAME strategy twice over the same wall-clock window -- once posting
 * resting GTC limit orders (maker), once hitting the book with FAK market orders
 * (taker) -- then prints a fill-rate comparison via `src/utils/fill-rate-report.ts`.
 *
 * SAFETY: dry-run by default. Real orders are only placed when `CONFIRM_LIVE=yes`
 * is set, and it warns for 5s before arming so the run can be aborted.
 *
 * Usage:
 *   npm run btc5m:fill-ab                                        # dry-run, 2 cycles each
 *   MODE=final-30-high CYCLES=4 npm run btc5m:fill-ab            # dry-run, 4 cycles each
 *   CONFIRM_LIVE=yes MODE=final-30-managed npm run btc5m:fill-ab # REAL MONEY
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODE = process.env.MODE ?? "final-30-managed";
const CYCLES = Number(process.env.CYCLES ?? 2);
const OUT_DIR = process.env.OUT_DIR ?? "data/fill-ab";
const LIVE = (process.env.CONFIRM_LIVE ?? "no").toLowerCase() === "yes";
// Seconds per leg; defaults to CYCLES 5-minute windows plus a small margin.
const DURATION_SEC = Number(process.env.DURATION_SEC ?? CYCLES * 300 + 20);

const PREFIX_BY_MODE: Record<string, string> = {
    "final-30-managed": "FINAL_30_MANAGED",
    "final-30-high": "FINAL_30_HIGH",
    "deep-rebound": "DEEP_REBOUND",
    "undervalued-hold": "UNDERVALUED_HOLD",
    "undervalued-final-managed": "UNDERVALUED_FINAL_MANAGED",
    "dynamic-range-final-managed": "DYNAMIC_RANGE_FINAL_MANAGED",
    "reverse-touch-edge": "REVERSE_TOUCH_EDGE",
    "latency-scalp": "LATENCY_SCALP",
};
const PREFIX = PREFIX_BY_MODE[MODE] ?? "LATENCY_SCALP";

const EXECUTOR = "src/btc-5m-latency-scalp.ts";
const REPORTER = "src/utils/fill-rate-report.ts";

function runToCompletion(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
    return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: "inherit", env, detached: true });
        child.on("close", (code) => resolve(code ?? 0));
        child.on("error", (error) => { console.error(`spawn failed: ${error.message}`); resolve(1); });
    });
}

/** Run one leg for DURATION_SEC, then hard-kill its process group. */
function runLeg(orderType: string, file: string): Promise<void> {
    const logFile = file.replace(/\.csv$/, ".log");
    console.log(`\n>>> ${orderType} leg: ${DURATION_SEC}s -> ${file}`);
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        BTC5M_SCALP_MODE: MODE,
        [`${PREFIX}_DRY_RUN`]: String(!LIVE),
        [`${PREFIX}_ORDER_TYPE`]: orderType,
        [`${PREFIX}_RECORD_FILE`]: file,
    };
    return new Promise((resolve) => {
        const child = spawn("npx", ["tsx", EXECUTOR], { stdio: ["ignore", "pipe", "pipe"], env, detached: true });
        const chunks: string[] = [];
        child.stdout?.on("data", (data) => chunks.push(String(data)));
        child.stderr?.on("data", (data) => chunks.push(String(data)));
        const timer = setTimeout(() => {
            try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
        }, DURATION_SEC * 1000);
        child.on("close", () => {
            clearTimeout(timer);
            try { writeFileSync(logFile, chunks.join("")); } catch { /* best effort */ }
            console.log(`    done (log: ${logFile})`);
            resolve();
        });
        child.on("error", (error) => { clearTimeout(timer); console.error(`    spawn failed: ${error.message}`); resolve(); });
    });
}

async function main(): Promise<void> {
    if (LIVE) {
        console.log("**********************************************************************");
        console.log("*  LIVE MODE - REAL ORDERS WITH REAL USDC WILL BE PLACED.            *");
        console.log(`*  mode=${MODE}  cycles=${CYCLES}  order types: GTC then FAK`);
        console.log("*  The 5m strategies currently show NEGATIVE expectancy in backtest; *");
        console.log("*  expect to lose money. This run is for FILL-RATE MEASUREMENT only. *");
        console.log("*  Press Ctrl-C within 5s to abort.                                  *");
        console.log("**********************************************************************");
        await new Promise((resolve) => setTimeout(resolve, 5000));
    } else {
        console.log("DRY-RUN mode (no real orders). Set CONFIRM_LIVE=yes to arm real trading.");
    }

    mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const gtcFile = join(OUT_DIR, `gtc-${stamp}.csv`);
    const fakFile = join(OUT_DIR, `fak-${stamp}.csv`);

    await runLeg("GTC", gtcFile);
    await runLeg("FAK", fakFile);

    console.log("\n=== A/B fill-rate report (GTC vs FAK) ===");
    await runToCompletion("npx", ["tsx", REPORTER, gtcFile, fakFile], process.env);
}

main().catch((error) => { console.error(error); process.exit(1); });
