import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { buildBtc5mEdgeOrders } from "../strategies/btc5m/edge";
import { buildBtc5mMarketMakerQuotes } from "../strategies/btc5m/market-maker";
import { buildBtc5mRangeArbOrders } from "../strategies/btc5m/range-arb";
import { buildBtc5mHybridOrders, PriceSnapshot } from "../strategies/btc5m/hybrid";
import { buildBtc5mManagedEdgeOrders } from "../strategies/btc5m/managed-edge";
import { buildBtc5mAdaptiveEdgeOrders } from "../strategies/btc5m/adaptive-edge";
import { buildBtc5mTrendPullbackOrders, Btc5mTrendPullbackState } from "../strategies/btc5m/trend-pullback";
import { Btc5mRegimeSnapshot } from "../strategies/btc5m/regime";
import { Btc5mStrategyQuote } from "../strategies/btc5m/types";

type Leg = "UP" | "DOWN";
type BacktestStrategy = "edge" | "range-arb" | "market-maker" | "hybrid" | "managed-edge" | "adaptive-edge" | "trend-pullback";

type BacktestConfig = {
    strategy: BacktestStrategy;
    csvPath: string;
    outputTradesPath: string;
    intervalMinutes: number;
    volPerInterval: number;
    minEdge: number;
    edgeMinMoveBps: number;
    edgeMinElapsedSeconds: number;
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
    // Hybrid params
    hybridLookbackSeconds: number;
    hybridOscillationThreshold: number;
    hybridRangeThreshold: number;
    hybridTrendThreshold: number;
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
    adaptiveLookbackSeconds: number;
    adaptiveMinHistoryPoints: number;
    adaptiveOscillationCrossCount: number;
    adaptiveOscillationChoppiness: number;
    adaptiveOscillationMaxBtcMoveBps: number;
    adaptiveTrendMinBtcMoveBps: number;
    adaptiveTrendMaxChoppiness: number;
    adaptivePanicMaxBtcMoveBps: number;
    adaptivePanicMinDiscount: number;
    adaptivePanicMinAsk: number;
    adaptivePanicMaxAsk: number;
    adaptiveUndervalueScoreThreshold: number;
    adaptiveMaxRequiredSigma: number;
    adaptiveMomentumMinBps: number;
    adaptiveFairMarketWeight: number;
    adaptiveFairAskWeight: number;
    adaptivePercentileWeight: number;
    adaptiveMomentumDivergenceBonus: number;
    adaptivePanicDiscountBonus: number;
    adaptiveRequiredSigmaPenalty: number;
    adaptiveLateTimePenalty: number;
    adaptiveScalpProfitPrice: number;
    adaptiveScalpProfitPct: number;
    trendPullbackTriggerPrice: number;
    trendPullbackEntryPrice: number;
    trendPullbackOrderUsdc: number;
    trendPullbackMaxUsdcPerLeg: number;
    trendPullbackMinSecondsLeftToTrigger: number;
    trendPullbackTriggerConfirmSeconds: number;
    trendPullbackMaxOrderAgeSeconds: number;
    trendPullbackMaxBtcReversalBps: number;
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
    costUp: number;
    costDown: number;
    tookProfitUp?: boolean;
    tookProfitDown?: boolean;
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
        "  npm run backtest:btc5m -- --strategy <edge|managed-edge|adaptive-edge|trend-pullback|range-arb|market-maker|hybrid> --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:edge --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:range-arb --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:market-maker --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:managed-edge --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:trend-pullback --csv <path>",
        "",
        "Required:",
        "  --strategy <name>   Strategy name. Also supports btc5m:* aliases",
        "  --csv <path>        Historical CSV file, e.g. data/btc5m-history.csv",
        "",
        "Optional:",
        "  --out <path>                 Trades output CSV",
        "  --min-edge <number>          Default: BACKTEST_MIN_EDGE or 0.03",
        "  --edge-min-move-bps <number> Default: BACKTEST_EDGE_MIN_MOVE_BPS or 0",
        "  --edge-min-elapsed <seconds>  Default: BACKTEST_EDGE_MIN_ELAPSED_SECONDS or 0",
        "  --order-usdc <number>        Default: BACKTEST_ORDER_USDC or 5",
        "  --max-usdc-per-leg <number>  Default: BACKTEST_MAX_USDC_PER_LEG or 10",
        "  --trend-trigger-price <price> Trend-pullback trigger; default 0.85",
        "  --trend-entry-price <price>   Trend-pullback BUY limit; default 0.80",
        "  --trend-order-usdc <number>   Trend-pullback cost per filled cycle; default 5",
    ].join("\n");
}

function parseStrategy(value: string | undefined): BacktestStrategy {
    if (value === "edge" || value === "btc5m:edge") return "edge";
    if (value === "range-arb" || value === "btc5m:range-arb") return "range-arb";
    if (value === "market-maker" || value === "btc5m:market-maker") return "market-maker";
    if (value === "hybrid" || value === "btc5m:hybrid") return "hybrid";
    if (value === "managed-edge" || value === "btc5m:managed-edge") return "managed-edge";
    if (value === "adaptive-edge" || value === "btc5m:adaptive-edge") return "adaptive-edge";
    if (value === "trend-pullback" || value === "btc5m:trend-pullback") return "trend-pullback";
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
        intervalMinutes: Number(getArgValue("--interval-minutes") ?? envNumber("BACKTEST_INTERVAL_MINUTES", envNumber("BTC5M_INTERVAL_MINUTES", 5))),
        volPerInterval: Number(getArgValue("--vol-per-interval") ?? envNumber("BACKTEST_VOL_PER_INTERVAL", 0.0015)),
        minEdge: Number(getArgValue("--min-edge") ?? envNumber("BACKTEST_MIN_EDGE", 0.03)),
        edgeMinMoveBps: Number(getArgValue("--edge-min-move-bps") ?? envNumber("BACKTEST_EDGE_MIN_MOVE_BPS", 0)),
        edgeMinElapsedSeconds: Number(getArgValue("--edge-min-elapsed") ?? envNumber("BACKTEST_EDGE_MIN_ELAPSED_SECONDS", 0)),
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
        // Hybrid params
        hybridLookbackSeconds: Number(getArgValue("--hybrid-lookback") ?? envNumber("HYBRID_LOOKBACK_SECONDS", 60)),
        hybridOscillationThreshold: Number(getArgValue("--hybrid-osc-threshold") ?? envNumber("HYBRID_OSC_THRESHOLD", 2)),
        hybridRangeThreshold: Number(getArgValue("--hybrid-range-threshold") ?? envNumber("HYBRID_RANGE_THRESHOLD", 0.30)),
        hybridTrendThreshold: Number(getArgValue("--hybrid-trend-threshold") ?? envNumber("HYBRID_TREND_THRESHOLD", 0.15)),
        managedMinSecondsLeftToOpen: Number(getArgValue("--managed-min-seconds-left-to-open") ?? envNumber("MANAGED_EDGE_MIN_SECONDS_LEFT_TO_OPEN", 60)),
        managedMaxSecondsLeftToOpen: Number(getArgValue("--managed-max-seconds-left-to-open") ?? envNumber("MANAGED_EDGE_MAX_SECONDS_LEFT_TO_OPEN", 240)),
        managedNoCheapBuySecondsLeft: Number(getArgValue("--managed-no-cheap-buy-seconds-left") ?? envNumber("MANAGED_EDGE_NO_CHEAP_BUY_SECONDS_LEFT", 90)),
        managedMinCheapPrice: Number(getArgValue("--managed-min-cheap-price") ?? envNumber("MANAGED_EDGE_MIN_CHEAP_PRICE", 0.20)),
        managedMinEntryPrice: Number(getArgValue("--managed-min-entry-price") ?? envNumber("MANAGED_EDGE_MIN_ENTRY_PRICE", 0.12)),
        managedTakeProfitPct: Number(getArgValue("--managed-take-profit-pct") ?? envNumber("MANAGED_EDGE_TAKE_PROFIT_PCT", 0.20)),
        managedTakeProfitSellRatio: Number(getArgValue("--managed-take-profit-sell-ratio") ?? envNumber("MANAGED_EDGE_TAKE_PROFIT_SELL_RATIO", 0.50)),
        managedStopLossPct: Number(getArgValue("--managed-stop-loss-pct") ?? envNumber("MANAGED_EDGE_STOP_LOSS_PCT", 0.30)),
        managedForceExitSecondsLeft: Number(getArgValue("--managed-force-exit-seconds-left") ?? envNumber("MANAGED_EDGE_FORCE_EXIT_SECONDS_LEFT", 30)),
        managedMinExitPrice: Number(getArgValue("--managed-min-exit-price") ?? envNumber("MANAGED_EDGE_MIN_EXIT_PRICE", 0.05)),
        adaptiveLookbackSeconds: Number(getArgValue("--adaptive-lookback") ?? envNumber("ADAPTIVE_EDGE_LOOKBACK_SECONDS", 60)),
        adaptiveMinHistoryPoints: Number(getArgValue("--adaptive-min-history-points") ?? envNumber("ADAPTIVE_EDGE_MIN_HISTORY_POINTS", 8)),
        adaptiveOscillationCrossCount: Number(getArgValue("--adaptive-osc-cross-count") ?? envNumber("ADAPTIVE_EDGE_OSC_CROSS_COUNT", 2)),
        adaptiveOscillationChoppiness: Number(getArgValue("--adaptive-osc-choppiness") ?? envNumber("ADAPTIVE_EDGE_OSC_CHOPPINESS", 3)),
        adaptiveOscillationMaxBtcMoveBps: Number(getArgValue("--adaptive-osc-max-btc-move-bps") ?? envNumber("ADAPTIVE_EDGE_OSC_MAX_BTC_MOVE_BPS", 8)),
        adaptiveTrendMinBtcMoveBps: Number(getArgValue("--adaptive-trend-min-btc-move-bps") ?? envNumber("ADAPTIVE_EDGE_TREND_MIN_BTC_MOVE_BPS", 5)),
        adaptiveTrendMaxChoppiness: Number(getArgValue("--adaptive-trend-max-choppiness") ?? envNumber("ADAPTIVE_EDGE_TREND_MAX_CHOPPINESS", 8)),
        adaptivePanicMaxBtcMoveBps: Number(getArgValue("--adaptive-panic-max-btc-move-bps") ?? envNumber("ADAPTIVE_EDGE_PANIC_MAX_BTC_MOVE_BPS", 5)),
        adaptivePanicMinDiscount: Number(getArgValue("--adaptive-panic-min-discount") ?? envNumber("ADAPTIVE_EDGE_PANIC_MIN_DISCOUNT", 0.10)),
        adaptivePanicMinAsk: Number(getArgValue("--adaptive-panic-min-ask") ?? envNumber("ADAPTIVE_EDGE_PANIC_MIN_ASK", 0.15)),
        adaptivePanicMaxAsk: Number(getArgValue("--adaptive-panic-max-ask") ?? envNumber("ADAPTIVE_EDGE_PANIC_MAX_ASK", 0.45)),
        adaptiveUndervalueScoreThreshold: Number(getArgValue("--adaptive-undervalue-score") ?? envNumber("ADAPTIVE_EDGE_UNDERVALUE_SCORE_THRESHOLD", 0.20)),
        adaptiveMaxRequiredSigma: Number(getArgValue("--adaptive-max-required-sigma") ?? envNumber("ADAPTIVE_EDGE_MAX_REQUIRED_SIGMA", 1.20)),
        adaptiveMomentumMinBps: Number(getArgValue("--adaptive-momentum-min-bps") ?? envNumber("ADAPTIVE_EDGE_MOMENTUM_MIN_BPS", 2)),
        adaptiveFairMarketWeight: Number(getArgValue("--adaptive-fair-market-weight") ?? envNumber("ADAPTIVE_EDGE_FAIR_MARKET_WEIGHT", 0.35)),
        adaptiveFairAskWeight: Number(getArgValue("--adaptive-fair-ask-weight") ?? envNumber("ADAPTIVE_EDGE_FAIR_ASK_WEIGHT", 0.20)),
        adaptivePercentileWeight: Number(getArgValue("--adaptive-percentile-weight") ?? envNumber("ADAPTIVE_EDGE_PERCENTILE_WEIGHT", 0.04)),
        adaptiveMomentumDivergenceBonus: Number(getArgValue("--adaptive-momentum-divergence-bonus") ?? envNumber("ADAPTIVE_EDGE_MOMENTUM_DIVERGENCE_BONUS", 0.04)),
        adaptivePanicDiscountBonus: Number(getArgValue("--adaptive-panic-discount-bonus") ?? envNumber("ADAPTIVE_EDGE_PANIC_DISCOUNT_BONUS", 0.03)),
        adaptiveRequiredSigmaPenalty: Number(getArgValue("--adaptive-required-sigma-penalty") ?? envNumber("ADAPTIVE_EDGE_REQUIRED_SIGMA_PENALTY", 0.10)),
        adaptiveLateTimePenalty: Number(getArgValue("--adaptive-late-time-penalty") ?? envNumber("ADAPTIVE_EDGE_LATE_TIME_PENALTY", 0.05)),
        adaptiveScalpProfitPrice: Number(getArgValue("--adaptive-scalp-profit-price") ?? envNumber("ADAPTIVE_EDGE_SCALP_PROFIT_PRICE", 0.10)),
        adaptiveScalpProfitPct: Number(getArgValue("--adaptive-scalp-profit-pct") ?? envNumber("ADAPTIVE_EDGE_SCALP_PROFIT_PCT", 0.25)),
        trendPullbackTriggerPrice: Number(getArgValue("--trend-trigger-price") ?? envNumber("TREND_PULLBACK_TRIGGER_PRICE", 0.85)),
        trendPullbackEntryPrice: Number(getArgValue("--trend-entry-price") ?? envNumber("TREND_PULLBACK_ENTRY_PRICE", 0.80)),
        trendPullbackOrderUsdc: Number(getArgValue("--trend-order-usdc") ?? envNumber("TREND_PULLBACK_ORDER_USDC", 5)),
        trendPullbackMaxUsdcPerLeg: Number(getArgValue("--trend-max-usdc-per-leg") ?? envNumber("TREND_PULLBACK_MAX_USDC_PER_LEG", 5)),
        trendPullbackMinSecondsLeftToTrigger: Number(getArgValue("--trend-min-seconds-left-to-trigger") ?? envNumber("TREND_PULLBACK_MIN_SECONDS_LEFT_TO_TRIGGER", 30)),
        trendPullbackTriggerConfirmSeconds: Number(getArgValue("--trend-trigger-confirm-seconds") ?? envNumber("TREND_PULLBACK_TRIGGER_CONFIRM_SECONDS", 0)),
        trendPullbackMaxOrderAgeSeconds: Number(getArgValue("--trend-max-order-age-seconds") ?? envNumber("TREND_PULLBACK_MAX_ORDER_AGE_SECONDS", 0)),
        trendPullbackMaxBtcReversalBps: Number(getArgValue("--trend-max-btc-reversal-bps") ?? envNumber("TREND_PULLBACK_MAX_BTC_REVERSAL_BPS", 8)),
    };

    if (!cfg.csvPath) throw new Error(`Missing --csv <path> or BACKTEST_CSV\n\n${usage()}`);
    if (cfg.intervalMinutes <= 0) throw new Error("BACKTEST_INTERVAL_MINUTES must be > 0");
    if (cfg.volPerInterval <= 0) throw new Error("BACKTEST_VOL_PER_INTERVAL must be > 0");
    if (cfg.minEdge < 0) throw new Error("BACKTEST_MIN_EDGE must be >= 0");
    if (cfg.edgeMinMoveBps < 0) throw new Error("BACKTEST_EDGE_MIN_MOVE_BPS must be >= 0");
    if (cfg.edgeMinElapsedSeconds < 0) throw new Error("BACKTEST_EDGE_MIN_ELAPSED_SECONDS must be >= 0");
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
    if (cfg.managedMinSecondsLeftToOpen < 0) throw new Error("MANAGED_EDGE_MIN_SECONDS_LEFT_TO_OPEN must be >= 0");
    if (cfg.managedMaxSecondsLeftToOpen < cfg.managedMinSecondsLeftToOpen) throw new Error("MANAGED_EDGE_MAX_SECONDS_LEFT_TO_OPEN must be >= MANAGED_EDGE_MIN_SECONDS_LEFT_TO_OPEN");
    if (cfg.managedNoCheapBuySecondsLeft < 0) throw new Error("MANAGED_EDGE_NO_CHEAP_BUY_SECONDS_LEFT must be >= 0");
    if (!(cfg.managedMinCheapPrice >= 0 && cfg.managedMinCheapPrice <= 1)) throw new Error("MANAGED_EDGE_MIN_CHEAP_PRICE must be between 0 and 1");
    if (!(cfg.managedMinEntryPrice >= 0 && cfg.managedMinEntryPrice <= 1)) throw new Error("MANAGED_EDGE_MIN_ENTRY_PRICE must be between 0 and 1");
    if (cfg.managedTakeProfitPct < 0) throw new Error("MANAGED_EDGE_TAKE_PROFIT_PCT must be >= 0");
    if (!(cfg.managedTakeProfitSellRatio > 0 && cfg.managedTakeProfitSellRatio <= 1)) throw new Error("MANAGED_EDGE_TAKE_PROFIT_SELL_RATIO must be > 0 and <= 1");
    if (cfg.managedStopLossPct < 0) throw new Error("MANAGED_EDGE_STOP_LOSS_PCT must be >= 0");
    if (cfg.managedForceExitSecondsLeft < 0) throw new Error("MANAGED_EDGE_FORCE_EXIT_SECONDS_LEFT must be >= 0");
    if (!(cfg.managedMinExitPrice >= 0 && cfg.managedMinExitPrice <= 1)) throw new Error("MANAGED_EDGE_MIN_EXIT_PRICE must be between 0 and 1");
    if (cfg.adaptiveUndervalueScoreThreshold < 0) throw new Error("ADAPTIVE_EDGE_UNDERVALUE_SCORE_THRESHOLD must be >= 0");
    if (cfg.adaptiveMaxRequiredSigma < 0) throw new Error("ADAPTIVE_EDGE_MAX_REQUIRED_SIGMA must be >= 0");
    if (cfg.adaptiveMomentumMinBps < 0) throw new Error("ADAPTIVE_EDGE_MOMENTUM_MIN_BPS must be >= 0");
    if (cfg.adaptiveRequiredSigmaPenalty < 0) throw new Error("ADAPTIVE_EDGE_REQUIRED_SIGMA_PENALTY must be >= 0");
    if (cfg.adaptiveLateTimePenalty < 0) throw new Error("ADAPTIVE_EDGE_LATE_TIME_PENALTY must be >= 0");
    if (!(cfg.trendPullbackTriggerPrice > 0 && cfg.trendPullbackTriggerPrice < 1)) throw new Error("TREND_PULLBACK_TRIGGER_PRICE must be between 0 and 1");
    if (!(cfg.trendPullbackEntryPrice > 0 && cfg.trendPullbackEntryPrice < cfg.trendPullbackTriggerPrice)) throw new Error("TREND_PULLBACK_ENTRY_PRICE must be > 0 and below TREND_PULLBACK_TRIGGER_PRICE");
    if (cfg.trendPullbackOrderUsdc <= 0) throw new Error("TREND_PULLBACK_ORDER_USDC must be > 0");
    if (cfg.trendPullbackMaxUsdcPerLeg < 0) throw new Error("TREND_PULLBACK_MAX_USDC_PER_LEG must be >= 0");
    if (cfg.trendPullbackMinSecondsLeftToTrigger < 0) throw new Error("TREND_PULLBACK_MIN_SECONDS_LEFT_TO_TRIGGER must be >= 0");
    if (cfg.trendPullbackTriggerConfirmSeconds < 0) throw new Error("TREND_PULLBACK_TRIGGER_CONFIRM_SECONDS must be >= 0");
    if (cfg.trendPullbackMaxOrderAgeSeconds < 0) throw new Error("TREND_PULLBACK_MAX_ORDER_AGE_SECONDS must be >= 0");
    if (cfg.trendPullbackMaxBtcReversalBps < 0) throw new Error("TREND_PULLBACK_MAX_BTC_REVERSAL_BPS must be >= 0");
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
    const result: MarketRow[] = [];
    for (let idx = 0; idx < records.length; idx++) {
        const record = records[idx];
        const timestampMs = parseTimestamp(pick(record, ["timestamp_ms", "timestamp", "time", "ts", "datetime", "date"]));
        const btcPrice = parseNumber(pick(record, ["btc_price", "btc", "index_price", "underlying_price", "price"]));
        const upAsk = parseNumber(pick(record, ["up_ask", "ask_up", "upask", "yes_ask"]));
        const downAsk = parseNumber(pick(record, ["down_ask", "ask_down", "downask", "no_ask"]));
        if (timestampMs === undefined) {
            continue; // skip rows with missing timestamp
        }
        if (upAsk === undefined || downAsk === undefined) {
            // Still include resolution rows or rows that can update winner/finalPrice
            const rowType = pick(record, ["row_type", "type"]) ?? "sample";
            if (rowType !== "resolution") continue;
        }
        const startMs = Math.floor(timestampMs / intervalMs) * intervalMs;
        const upTokenId = pick(record, ["up_token_id", "up_token", "yes_token_id"]);
        const downTokenId = pick(record, ["down_token_id", "down_token", "no_token_id"]);
        result.push({
            timestampMs,
            rowType: pick(record, ["row_type", "type"]) ?? "sample",
            slug: pick(record, ["slug", "market", "market_slug"]) ?? `cycle-${Math.floor(startMs / 1000)}`,
            btcPrice,
            upAsk: upAsk ?? 0,
            downAsk: downAsk ?? 0,
            upBid: parseNumber(pick(record, ["up_bid", "bid_up", "upbid", "yes_bid"])),
            downBid: parseNumber(pick(record, ["down_bid", "bid_down", "downbid", "no_bid"])),
            upMid: parseNumber(pick(record, ["up_mid", "mid_up", "upmid", "yes_mid"])),
            downMid: parseNumber(pick(record, ["down_mid", "mid_down", "downmid", "no_mid"])),
            openPrice: parseNumber(pick(record, ["open_price", "cycle_open", "start_price"])),
            winningOutcome: parseWinningOutcome(pick(record, ["winning_outcome", "winner", "outcome"])),
            winningAssetId: pick(record, ["winning_asset_id", "winning_token_id"]),
            upTokenId,
            downTokenId,
        });
    }
    return result.sort((a, b) => a.timestampMs - b.timestampMs);
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
            costUp: 0,
            costDown: 0,
            trades: [],
        };
        if (!cycles.has(row.slug)) cycles.set(row.slug, cycle);
        if (row.btcPrice !== undefined) cycle.finalPrice = row.btcPrice;
        updateWinner(cycle, row);

        const secondsLeft = (cycle.endMs - row.timestampMs) / 1000;
        if (secondsLeft < cfg.minSecondsLeft) continue;
        if (row.btcPrice === undefined || cycle.openPrice === undefined) continue;

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
                minMoveBps: cfg.edgeMinMoveBps,
                minElapsedSeconds: cfg.edgeMinElapsedSeconds,
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

function settleManagedCycles(cycles: Map<string, CycleState>): void {
    for (const cycle of cycles.values()) {
        const winner = inferWinner(cycle);
        if (winner === "UP" && cycle.inventoryUp > 0) {
            cycle.trades.push({
                slug: cycle.slug,
                timestampMs: cycle.endMs,
                leg: "UP",
                price: 1,
                shares: cycle.inventoryUp,
                cost: 0,
                finalPrice: cycle.finalPrice,
                payout: cycle.inventoryUp,
                pnl: cycle.inventoryUp,
                note: "managed-edge settlement",
            });
        }
        if (winner === "DOWN" && cycle.inventoryDown > 0) {
            cycle.trades.push({
                slug: cycle.slug,
                timestampMs: cycle.endMs,
                leg: "DOWN",
                price: 1,
                shares: cycle.inventoryDown,
                cost: 0,
                finalPrice: cycle.finalPrice,
                payout: cycle.inventoryDown,
                pnl: cycle.inventoryDown,
                note: "managed-edge settlement",
            });
        }
        for (const trade of cycle.trades) {
            trade.finalPrice = trade.finalPrice ?? cycle.finalPrice;
        }
    }
}

function runManagedEdgeBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;
        if (row.btcPrice === undefined || cycle.openPrice === undefined) continue;

        const decision = buildBtc5mManagedEdgeOrders({
            timestampMs: row.timestampMs,
            endMs: cycle.endMs,
            btcPrice: row.btcPrice,
            openPrice: cycle.openPrice,
            up: { bestBid: row.upBid, bestAsk: row.upAsk, mid: row.upMid },
            down: { bestBid: row.downBid, bestAsk: row.downAsk, mid: row.downMid },
            positions: {
                UP: { shares: cycle.inventoryUp, cost: cycle.costUp, tookProfit: cycle.tookProfitUp },
                DOWN: { shares: cycle.inventoryDown, cost: cycle.costDown, tookProfit: cycle.tookProfitDown },
            },
            params: {
                intervalMinutes: cfg.intervalMinutes,
                volPerInterval: cfg.volPerInterval,
                minEdge: cfg.minEdge,
                minMoveBps: cfg.edgeMinMoveBps,
                minElapsedSeconds: cfg.edgeMinElapsedSeconds,
                orderUsdc: cfg.orderUsdc,
                maxUsdcPerLeg: cfg.maxUsdcPerLeg,
                maxPrice: cfg.maxPrice,
                minSecondsLeftToOpen: cfg.managedMinSecondsLeftToOpen,
                maxSecondsLeftToOpen: cfg.managedMaxSecondsLeftToOpen,
                noCheapBuySecondsLeft: cfg.managedNoCheapBuySecondsLeft,
                minCheapPrice: cfg.managedMinCheapPrice,
                minEntryPrice: cfg.managedMinEntryPrice,
                takeProfitPct: cfg.managedTakeProfitPct,
                takeProfitSellRatio: cfg.managedTakeProfitSellRatio,
                stopLossPct: cfg.managedStopLossPct,
                forceExitSecondsLeft: cfg.managedForceExitSecondsLeft,
                minExitPrice: cfg.managedMinExitPrice,
            },
        });
        applyManagedQuotes(cycle, row, decision.quotes);
    }
    settleManagedCycles(cycles);
    const cycleList = Array.from(cycles.values()).sort((a, b) => a.startMs - b.startMs);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function runAdaptiveEdgeBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    const historyByCycle = new Map<string, Btc5mRegimeSnapshot[]>();
    const regimeStats = { oscillating: 0, trending: 0, "panic-discount": 0, unknown: 0 };

    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;
        if (row.btcPrice === undefined || cycle.openPrice === undefined) continue;

        if (!historyByCycle.has(row.slug)) historyByCycle.set(row.slug, []);
        const history = historyByCycle.get(row.slug)!;
        if (row.upAsk > 0) {
            history.push({ t: row.timestampMs, upAsk: row.upAsk, downAsk: row.downAsk, btcPrice: row.btcPrice });
            const cutoff = row.timestampMs - cfg.adaptiveLookbackSeconds * 1000;
            while (history.length > 0 && history[0].t < cutoff) history.shift();
        }

        const decision = buildBtc5mAdaptiveEdgeOrders({
            timestampMs: row.timestampMs,
            endMs: cycle.endMs,
            btcPrice: row.btcPrice,
            openPrice: cycle.openPrice,
            up: { bestBid: row.upBid, bestAsk: row.upAsk, mid: row.upMid },
            down: { bestBid: row.downBid, bestAsk: row.downAsk, mid: row.downMid },
            positions: {
                UP: { shares: cycle.inventoryUp, cost: cycle.costUp, tookProfit: cycle.tookProfitUp },
                DOWN: { shares: cycle.inventoryDown, cost: cycle.costDown, tookProfit: cycle.tookProfitDown },
            },
            history,
            params: {
                intervalMinutes: cfg.intervalMinutes,
                volPerInterval: cfg.volPerInterval,
                minEdge: cfg.minEdge,
                minMoveBps: cfg.edgeMinMoveBps,
                minElapsedSeconds: cfg.edgeMinElapsedSeconds,
                orderUsdc: cfg.orderUsdc,
                maxUsdcPerLeg: cfg.maxUsdcPerLeg,
                maxPrice: cfg.maxPrice,
                lookbackSeconds: cfg.adaptiveLookbackSeconds,
                minHistoryPoints: cfg.adaptiveMinHistoryPoints,
                oscillationCrossCount: cfg.adaptiveOscillationCrossCount,
                oscillationChoppiness: cfg.adaptiveOscillationChoppiness,
                oscillationMaxBtcMoveBps: cfg.adaptiveOscillationMaxBtcMoveBps,
                trendMinBtcMoveBps: cfg.adaptiveTrendMinBtcMoveBps,
                trendMaxChoppiness: cfg.adaptiveTrendMaxChoppiness,
                panicMaxBtcMoveBps: cfg.adaptivePanicMaxBtcMoveBps,
                panicMinDiscount: cfg.adaptivePanicMinDiscount,
                panicMinAsk: cfg.adaptivePanicMinAsk,
                panicMaxAsk: cfg.adaptivePanicMaxAsk,
                undervalueScoreThreshold: cfg.adaptiveUndervalueScoreThreshold,
                maxRequiredSigma: cfg.adaptiveMaxRequiredSigma,
                momentumMinBps: cfg.adaptiveMomentumMinBps,
                fairMarketWeight: cfg.adaptiveFairMarketWeight,
                fairAskWeight: cfg.adaptiveFairAskWeight,
                percentileWeight: cfg.adaptivePercentileWeight,
                momentumDivergenceBonus: cfg.adaptiveMomentumDivergenceBonus,
                panicDiscountBonus: cfg.adaptivePanicDiscountBonus,
                requiredSigmaPenalty: cfg.adaptiveRequiredSigmaPenalty,
                lateTimePenalty: cfg.adaptiveLateTimePenalty,
                scalpProfitPrice: cfg.adaptiveScalpProfitPrice,
                scalpProfitPct: cfg.adaptiveScalpProfitPct,
                takeProfitPct: cfg.managedTakeProfitPct,
                takeProfitSellRatio: cfg.managedTakeProfitSellRatio,
                stopLossPct: cfg.managedStopLossPct,
                forceExitSecondsLeft: cfg.managedForceExitSecondsLeft,
                minExitPrice: cfg.managedMinExitPrice,
                minSecondsLeftToOpen: cfg.managedMinSecondsLeftToOpen,
                maxSecondsLeftToOpen: cfg.managedMaxSecondsLeftToOpen,
                minEntryPrice: cfg.managedMinEntryPrice,
                noCheapBuySecondsLeft: cfg.managedNoCheapBuySecondsLeft,
                minCheapPrice: cfg.managedMinCheapPrice,
            },
        });
        if (decision.metrics) regimeStats[decision.metrics.regime]++;
        applyManagedQuotes(cycle, row, decision.quotes);
    }

    settleManagedCycles(cycles);
    const total = Object.values(regimeStats).reduce((sum, value) => sum + value, 0);
    if (total > 0) {
        console.log(`Regime distribution: oscillating=${regimeStats.oscillating}, trending=${regimeStats.trending}, panic-discount=${regimeStats["panic-discount"]}, unknown=${regimeStats.unknown}`);
    }
    const cycleList = Array.from(cycles.values()).sort((a, b) => a.startMs - b.startMs);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
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

function runTrendPullbackBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    const states = new Map<string, Btc5mTrendPullbackState>();
    let triggeredCycles = 0;
    let filledCycles = 0;
    let cancelledCycles = 0;

    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;

        const previousState = states.get(row.slug) ?? {};
        const decision = buildBtc5mTrendPullbackOrders({
            timestampMs: row.timestampMs,
            endMs: cycle.endMs,
            upAsk: row.upAsk,
            downAsk: row.downAsk,
            btcPrice: row.btcPrice,
            spentUp: cycle.spentUp,
            spentDown: cycle.spentDown,
            state: previousState,
            params: {
                triggerPrice: cfg.trendPullbackTriggerPrice,
                entryPrice: cfg.trendPullbackEntryPrice,
                orderUsdc: cfg.trendPullbackOrderUsdc,
                maxUsdcPerLeg: cfg.trendPullbackMaxUsdcPerLeg,
                minSecondsLeftToTrigger: cfg.trendPullbackMinSecondsLeftToTrigger,
                triggerConfirmSeconds: cfg.trendPullbackTriggerConfirmSeconds,
                maxOrderAgeSeconds: cfg.trendPullbackMaxOrderAgeSeconds,
                maxBtcReversalBps: cfg.trendPullbackMaxBtcReversalBps,
            },
        });
        if (!previousState.triggeredLeg && decision.state.triggeredLeg) triggeredCycles++;
        if (!previousState.cancelled && decision.state.cancelled) cancelledCycles++;

        const quote = decision.quotes[0];
        const ask = quote?.leg === "UP" ? row.upAsk : row.downAsk;
        const isLaterSnapshot = decision.state.triggeredAtMs !== undefined && row.timestampMs > decision.state.triggeredAtMs;
        if (quote && quote.side === "BUY" && isLaterSnapshot && ask > 0 && ask <= quote.price) {
            buyAtPrice(cycle, row, quote.leg, quote.price, quote.price * quote.size, quote.fair, quote.edge, quote.note);
            decision.state = { ...decision.state, filled: true };
            filledCycles++;
        }
        states.set(row.slug, decision.state);
    }

    settleCycles(cycles);
    console.log(`Trend-pullback orders: triggered=${triggeredCycles}, filled=${filledCycles}, cancelled=${cancelledCycles}, fill rate=${triggeredCycles ? (filledCycles / triggeredCycles * 100).toFixed(2) : "0.00"}%`);
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
            costUp: 0,
            costDown: 0,
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
        cycle.costUp += cost;
    } else {
        cycle.spentDown += cost;
        cycle.inventoryDown += shares;
        cycle.costDown += cost;
    }
}

function sellAtPrice(cycle: CycleState, row: MarketRow, leg: Leg, price: number, shares: number, fair?: number, edge?: number, note?: string): void {
    const available = leg === "UP" ? cycle.inventoryUp : cycle.inventoryDown;
    const size = Math.min(shares, available);
    if (size <= 0) return;
    const proceeds = price * size;
    cycle.trades.push({
        slug: cycle.slug,
        timestampMs: row.timestampMs,
        leg,
        price,
        shares: size,
        cost: 0,
        fair,
        edge,
        openPrice: cycle.openPrice,
        btcPrice: row.btcPrice,
        payout: proceeds,
        pnl: proceeds,
        note,
    });
    if (leg === "UP") {
        const avgCost = cycle.inventoryUp > 0 ? cycle.costUp / cycle.inventoryUp : 0;
        cycle.inventoryUp -= size;
        cycle.costUp = Math.max(0, cycle.costUp - avgCost * size);
        if (note?.includes("take-profit")) cycle.tookProfitUp = true;
    } else {
        const avgCost = cycle.inventoryDown > 0 ? cycle.costDown / cycle.inventoryDown : 0;
        cycle.inventoryDown -= size;
        cycle.costDown = Math.max(0, cycle.costDown - avgCost * size);
        if (note?.includes("take-profit")) cycle.tookProfitDown = true;
    }
}

function applyBuyQuotes(cycle: CycleState, row: MarketRow, quotes: Btc5mStrategyQuote[], note: string): void {
    for (const quote of quotes) {
        if (quote.side !== "BUY") continue;
        buyAtPrice(cycle, row, quote.leg, quote.price, quote.price * quote.size, quote.fair, quote.edge, note);
    }
}

function applyManagedQuotes(cycle: CycleState, row: MarketRow, quotes: Btc5mStrategyQuote[]): void {
    for (const quote of quotes) {
        if (quote.side === "BUY") {
            buyAtPrice(cycle, row, quote.leg, quote.price, quote.price * quote.size, quote.fair, quote.edge, quote.note ?? "managed-edge buy");
        } else {
            const note = quote.note ?? (quote.size < (quote.leg === "UP" ? cycle.inventoryUp : cycle.inventoryDown) ? "managed-edge take-profit sell" : "managed-edge exit sell");
            sellAtPrice(cycle, row, quote.leg, quote.price, quote.size, quote.fair, quote.edge, note);
        }
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
    if (cfg.strategy === "trend-pullback") {
        console.log(`Params: trigger=${cfg.trendPullbackTriggerPrice}, entry=${cfg.trendPullbackEntryPrice}, orderUsdc=${cfg.trendPullbackOrderUsdc}, confirmSeconds=${cfg.trendPullbackTriggerConfirmSeconds}, maxOrderAgeSeconds=${cfg.trendPullbackMaxOrderAgeSeconds}, maxBtcReversalBps=${cfg.trendPullbackMaxBtcReversalBps}`);
    } else {
        console.log(`Params: minEdge=${cfg.minEdge}, orderUsdc=${cfg.orderUsdc}, maxUsdcPerLeg=${cfg.maxUsdcPerLeg}, volPerInterval=${cfg.volPerInterval}`);
    }
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

function runHybridBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    // Maintain a sliding window of price snapshots per cycle for regime detection
    const cycleHistory = new Map<string, PriceSnapshot[]>();

    let regimeStats = { oscillating: 0, trending: 0, unknown: 0 };

    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;
        const secondsLeft = (cycle.endMs - row.timestampMs) / 1000;
        if (secondsLeft < cfg.minSecondsLeft) continue;

        // Build price history for this cycle
        if (!cycleHistory.has(row.slug)) cycleHistory.set(row.slug, []);
        const history = cycleHistory.get(row.slug)!;
        if (row.upAsk > 0) {
            history.push({ t: row.timestampMs, upAsk: row.upAsk });
            // Trim to lookback window
            const cutoff = row.timestampMs - cfg.hybridLookbackSeconds * 1000;
            while (history.length > 0 && history[0].t < cutoff) history.shift();
        }

        const decision = buildBtc5mHybridOrders({
            timestampMs: row.timestampMs,
            endMs: cycle.endMs,
            btcPrice: row.btcPrice,
            openPrice: cycle.openPrice,
            upAsk: row.upAsk,
            downAsk: row.downAsk,
            spentUp: cycle.spentUp,
            spentDown: cycle.spentDown,
            hasUpPosition: cycle.spentUp > 0,
            hasDownPosition: cycle.spentDown > 0,
            params: {
                lookbackSeconds: cfg.hybridLookbackSeconds,
                oscillationThreshold: cfg.hybridOscillationThreshold,
                rangeThreshold: cfg.hybridRangeThreshold,
                trendThreshold: cfg.hybridTrendThreshold,
                edge: {
                    intervalMinutes: cfg.intervalMinutes,
                    volPerInterval: cfg.volPerInterval,
                    minEdge: cfg.minEdge,
                    minMoveBps: cfg.edgeMinMoveBps,
                    minElapsedSeconds: cfg.edgeMinElapsedSeconds,
                    orderUsdc: cfg.orderUsdc,
                    maxUsdcPerLeg: cfg.maxUsdcPerLeg,
                    maxPrice: cfg.maxPrice,
                },
                rangeArb: {
                    priceX: cfg.rangePriceX,
                    usdcPerLeg: cfg.rangeUsdcPerLeg,
                },
            },
            priceHistory: history,
        });

        regimeStats[decision.regime]++;
        const note = decision.reason ?? `hybrid:${decision.regime}`;
        applyBuyQuotes(cycle, row, decision.quotes, note);
    }

    settleCycles(cycles);
    const cycleList = Array.from(cycles.values()).sort((a, b) => a.startMs - b.startMs);
    const total = regimeStats.oscillating + regimeStats.trending + regimeStats.unknown;
    if (total > 0) {
        console.log(`Regime distribution: oscillating=${regimeStats.oscillating} (${(regimeStats.oscillating / total * 100).toFixed(1)}%), trending=${regimeStats.trending} (${(regimeStats.trending / total * 100).toFixed(1)}%), unknown=${regimeStats.unknown} (${(regimeStats.unknown / total * 100).toFixed(1)}%)`);
    }
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
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
        case "hybrid":
            return runHybridBacktest(rows, cfg);
        case "managed-edge":
            return runManagedEdgeBacktest(rows, cfg);
        case "adaptive-edge":
            return runAdaptiveEdgeBacktest(rows, cfg);
        case "trend-pullback":
            return runTrendPullbackBacktest(rows, cfg);
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
