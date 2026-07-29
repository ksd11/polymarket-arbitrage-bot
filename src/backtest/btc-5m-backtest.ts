import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { buildBtc5mEdgeOrders } from "../strategies/btc5m/edge";
import { buildBtc5mMarketMakerQuotes } from "../strategies/btc5m/market-maker";
import { buildBtc5mConditionalMarketMakerQuotes, Btc5mConditionalMarketMakerSample } from "../strategies/btc5m/conditional-market-maker";
import { buildBtc5mRangeArbOrders } from "../strategies/btc5m/range-arb";
import { buildBtc5mHybridOrders, PriceSnapshot } from "../strategies/btc5m/hybrid";
import { buildBtc5mManagedEdgeOrders } from "../strategies/btc5m/managed-edge";
import { buildBtc5mAdaptiveEdgeOrders } from "../strategies/btc5m/adaptive-edge";
import { buildBtc5mTrendPullbackOrders, Btc5mTrendPullbackState } from "../strategies/btc5m/trend-pullback";
import { classifyPreviousCycleRegime } from "../strategies/btc5m/trend-range-regime";
import { buildBtc5mRangePairOrders, Btc5mRangePairState } from "../strategies/btc5m/range-pair";
import { buildBtc5mSustainedHighOrders, Btc5mSustainedHighState } from "../strategies/btc5m/sustained-high";
import { buildBtc5mLatencyScalpOrders, Btc5mLatencyScalpState } from "../strategies/btc5m/latency-scalp";
import { buildBtc5mDeepReboundOrders } from "../strategies/btc5m/deep-rebound";
import { buildBtc5mExtreme020ReboundOrders, Btc5mExtreme020Position } from "../strategies/btc5m/extreme-020-rebound";
import { buildBtc5mFinal30HighOrders } from "../strategies/btc5m/final-30-high";
import { buildBtc5mFinal30HedgedOrders, Btc5mFinal30HedgedPosition } from "../strategies/btc5m/final-30-hedged";
import { buildBtc5mFinal30ManagedOrders, Btc5mFinal30ManagedPosition } from "../strategies/btc5m/final-30-managed";
import { buildBtc5mDynamicRangePullbackOrders, Btc5mDynamicRangePullbackParams, Btc5mDynamicRangePullbackState } from "../strategies/btc5m/dynamic-range-pullback";
import { buildBtc5mDynamicRangeFinalManagedOrders } from "../strategies/btc5m/dynamic-range-final-managed";
import { Btc5mRegimeSnapshot } from "../strategies/btc5m/regime";
import { Btc5mStrategyQuote } from "../strategies/btc5m/types";

type Leg = "UP" | "DOWN";
type BacktestStrategy = "edge" | "range-arb" | "market-maker" | "conditional-market-maker" | "hybrid" | "managed-edge" | "adaptive-edge" | "trend-pullback" | "trend-range-switch" | "trend-range-regime" | "trend-range-overlay" | "adaptive-overlay" | "sustained-high" | "latency-scalp" | "deep-rebound" | "extreme-020-rebound" | "final-30-high" | "final-30-hedged" | "final-30-managed" | "dynamic-range-pullback" | "dynamic-range-final-managed";

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
    conditionalMmLookbackSeconds: number;
    conditionalMmAccelerationLookbackSeconds: number;
    conditionalMmMaxRangeBps: number;
    conditionalMmMaxTrendBps: number;
    conditionalMmMaxTrendEfficiency: number;
    conditionalMmTrendEfficiencyMinMomentumBps: number;
    conditionalMmMaxAccelerationBps: number;
    conditionalMmDirectionMinMomentumBps: number;
    conditionalMmFavoredPriceImprove: number;
    conditionalMmUnfavoredPriceOffset: number;
    conditionalMmFavoredSizeMultiplier: number;
    conditionalMmUnfavoredSizeMultiplier: number;
    conditionalMmMaxNetInventoryShares: number;
    conditionalMmMinOrderUsdc: number;
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
    trendPullbackMinSecondsLeftToFill: number;
    trendPullbackTriggerConfirmSeconds: number;
    trendPullbackMaxOrderAgeSeconds: number;
    trendPullbackMaxBtcReversalBps: number;
    trendPullbackPostFillStopLossPrice: number;
    trendPullbackPostFillTakeProfitPrice: number;
    trendPullbackPostFillMaxBtcReversalBps: number;
    trendRangeSwitchFailures: number;
    trendRangeRegimeBandLower: number;
    trendRangeRegimeBandUpper: number;
    trendRangeRegimeMinBandRatio: number;
    trendRangeRegimeMinCrossCount: number;
    trendRangeRegimeMinPriceRange: number;
    trendRangeRegimeCenterBuffer: number;
    trendRangeRegimeMinChoppiness: number;
    trendRangeRegimeIgnoreFinalSeconds: number;
    trendRangeRegimeMinSamples: number;
    trendRangeRegimeRangePrice: number;
    trendRangeRegimeRangeUsdcPerLeg: number;
    trendRangeOverlayRangeFirstPrice: number;
    trendRangeOverlayRangeSecondPrice: number;
    trendRangeOverlayMaxTotalUsdc: number;
    trendRangeOverlayTrendTakeProfitPrice: number;
    sustainedHighTriggerPrice: number;
    sustainedHighConfirmSeconds: number;
    sustainedHighEntryPrice: number;
    sustainedHighOrderUsdc: number;
    sustainedHighMaxSecondsLeftToTrigger: number;
    sustainedHighMinSecondsLeftToTrigger: number;
    sustainedHighMinSecondsLeftToFill: number;
    sustainedHighMaxOrderAgeSeconds: number;
    sustainedHighMinBtcMoveBps: number;
    sustainedHighMaxBtcReversalBps: number;
    latencyScalpMinSignalPrice: number;
    latencyScalpTriggerConfirmSeconds: number;
    latencyScalpSignalLookbackSeconds: number;
    latencyScalpMinContractMomentum: number;
    latencyScalpMinBtcMomentumBps: number;
    latencyScalpEntryPrice: number;
    latencyScalpTakeProfitPrice: number;
    latencyScalpOrderUsdc: number;
    latencyScalpMaxSecondsLeftToTrigger: number;
    latencyScalpMinSecondsLeftToTrigger: number;
    latencyScalpMaxEntryOrderAgeSeconds: number;
    latencyScalpMaxHoldSeconds: number;
    latencyScalpMinBtcMoveBps: number;
    latencyScalpMaxBtcReversalBps: number;
    latencyScalpStopLossPrice: number;
    latencyScalpForceExitSecondsLeft: number;
    deepReboundMinEntryPrice: number;
    deepReboundMaxEntryPrice: number;
    deepReboundOrderUsdc: number;
    deepReboundMaxUsdcPerLeg: number;
    deepReboundScoreThreshold: number;
    deepReboundMinDiscount: number;
    deepReboundTakeProfitPrice: number;
    deepReboundStopLossPct: number;
    deepReboundMinSecondsLeftToOpen: number;
    deepReboundMaxSecondsLeftToOpen: number;
    deepReboundForceExitSecondsLeft: number;
    extreme020EntryThreshold: number;
    extreme020TakeProfitDelta: number;
    extreme020OrderUsdc: number;
    extreme020MinSecondsLeftToOpen: number;
    extreme020MaxSecondsLeftToOpen: number;
    extreme020StopLossPct: number;
    extreme020MaxHoldSeconds: number;
    extreme020ForceExitSecondsLeft: number;
    final30HighTriggerPrice: number;
    final30HighEarlyTriggerPrice: number;
    final30HighMaxEntryPrice: number;
    final30HighOrderShares: number;
    final30HighMaxSecondsLeftToOpen: number;
    final30HighEarlyMaxSecondsLeftToOpen: number;
    final30HighMinSecondsLeftToOpen: number;
    final30HedgedMaxPairCost: number;
    final30ManagedEarlyBtcMinMoveUsd: number;
    final30ManagedEarlyBtcMinAsk: number;
    final30ManagedEarlyBtcMaxSecondsLeft: number;
    final30ManagedTakeProfitDelta: number;
    final30ManagedStopLossDelta: number;
    final30ManagedStopMinBtcReversalBps: number;
    final30ManagedStopConfirmSeconds: number;
    final30ManagedStopMaxDirectionalMarginBps: number;
    dynamicRangePullbackParams: Btc5mDynamicRangePullbackParams;
    adaptiveOverlayDeepInRange: boolean;
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

function booleanValue(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    return value.trim().toLowerCase() === "true";
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
        "  npm run backtest:btc5m -- --strategy <edge|managed-edge|adaptive-edge|trend-pullback|sustained-high|latency-scalp|deep-rebound|extreme-020-rebound|final-30-high|final-30-hedged|final-30-managed|dynamic-range-pullback|dynamic-range-final-managed|trend-range-switch|trend-range-regime|trend-range-overlay|adaptive-overlay|range-arb|market-maker|conditional-market-maker|hybrid> --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:edge --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:range-arb --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:market-maker --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:conditional-market-maker --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:managed-edge --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:trend-pullback --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:sustained-high --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:latency-scalp --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:deep-rebound --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:extreme-020-rebound --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:final-30-high --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:final-30-hedged --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:final-30-managed --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:dynamic-range-pullback --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:dynamic-range-final-managed --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:adaptive-overlay --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:trend-range-switch --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:trend-range-regime --csv <path>",
        "  npm run backtest:btc5m -- --strategy btc5m:trend-range-overlay --csv <path>",
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
        "  --trend-order-usdc <number>   Trend-pullback cost per filled cycle; default 1.6",
        "  --sustained-high-trigger <p>  Sustained-high threshold; default 0.90",
        "  --sustained-high-confirm <s>  Required continuous duration; default 10",
        "  --sustained-high-entry <p>    BUY limit after confirmation; default 0.90",
        "  --switch-failures <count>     Trend/range consecutive-loss threshold; default 2",
    ].join("\n");
}

function parseStrategy(value: string | undefined): BacktestStrategy {
    if (value === "edge" || value === "btc5m:edge") return "edge";
    if (value === "range-arb" || value === "btc5m:range-arb") return "range-arb";
    if (value === "market-maker" || value === "btc5m:market-maker") return "market-maker";
    if (value === "conditional-market-maker" || value === "btc5m:conditional-market-maker") return "conditional-market-maker";
    if (value === "hybrid" || value === "btc5m:hybrid") return "hybrid";
    if (value === "managed-edge" || value === "btc5m:managed-edge") return "managed-edge";
    if (value === "adaptive-edge" || value === "btc5m:adaptive-edge") return "adaptive-edge";
    if (value === "trend-pullback" || value === "btc5m:trend-pullback") return "trend-pullback";
    if (value === "trend-range-switch" || value === "btc5m:trend-range-switch") return "trend-range-switch";
    if (value === "trend-range-regime" || value === "btc5m:trend-range-regime") return "trend-range-regime";
    if (value === "trend-range-overlay" || value === "btc5m:trend-range-overlay") return "trend-range-overlay";
    if (value === "sustained-high" || value === "btc5m:sustained-high") return "sustained-high";
    if (value === "latency-scalp" || value === "btc5m:latency-scalp") return "latency-scalp";
    if (value === "deep-rebound" || value === "btc5m:deep-rebound") return "deep-rebound";
    if (value === "extreme-020-rebound" || value === "btc5m:extreme-020-rebound") return "extreme-020-rebound";
    if (value === "final-30-high" || value === "btc5m:final-30-high") return "final-30-high";
    if (value === "final-30-hedged" || value === "btc5m:final-30-hedged") return "final-30-hedged";
    if (value === "final-30-managed" || value === "btc5m:final-30-managed") return "final-30-managed";
    if (value === "dynamic-range-pullback" || value === "btc5m:dynamic-range-pullback") return "dynamic-range-pullback";
    if (value === "dynamic-range-final-managed" || value === "btc5m:dynamic-range-final-managed") return "dynamic-range-final-managed";
    if (value === "adaptive-overlay" || value === "btc5m:adaptive-overlay") return "adaptive-overlay";
    throw new Error(`Unsupported or missing strategy: ${value || "(empty)"}\n\n${usage()}`);
}

function loadConfig(): BacktestConfig {
    if (hasArg("--help") || hasArg("-h")) {
        console.log(usage());
        process.exit(0);
    }

    const strategyArg = getArgValue("--strategy") ?? envString("BACKTEST_STRATEGY", "");
    const csvPath = getArgValue("--csv") ?? envString("BACKTEST_CSV", "");
    const strategy = parseStrategy(strategyArg);
    const finalManaged = strategy === "final-30-managed";
    const cfg: BacktestConfig = {
        strategy,
        csvPath,
        outputTradesPath: getArgValue("--out") ?? envString("BACKTEST_TRADES_OUT", "logs/backtest-btc5m-trades.csv"),
        intervalMinutes: Number(getArgValue("--interval-minutes") ?? envNumber("BACKTEST_INTERVAL_MINUTES", envNumber("BTC5M_INTERVAL_MINUTES", 5))),
        volPerInterval: Number(getArgValue("--vol-per-interval") ?? envNumber("BACKTEST_VOL_PER_INTERVAL", 0.0015)),
        minEdge: Number(getArgValue("--min-edge") ?? envNumber("BACKTEST_MIN_EDGE", 0.03)),
        edgeMinMoveBps: Number(getArgValue("--edge-min-move-bps") ?? envNumber("BACKTEST_EDGE_MIN_MOVE_BPS", 0)),
        edgeMinElapsedSeconds: Number(getArgValue("--edge-min-elapsed") ?? envNumber("BACKTEST_EDGE_MIN_ELAPSED_SECONDS", 0)),
        orderUsdc: Number(getArgValue("--order-usdc") ?? envNumber("BACKTEST_ORDER_USDC", 5)),
        maxUsdcPerLeg: Number(getArgValue("--max-usdc-per-leg") ?? envNumber("BACKTEST_MAX_USDC_PER_LEG", 10)),
        minSecondsLeft: Number(getArgValue("--min-seconds-left") ?? ((strategy === "market-maker" || strategy === "conditional-market-maker") ? envNumber("MM_MIN_SECONDS_LEFT_TO_QUOTE", 45) : envNumber("BACKTEST_MIN_SECONDS_LEFT", 10))),
        maxPrice: Number(getArgValue("--max-price") ?? envNumber("BACKTEST_MAX_PRICE", 0.98)),
        rangePriceX: Number(getArgValue("--range-price-x") ?? envNumber("RANGE_ARB_PRICE_X", 0.4)),
        rangeUsdcPerLeg: Number(getArgValue("--range-usdc-per-leg") ?? envNumber("RANGE_ARB_USDC_PER_LEG", 5)),
        marketMakerQuoteShares: Number(getArgValue("--mm-quote-shares") ?? envNumber("MM_QUOTE_SHARES", 5)),
        marketMakerQuoteSpread: Number(getArgValue("--mm-quote-spread") ?? envNumber("MM_QUOTE_SPREAD", 0.06)),
        marketMakerMinLockedEdge: Number(getArgValue("--mm-min-locked-edge") ?? envNumber("MM_MIN_LOCKED_EDGE", 0.02)),
        marketMakerInventorySkewPerShare: Number(getArgValue("--mm-inventory-skew-per-share") ?? envNumber("MM_INVENTORY_SKEW_PER_SHARE", 0.002)),
        marketMakerMaxUsdcPerLeg: Number(getArgValue("--mm-max-usdc-per-leg") ?? (strategy === "conditional-market-maker" ? envNumber("CONDITIONAL_MM_MAX_USDC_PER_LEG", 2) : envNumber("MM_MAX_USDC_PER_LEG", 0))),
        marketMakerMaxInventoryShares: Number(getArgValue("--mm-max-inventory-shares") ?? (strategy === "conditional-market-maker" ? envNumber("CONDITIONAL_MM_MAX_INVENTORY_SHARES", 10) : envNumber("MM_MAX_INVENTORY_SHARES", 30))),
        conditionalMmLookbackSeconds: Number(getArgValue("--cmm-lookback") ?? envNumber("CONDITIONAL_MM_LOOKBACK_SECONDS", 15)),
        conditionalMmAccelerationLookbackSeconds: Number(getArgValue("--cmm-acceleration-lookback") ?? envNumber("CONDITIONAL_MM_ACCELERATION_LOOKBACK_SECONDS", 2)),
        conditionalMmMaxRangeBps: Number(getArgValue("--cmm-max-range-bps") ?? envNumber("CONDITIONAL_MM_MAX_RANGE_BPS", 15)),
        conditionalMmMaxTrendBps: Number(getArgValue("--cmm-max-trend-bps") ?? envNumber("CONDITIONAL_MM_MAX_TREND_BPS", 8)),
        conditionalMmMaxTrendEfficiency: Number(getArgValue("--cmm-max-trend-efficiency") ?? envNumber("CONDITIONAL_MM_MAX_TREND_EFFICIENCY", 0.65)),
        conditionalMmTrendEfficiencyMinMomentumBps: Number(getArgValue("--cmm-trend-efficiency-min-momentum-bps") ?? envNumber("CONDITIONAL_MM_TREND_EFFICIENCY_MIN_MOMENTUM_BPS", 2)),
        conditionalMmMaxAccelerationBps: Number(getArgValue("--cmm-max-acceleration-bps") ?? envNumber("CONDITIONAL_MM_MAX_ACCELERATION_BPS", 4)),
        conditionalMmDirectionMinMomentumBps: Number(getArgValue("--cmm-direction-min-momentum-bps") ?? envNumber("CONDITIONAL_MM_DIRECTION_MIN_MOMENTUM_BPS", 999)),
        conditionalMmFavoredPriceImprove: Number(getArgValue("--cmm-favored-price-improve") ?? envNumber("CONDITIONAL_MM_FAVORED_PRICE_IMPROVE", 0)),
        conditionalMmUnfavoredPriceOffset: Number(getArgValue("--cmm-unfavored-price-offset") ?? envNumber("CONDITIONAL_MM_UNFAVORED_PRICE_OFFSET", 0)),
        conditionalMmFavoredSizeMultiplier: Number(getArgValue("--cmm-favored-size-multiplier") ?? envNumber("CONDITIONAL_MM_FAVORED_SIZE_MULTIPLIER", 1)),
        conditionalMmUnfavoredSizeMultiplier: Number(getArgValue("--cmm-unfavored-size-multiplier") ?? envNumber("CONDITIONAL_MM_UNFAVORED_SIZE_MULTIPLIER", 1)),
        conditionalMmMaxNetInventoryShares: Number(getArgValue("--cmm-max-net-inventory-shares") ?? envNumber("CONDITIONAL_MM_MAX_NET_INVENTORY_SHARES", 5)),
        conditionalMmMinOrderUsdc: Number(getArgValue("--cmm-min-order-usdc") ?? envNumber("CONDITIONAL_MM_MIN_ORDER_USDC", 1)),
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
        trendPullbackOrderUsdc: Number(getArgValue("--trend-order-usdc") ?? envNumber("TREND_PULLBACK_ORDER_USDC", 1.6)),
        trendPullbackMaxUsdcPerLeg: Number(getArgValue("--trend-max-usdc-per-leg") ?? envNumber("TREND_PULLBACK_MAX_USDC_PER_LEG", 1.6)),
        trendPullbackMinSecondsLeftToTrigger: Number(getArgValue("--trend-min-seconds-left-to-trigger") ?? envNumber("TREND_PULLBACK_MIN_SECONDS_LEFT_TO_TRIGGER", 30)),
        trendPullbackMinSecondsLeftToFill: Number(getArgValue("--trend-min-seconds-left-to-fill") ?? envNumber("TREND_PULLBACK_MIN_SECONDS_LEFT_TO_FILL", 0)),
        trendPullbackTriggerConfirmSeconds: Number(getArgValue("--trend-trigger-confirm-seconds") ?? envNumber("TREND_PULLBACK_TRIGGER_CONFIRM_SECONDS", 0)),
        trendPullbackMaxOrderAgeSeconds: Number(getArgValue("--trend-max-order-age-seconds") ?? envNumber("TREND_PULLBACK_MAX_ORDER_AGE_SECONDS", 8)),
        trendPullbackMaxBtcReversalBps: Number(getArgValue("--trend-max-btc-reversal-bps") ?? envNumber("TREND_PULLBACK_MAX_BTC_REVERSAL_BPS", 2)),
        trendPullbackPostFillStopLossPrice: Number(getArgValue("--trend-post-fill-stop-loss-price") ?? envNumber("TREND_PULLBACK_POST_FILL_STOP_LOSS_PRICE", 0)),
        trendPullbackPostFillTakeProfitPrice: Number(getArgValue("--trend-post-fill-take-profit-price") ?? envNumber("TREND_PULLBACK_POST_FILL_TAKE_PROFIT_PRICE", 0)),
        trendPullbackPostFillMaxBtcReversalBps: Number(getArgValue("--trend-post-fill-max-btc-reversal-bps") ?? envNumber("TREND_PULLBACK_POST_FILL_MAX_BTC_REVERSAL_BPS", 0)),
        trendRangeSwitchFailures: Number(getArgValue("--switch-failures") ?? envNumber("TREND_RANGE_SWITCH_FAILURES", 2)),
        trendRangeRegimeBandLower: Number(getArgValue("--regime-band-lower") ?? envNumber("TREND_RANGE_REGIME_BAND_LOWER", 0.30)),
        trendRangeRegimeBandUpper: Number(getArgValue("--regime-band-upper") ?? envNumber("TREND_RANGE_REGIME_BAND_UPPER", 0.70)),
        trendRangeRegimeMinBandRatio: Number(getArgValue("--regime-min-band-ratio") ?? envNumber("TREND_RANGE_REGIME_MIN_BAND_RATIO", 0.70)),
        trendRangeRegimeMinCrossCount: Number(getArgValue("--regime-min-cross-count") ?? envNumber("TREND_RANGE_REGIME_MIN_CROSS_COUNT", 3)),
        trendRangeRegimeMinPriceRange: Number(getArgValue("--regime-min-price-range") ?? envNumber("TREND_RANGE_REGIME_MIN_PRICE_RANGE", 0.15)),
        trendRangeRegimeCenterBuffer: Number(getArgValue("--regime-center-buffer") ?? envNumber("TREND_RANGE_REGIME_CENTER_BUFFER", 0.05)),
        trendRangeRegimeMinChoppiness: Number(getArgValue("--regime-min-choppiness") ?? envNumber("TREND_RANGE_REGIME_MIN_CHOPPINESS", 3)),
        trendRangeRegimeIgnoreFinalSeconds: Number(getArgValue("--regime-ignore-final-seconds") ?? envNumber("TREND_RANGE_REGIME_IGNORE_FINAL_SECONDS", 60)),
        trendRangeRegimeMinSamples: Number(getArgValue("--regime-min-samples") ?? envNumber("TREND_RANGE_REGIME_MIN_SAMPLES", 30)),
        trendRangeRegimeRangePrice: Number(getArgValue("--regime-range-price") ?? getArgValue("--range-price-x") ?? envNumber("TREND_RANGE_REGIME_RANGE_PRICE", 0.40)),
        trendRangeRegimeRangeUsdcPerLeg: Number(getArgValue("--regime-range-usdc-per-leg") ?? getArgValue("--range-usdc-per-leg") ?? envNumber("TREND_RANGE_REGIME_RANGE_USDC_PER_LEG", 0.80)),
        trendRangeOverlayRangeFirstPrice: Number(getArgValue("--overlay-range-first-price") ?? envNumber("TREND_RANGE_OVERLAY_RANGE_FIRST_PRICE", 0.40)),
        trendRangeOverlayRangeSecondPrice: Number(getArgValue("--overlay-range-second-price") ?? envNumber("TREND_RANGE_OVERLAY_RANGE_SECOND_PRICE", 0.40)),
        trendRangeOverlayMaxTotalUsdc: Number(getArgValue("--overlay-range-max-total-usdc") ?? envNumber("TREND_RANGE_OVERLAY_RANGE_MAX_TOTAL_USDC", 1.60)),
        trendRangeOverlayTrendTakeProfitPrice: Number(getArgValue("--overlay-trend-take-profit-price") ?? envNumber("TREND_RANGE_OVERLAY_TREND_TAKE_PROFIT_PRICE", 0)),
        sustainedHighTriggerPrice: Number(getArgValue("--sustained-high-trigger") ?? envNumber("SUSTAINED_HIGH_TRIGGER_PRICE", 0.90)),
        sustainedHighConfirmSeconds: Number(getArgValue("--sustained-high-confirm") ?? envNumber("SUSTAINED_HIGH_CONFIRM_SECONDS", 10)),
        sustainedHighEntryPrice: Number(getArgValue("--sustained-high-entry") ?? envNumber("SUSTAINED_HIGH_ENTRY_PRICE", 0.90)),
        sustainedHighOrderUsdc: Number(getArgValue("--sustained-high-order-usdc") ?? envNumber("SUSTAINED_HIGH_ORDER_USDC", 4.50)),
        sustainedHighMaxSecondsLeftToTrigger: Number(getArgValue("--sustained-high-max-seconds-left") ?? envNumber("SUSTAINED_HIGH_MAX_SECONDS_LEFT_TO_TRIGGER", 120)),
        sustainedHighMinSecondsLeftToTrigger: Number(getArgValue("--sustained-high-min-seconds-left") ?? envNumber("SUSTAINED_HIGH_MIN_SECONDS_LEFT_TO_TRIGGER", 20)),
        sustainedHighMinSecondsLeftToFill: Number(getArgValue("--sustained-high-min-seconds-left-to-fill") ?? envNumber("SUSTAINED_HIGH_MIN_SECONDS_LEFT_TO_FILL", 20)),
        sustainedHighMaxOrderAgeSeconds: Number(getArgValue("--sustained-high-max-order-age") ?? envNumber("SUSTAINED_HIGH_MAX_ORDER_AGE_SECONDS", 0)),
        sustainedHighMinBtcMoveBps: Number(getArgValue("--sustained-high-min-btc-move-bps") ?? envNumber("SUSTAINED_HIGH_MIN_BTC_MOVE_BPS", 3)),
        sustainedHighMaxBtcReversalBps: Number(getArgValue("--sustained-high-max-btc-reversal-bps") ?? envNumber("SUSTAINED_HIGH_MAX_BTC_REVERSAL_BPS", 2)),
        latencyScalpMinSignalPrice: Number(getArgValue("--latency-scalp-min-signal-price") ?? envNumber("LATENCY_SCALP_MIN_SIGNAL_PRICE", 0.72)),
        latencyScalpTriggerConfirmSeconds: Number(getArgValue("--latency-scalp-confirm") ?? envNumber("LATENCY_SCALP_TRIGGER_CONFIRM_SECONDS", 2)),
        latencyScalpSignalLookbackSeconds: Number(getArgValue("--latency-scalp-signal-lookback") ?? envNumber("LATENCY_SCALP_SIGNAL_LOOKBACK_SECONDS", 5)),
        latencyScalpMinContractMomentum: Number(getArgValue("--latency-scalp-min-contract-momentum") ?? envNumber("LATENCY_SCALP_MIN_CONTRACT_MOMENTUM", 0.03)),
        latencyScalpMinBtcMomentumBps: Number(getArgValue("--latency-scalp-min-btc-momentum-bps") ?? envNumber("LATENCY_SCALP_MIN_BTC_MOMENTUM_BPS", 0)),
        latencyScalpEntryPrice: Number(getArgValue("--latency-scalp-entry") ?? envNumber("LATENCY_SCALP_ENTRY_PRICE", 0.75)),
        latencyScalpTakeProfitPrice: Number(getArgValue("--latency-scalp-take-profit") ?? envNumber("LATENCY_SCALP_TAKE_PROFIT_PRICE", 0.80)),
        latencyScalpOrderUsdc: Number(getArgValue("--latency-scalp-order-usdc") ?? envNumber("LATENCY_SCALP_ORDER_USDC", 3.75)),
        latencyScalpMaxSecondsLeftToTrigger: Number(getArgValue("--latency-scalp-max-seconds-left") ?? envNumber("LATENCY_SCALP_MAX_SECONDS_LEFT_TO_TRIGGER", 180)),
        latencyScalpMinSecondsLeftToTrigger: Number(getArgValue("--latency-scalp-min-seconds-left") ?? envNumber("LATENCY_SCALP_MIN_SECONDS_LEFT_TO_TRIGGER", 45)),
        latencyScalpMaxEntryOrderAgeSeconds: Number(getArgValue("--latency-scalp-max-entry-age") ?? envNumber("LATENCY_SCALP_MAX_ENTRY_ORDER_AGE_SECONDS", 15)),
        latencyScalpMaxHoldSeconds: Number(getArgValue("--latency-scalp-max-hold") ?? envNumber("LATENCY_SCALP_MAX_HOLD_SECONDS", 30)),
        latencyScalpMinBtcMoveBps: Number(getArgValue("--latency-scalp-min-btc-move-bps") ?? envNumber("LATENCY_SCALP_MIN_BTC_MOVE_BPS", 3)),
        latencyScalpMaxBtcReversalBps: Number(getArgValue("--latency-scalp-max-btc-reversal-bps") ?? envNumber("LATENCY_SCALP_MAX_BTC_REVERSAL_BPS", 3)),
        latencyScalpStopLossPrice: Number(getArgValue("--latency-scalp-stop-loss") ?? envNumber("LATENCY_SCALP_STOP_LOSS_PRICE", 0.70)),
        latencyScalpForceExitSecondsLeft: Number(getArgValue("--latency-scalp-force-exit-seconds-left") ?? envNumber("LATENCY_SCALP_FORCE_EXIT_SECONDS_LEFT", 20)),
        deepReboundMinEntryPrice: Number(getArgValue("--deep-rebound-min-entry") ?? envNumber("DEEP_REBOUND_MIN_ENTRY_PRICE", 0.03)),
        deepReboundMaxEntryPrice: Number(getArgValue("--deep-rebound-max-entry") ?? envNumber("DEEP_REBOUND_MAX_ENTRY_PRICE", 0.10)),
        deepReboundOrderUsdc: Number(getArgValue("--deep-rebound-order-usdc") ?? envNumber("DEEP_REBOUND_ORDER_USDC", 1.01)),
        deepReboundMaxUsdcPerLeg: Number(getArgValue("--deep-rebound-max-usdc-per-leg") ?? envNumber("DEEP_REBOUND_MAX_USDC_PER_LEG", 1.01)),
        deepReboundScoreThreshold: Number(getArgValue("--deep-rebound-score") ?? envNumber("DEEP_REBOUND_SCORE_THRESHOLD", 0.20)),
        deepReboundMinDiscount: Number(getArgValue("--deep-rebound-min-discount") ?? envNumber("DEEP_REBOUND_MIN_DISCOUNT", 0.05)),
        deepReboundTakeProfitPrice: Number(getArgValue("--deep-rebound-take-profit") ?? envNumber("DEEP_REBOUND_TAKE_PROFIT_PRICE", 0.05)),
        deepReboundStopLossPct: Number(getArgValue("--deep-rebound-stop-loss-pct") ?? envNumber("DEEP_REBOUND_STOP_LOSS_PCT", 0.50)),
        deepReboundMinSecondsLeftToOpen: Number(getArgValue("--deep-rebound-min-seconds-left") ?? envNumber("DEEP_REBOUND_MIN_SECONDS_LEFT_TO_OPEN", 60)),
        deepReboundMaxSecondsLeftToOpen: Number(getArgValue("--deep-rebound-max-seconds-left") ?? envNumber("DEEP_REBOUND_MAX_SECONDS_LEFT_TO_OPEN", 240)),
        deepReboundForceExitSecondsLeft: Number(getArgValue("--deep-rebound-force-exit-seconds-left") ?? envNumber("DEEP_REBOUND_FORCE_EXIT_SECONDS_LEFT", 30)),
        extreme020EntryThreshold: Number(getArgValue("--extreme-020-entry") ?? envNumber("EXTREME_020_REBOUND_ENTRY_THRESHOLD", 0.18)),
        extreme020TakeProfitDelta: Number(getArgValue("--extreme-020-take-profit") ?? envNumber("EXTREME_020_REBOUND_TAKE_PROFIT_DELTA", 0)),
        extreme020OrderUsdc: Number(getArgValue("--extreme-020-order-usdc") ?? envNumber("EXTREME_020_REBOUND_ORDER_USDC", 1.01)),
        extreme020MinSecondsLeftToOpen: Number(getArgValue("--extreme-020-min-seconds-left") ?? envNumber("EXTREME_020_REBOUND_MIN_SECONDS_LEFT_TO_OPEN", 120)),
        extreme020MaxSecondsLeftToOpen: Number(getArgValue("--extreme-020-max-seconds-left") ?? envNumber("EXTREME_020_REBOUND_MAX_SECONDS_LEFT_TO_OPEN", 300)),
        extreme020StopLossPct: Number(getArgValue("--extreme-020-stop-loss-pct") ?? envNumber("EXTREME_020_REBOUND_STOP_LOSS_PCT", 0)),
        extreme020MaxHoldSeconds: Number(getArgValue("--extreme-020-max-hold-seconds") ?? envNumber("EXTREME_020_REBOUND_MAX_HOLD_SECONDS", 0)),
        extreme020ForceExitSecondsLeft: Number(getArgValue("--extreme-020-force-exit-seconds-left") ?? envNumber("EXTREME_020_REBOUND_FORCE_EXIT_SECONDS_LEFT", 0)),
        final30HighTriggerPrice: Number(getArgValue("--final-30-high-trigger") ?? envNumber(finalManaged ? "FINAL_30_MANAGED_TRIGGER_PRICE" : "FINAL_30_HIGH_TRIGGER_PRICE", 0.85)),
        final30HighEarlyTriggerPrice: Number(getArgValue("--final-30-high-early-trigger") ?? envNumber(finalManaged ? "FINAL_30_MANAGED_EARLY_TRIGGER_PRICE" : "FINAL_30_HIGH_EARLY_TRIGGER_PRICE", 0.90)),
        final30HighMaxEntryPrice: Number(getArgValue("--final-30-high-max-entry-price") ?? envNumber(finalManaged ? "FINAL_30_MANAGED_MAX_ENTRY_PRICE" : "FINAL_30_HIGH_MAX_ENTRY_PRICE", 0.90)),
        final30HighOrderShares: Number(getArgValue("--final-30-high-shares") ?? envNumber(finalManaged ? "FINAL_30_MANAGED_ORDER_SHARES" : "FINAL_30_HIGH_ORDER_SHARES", finalManaged ? 5 : 2)),
        final30HighMaxSecondsLeftToOpen: Number(getArgValue("--final-30-high-max-seconds-left") ?? envNumber(finalManaged ? "FINAL_30_MANAGED_MAX_SECONDS_LEFT_TO_OPEN" : "FINAL_30_HIGH_MAX_SECONDS_LEFT_TO_OPEN", 30)),
        final30HighEarlyMaxSecondsLeftToOpen: Number(getArgValue("--final-30-high-early-max-seconds-left") ?? envNumber(finalManaged ? "FINAL_30_MANAGED_EARLY_MAX_SECONDS_LEFT_TO_OPEN" : "FINAL_30_HIGH_EARLY_MAX_SECONDS_LEFT_TO_OPEN", 30)),
        final30HighMinSecondsLeftToOpen: Number(getArgValue("--final-30-high-min-seconds-left") ?? envNumber(finalManaged ? "FINAL_30_MANAGED_MIN_SECONDS_LEFT_TO_OPEN" : "FINAL_30_HIGH_MIN_SECONDS_LEFT_TO_OPEN", 0)),
        final30HedgedMaxPairCost: Number(getArgValue("--final-30-hedged-max-pair-cost") ?? envNumber("FINAL_30_HEDGED_MAX_PAIR_COST", 0.95)),
        final30ManagedEarlyBtcMinMoveUsd: Number(getArgValue("--final-30-managed-early-btc-move-usd") ?? envNumber("FINAL_30_MANAGED_EARLY_BTC_MIN_MOVE_USD", 0)),
        final30ManagedEarlyBtcMinAsk: Number(getArgValue("--final-30-managed-early-btc-min-ask") ?? envNumber("FINAL_30_MANAGED_EARLY_BTC_MIN_ASK", 0.85)),
        final30ManagedEarlyBtcMaxSecondsLeft: Number(getArgValue("--final-30-managed-early-btc-max-seconds-left") ?? envNumber("FINAL_30_MANAGED_EARLY_BTC_MAX_SECONDS_LEFT", 60)),
        final30ManagedTakeProfitDelta: Number(getArgValue("--final-30-managed-take-profit-delta") ?? envNumber("FINAL_30_MANAGED_TAKE_PROFIT_DELTA", 0)),
        final30ManagedStopLossDelta: Number(getArgValue("--final-30-managed-stop-loss-delta") ?? envNumber("FINAL_30_MANAGED_STOP_LOSS_DELTA", 0.10)),
        final30ManagedStopMinBtcReversalBps: Number(getArgValue("--final-30-managed-stop-min-btc-reversal-bps") ?? envNumber("FINAL_30_MANAGED_STOP_MIN_BTC_REVERSAL_BPS", 2)),
        final30ManagedStopConfirmSeconds: Number(getArgValue("--final-30-managed-stop-confirm-seconds") ?? envNumber("FINAL_30_MANAGED_STOP_CONFIRM_SECONDS", 2)),
        final30ManagedStopMaxDirectionalMarginBps: Number(getArgValue("--final-30-managed-stop-max-margin-bps") ?? envNumber("FINAL_30_MANAGED_STOP_MAX_DIRECTIONAL_MARGIN_BPS", 999)),
        dynamicRangePullbackParams: {
            minContractPullback: envNumber("DYNAMIC_RANGE_PULLBACK_MIN_CONTRACT_PULLBACK", 0.20),
            minOrderNotional: envNumber("DYNAMIC_RANGE_PULLBACK_MIN_ORDER_NOTIONAL", 1.01),
            orderShares: envNumber("DYNAMIC_RANGE_PULLBACK_ORDER_SHARES", 2),
            syntheticSell: booleanValue(process.env.DYNAMIC_RANGE_PULLBACK_SYNTHETIC_SELL, true),
            dynamicSizing: booleanValue(process.env.DYNAMIC_RANGE_PULLBACK_DYNAMIC_SIZING, true),
            maxPairUsdc: envNumber("DYNAMIC_RANGE_PULLBACK_MAX_PAIR_USDC", 8),
            minLockedProfit: envNumber("DYNAMIC_RANGE_PULLBACK_MIN_LOCKED_PROFIT", 0.05),
            shareStep: envNumber("DYNAMIC_RANGE_PULLBACK_SHARE_STEP", 0.0001),
            minSecondsLeftToOpen: envNumber("DYNAMIC_RANGE_PULLBACK_MIN_SECONDS_LEFT_TO_OPEN", 60),
            maxSecondsLeftToOpen: envNumber("DYNAMIC_RANGE_PULLBACK_MAX_SECONDS_LEFT_TO_OPEN", 300),
            minDirectionalBtcMarginBps: envNumber("DYNAMIC_RANGE_PULLBACK_MIN_BTC_MARGIN_BPS", 2),
            maxBtcRetracementBps: envNumber("DYNAMIC_RANGE_PULLBACK_MAX_BTC_RETRACEMENT_BPS", 3),
            maxSpread: envNumber("DYNAMIC_RANGE_PULLBACK_MAX_SPREAD", 0.03),
            entryConfirmSeconds: envNumber("DYNAMIC_RANGE_PULLBACK_ENTRY_CONFIRM_SECONDS", 2),
            earlyPairCost: envNumber("DYNAMIC_RANGE_PULLBACK_EARLY_PAIR_COST", 0.85),
            middlePairCost: envNumber("DYNAMIC_RANGE_PULLBACK_MIDDLE_PAIR_COST", 0.90),
            latePairCost: envNumber("DYNAMIC_RANGE_PULLBACK_LATE_PAIR_COST", 0.95),
            earlyPairSecondsLeft: envNumber("DYNAMIC_RANGE_PULLBACK_EARLY_PAIR_SECONDS_LEFT", 120),
            middlePairSecondsLeft: envNumber("DYNAMIC_RANGE_PULLBACK_MIDDLE_PAIR_SECONDS_LEFT", 60),
            stopLossDelta: envNumber("DYNAMIC_RANGE_PULLBACK_STOP_LOSS_DELTA", 0.10),
            stopConfirmSeconds: envNumber("DYNAMIC_RANGE_PULLBACK_STOP_CONFIRM_SECONDS", 2),
            maxNakedSeconds: envNumber("DYNAMIC_RANGE_PULLBACK_MAX_NAKED_SECONDS", 60),
        },
        adaptiveOverlayDeepInRange: booleanValue(getArgValue("--adaptive-overlay-deep-in-range") ?? process.env.ADAPTIVE_OVERLAY_DEEP_IN_RANGE, true),
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
    if (cfg.conditionalMmLookbackSeconds <= 0 || cfg.conditionalMmAccelerationLookbackSeconds <= 0 || cfg.conditionalMmAccelerationLookbackSeconds > cfg.conditionalMmLookbackSeconds) throw new Error("Invalid conditional market-maker lookback");
    if (cfg.conditionalMmMaxRangeBps <= 0 || cfg.conditionalMmMaxTrendBps <= 0 || cfg.conditionalMmMaxAccelerationBps <= 0 || cfg.conditionalMmTrendEfficiencyMinMomentumBps < 0 || cfg.conditionalMmDirectionMinMomentumBps < 0) throw new Error("Invalid conditional market-maker BTC thresholds");
    if (!(cfg.conditionalMmMaxTrendEfficiency > 0 && cfg.conditionalMmMaxTrendEfficiency <= 1)) throw new Error("CONDITIONAL_MM_MAX_TREND_EFFICIENCY must be between 0 and 1");
    if (cfg.conditionalMmFavoredPriceImprove < 0 || cfg.conditionalMmUnfavoredPriceOffset < 0 || cfg.conditionalMmFavoredSizeMultiplier <= 0 || cfg.conditionalMmUnfavoredSizeMultiplier <= 0 || cfg.conditionalMmMaxNetInventoryShares <= 0 || cfg.conditionalMmMinOrderUsdc <= 0 || cfg.conditionalMmMinOrderUsdc > cfg.marketMakerMaxUsdcPerLeg) throw new Error("Invalid conditional market-maker skew, inventory, or order-size parameters");
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
    if (cfg.trendPullbackMinSecondsLeftToFill < 0) throw new Error("TREND_PULLBACK_MIN_SECONDS_LEFT_TO_FILL must be >= 0");
    if (cfg.trendPullbackTriggerConfirmSeconds < 0) throw new Error("TREND_PULLBACK_TRIGGER_CONFIRM_SECONDS must be >= 0");
    if (cfg.trendPullbackMaxOrderAgeSeconds < 0) throw new Error("TREND_PULLBACK_MAX_ORDER_AGE_SECONDS must be >= 0");
    if (cfg.trendPullbackMaxBtcReversalBps < 0) throw new Error("TREND_PULLBACK_MAX_BTC_REVERSAL_BPS must be >= 0");
    if (!(cfg.trendPullbackPostFillStopLossPrice >= 0 && cfg.trendPullbackPostFillStopLossPrice < cfg.trendPullbackEntryPrice)) throw new Error("TREND_PULLBACK_POST_FILL_STOP_LOSS_PRICE must be >= 0 and below entry price");
    if (!(cfg.trendPullbackPostFillTakeProfitPrice >= 0 && cfg.trendPullbackPostFillTakeProfitPrice <= 1)) throw new Error("TREND_PULLBACK_POST_FILL_TAKE_PROFIT_PRICE must be between 0 and 1");
    if (cfg.trendPullbackPostFillMaxBtcReversalBps < 0) throw new Error("TREND_PULLBACK_POST_FILL_MAX_BTC_REVERSAL_BPS must be >= 0");
    if (!Number.isInteger(cfg.trendRangeSwitchFailures) || cfg.trendRangeSwitchFailures < 1) throw new Error("TREND_RANGE_SWITCH_FAILURES must be a positive integer");
    if (!(cfg.trendRangeRegimeBandLower >= 0 && cfg.trendRangeRegimeBandLower < cfg.trendRangeRegimeBandUpper && cfg.trendRangeRegimeBandUpper <= 1)) throw new Error("Trend-range regime band must satisfy 0 <= lower < upper <= 1");
    if (!(cfg.trendRangeRegimeMinBandRatio >= 0 && cfg.trendRangeRegimeMinBandRatio <= 1)) throw new Error("TREND_RANGE_REGIME_MIN_BAND_RATIO must be between 0 and 1");
    if (!Number.isInteger(cfg.trendRangeRegimeMinCrossCount) || cfg.trendRangeRegimeMinCrossCount < 0) throw new Error("TREND_RANGE_REGIME_MIN_CROSS_COUNT must be a non-negative integer");
    if (cfg.trendRangeRegimeMinPriceRange < 0 || cfg.trendRangeRegimeIgnoreFinalSeconds < 0) throw new Error("Trend-range regime range/time parameters must be >= 0");
    if (!(cfg.trendRangeRegimeCenterBuffer >= 0 && cfg.trendRangeRegimeCenterBuffer < 0.5)) throw new Error("TREND_RANGE_REGIME_CENTER_BUFFER must be between 0 and 0.5");
    if (cfg.trendRangeRegimeMinChoppiness < 0) throw new Error("TREND_RANGE_REGIME_MIN_CHOPPINESS must be >= 0");
    if (!Number.isInteger(cfg.trendRangeRegimeMinSamples) || cfg.trendRangeRegimeMinSamples < 2) throw new Error("TREND_RANGE_REGIME_MIN_SAMPLES must be an integer >= 2");
    if (!(cfg.trendRangeRegimeRangePrice > 0 && cfg.trendRangeRegimeRangePrice < 0.5)) throw new Error("TREND_RANGE_REGIME_RANGE_PRICE must be between 0 and 0.5");
    if (cfg.trendRangeRegimeRangeUsdcPerLeg <= 0) throw new Error("TREND_RANGE_REGIME_RANGE_USDC_PER_LEG must be > 0");
    if (!(cfg.trendRangeOverlayRangeFirstPrice > 0 && cfg.trendRangeOverlayRangeFirstPrice < 0.5)) throw new Error("TREND_RANGE_OVERLAY_RANGE_FIRST_PRICE must be between 0 and 0.5");
    if (!(cfg.trendRangeOverlayRangeSecondPrice >= cfg.trendRangeOverlayRangeFirstPrice && cfg.trendRangeOverlayRangeFirstPrice + cfg.trendRangeOverlayRangeSecondPrice < 1)) throw new Error("Overlay range prices must satisfy second >= first and first + second < 1");
    if (cfg.trendRangeOverlayMaxTotalUsdc <= 0) throw new Error("TREND_RANGE_OVERLAY_RANGE_MAX_TOTAL_USDC must be > 0");
    if (!(cfg.trendRangeOverlayTrendTakeProfitPrice >= 0 && cfg.trendRangeOverlayTrendTakeProfitPrice <= 1)) throw new Error("TREND_RANGE_OVERLAY_TREND_TAKE_PROFIT_PRICE must be between 0 and 1");
    if (!(cfg.sustainedHighTriggerPrice > 0 && cfg.sustainedHighTriggerPrice < 1)) throw new Error("SUSTAINED_HIGH_TRIGGER_PRICE must be between 0 and 1");
    if (cfg.sustainedHighConfirmSeconds < 0) throw new Error("SUSTAINED_HIGH_CONFIRM_SECONDS must be >= 0");
    if (!(cfg.sustainedHighEntryPrice > 0 && cfg.sustainedHighEntryPrice <= cfg.sustainedHighTriggerPrice)) throw new Error("SUSTAINED_HIGH_ENTRY_PRICE must be > 0 and <= trigger price");
    if (cfg.sustainedHighOrderUsdc <= 0) throw new Error("SUSTAINED_HIGH_ORDER_USDC must be > 0");
    if (cfg.sustainedHighMaxSecondsLeftToTrigger < 0 || cfg.sustainedHighMinSecondsLeftToTrigger < 0 || cfg.sustainedHighMinSecondsLeftToFill < 0 || cfg.sustainedHighMaxOrderAgeSeconds < 0) throw new Error("Sustained-high time parameters must be >= 0");
    if (cfg.sustainedHighMinBtcMoveBps < 0 || cfg.sustainedHighMaxBtcReversalBps < 0) throw new Error("Sustained-high BTC parameters must be >= 0");
    if (!(cfg.latencyScalpMinSignalPrice > 0 && cfg.latencyScalpMinSignalPrice <= cfg.latencyScalpEntryPrice && cfg.latencyScalpTakeProfitPrice > cfg.latencyScalpEntryPrice && cfg.latencyScalpTakeProfitPrice < 1)) throw new Error("Latency-scalp prices must satisfy 0 < signal <= entry < take-profit < 1");
    if (cfg.latencyScalpOrderUsdc <= 0 || cfg.latencyScalpMaxEntryOrderAgeSeconds <= 0 || cfg.latencyScalpMaxHoldSeconds <= 0) throw new Error("Invalid latency-scalp budget or duration");
    if (!(cfg.latencyScalpStopLossPrice > 0 && cfg.latencyScalpStopLossPrice < cfg.latencyScalpEntryPrice)) throw new Error("Latency-scalp stop loss must be below entry");
    if (cfg.latencyScalpTriggerConfirmSeconds < 0 || cfg.latencyScalpSignalLookbackSeconds <= 0 || cfg.latencyScalpMinContractMomentum < 0 || cfg.latencyScalpMinBtcMomentumBps < 0) throw new Error("Invalid latency-scalp signal parameters");
    if (!(cfg.deepReboundMinEntryPrice > 0 && cfg.deepReboundMinEntryPrice < cfg.deepReboundMaxEntryPrice && cfg.deepReboundMaxEntryPrice < 1)) throw new Error("Invalid deep-rebound entry range");
    if (cfg.deepReboundOrderUsdc <= 0 || cfg.deepReboundMaxUsdcPerLeg < cfg.deepReboundOrderUsdc || cfg.deepReboundScoreThreshold < 0 || cfg.deepReboundTakeProfitPrice <= 0) throw new Error("Invalid deep-rebound risk parameters");
    if (!(cfg.extreme020EntryThreshold > 0 && cfg.extreme020EntryThreshold < 1) || cfg.extreme020TakeProfitDelta < 0 || cfg.extreme020EntryThreshold + cfg.extreme020TakeProfitDelta >= 1) throw new Error("Invalid extreme-020-rebound prices");
    if (cfg.extreme020OrderUsdc <= 0 || cfg.extreme020MinSecondsLeftToOpen < 0 || cfg.extreme020MaxSecondsLeftToOpen <= cfg.extreme020MinSecondsLeftToOpen) throw new Error("Invalid extreme-020-rebound budget or entry window");
    if (!(cfg.extreme020StopLossPct >= 0 && cfg.extreme020StopLossPct < 1) || cfg.extreme020MaxHoldSeconds < 0 || cfg.extreme020ForceExitSecondsLeft < 0) throw new Error("Invalid extreme-020-rebound exit controls");
    if (!(cfg.final30HighTriggerPrice > 0.5 && cfg.final30HighTriggerPrice < 1 && cfg.final30HighEarlyTriggerPrice >= cfg.final30HighTriggerPrice && cfg.final30HighEarlyTriggerPrice <= cfg.final30HighMaxEntryPrice && cfg.final30HighMaxEntryPrice < 1) || cfg.final30HighOrderShares <= 0) throw new Error("Invalid final-30-high price or size");
    if (cfg.final30HighMinSecondsLeftToOpen < 0 || cfg.final30HighMaxSecondsLeftToOpen <= cfg.final30HighMinSecondsLeftToOpen || cfg.final30HighEarlyMaxSecondsLeftToOpen < cfg.final30HighMaxSecondsLeftToOpen) throw new Error("Invalid final-30-high entry window");
    if (!(cfg.final30HedgedMaxPairCost > 0 && cfg.final30HedgedMaxPairCost < 1)) throw new Error("FINAL_30_HEDGED_MAX_PAIR_COST must be between 0 and 1");
    if (cfg.final30ManagedEarlyBtcMinMoveUsd < 0 || cfg.final30ManagedEarlyBtcMinAsk <= 0.5 || cfg.final30ManagedEarlyBtcMinAsk > cfg.final30HighMaxEntryPrice || cfg.final30ManagedEarlyBtcMaxSecondsLeft <= cfg.final30HighMaxSecondsLeftToOpen) throw new Error("Invalid final-30-managed early BTC configuration");
    if (!(cfg.final30ManagedTakeProfitDelta >= 0 && cfg.final30ManagedTakeProfitDelta < 1) || !(cfg.final30ManagedStopLossDelta >= 0 && cfg.final30ManagedStopLossDelta < 1)) throw new Error("Invalid final-30-managed exit deltas");
    if (cfg.final30ManagedStopMinBtcReversalBps < 0 || cfg.final30ManagedStopConfirmSeconds < 0 || cfg.final30ManagedStopMaxDirectionalMarginBps < 0) throw new Error("Invalid final-30-managed BTC stop confirmation");
    const dynamic = cfg.dynamicRangePullbackParams;
    if (!(dynamic.minContractPullback > 0 && dynamic.minContractPullback < 1) || dynamic.minOrderNotional <= 0 || dynamic.orderShares <= 0 || dynamic.maxPairUsdc < dynamic.minOrderNotional * 2 || dynamic.minLockedProfit < 0 || dynamic.shareStep <= 0 || dynamic.minSecondsLeftToOpen < 0 || dynamic.maxSecondsLeftToOpen <= dynamic.minSecondsLeftToOpen || dynamic.minDirectionalBtcMarginBps < 0 || dynamic.maxBtcRetracementBps < 0 || dynamic.maxSpread <= 0 || dynamic.entryConfirmSeconds < 0 || !(dynamic.earlyPairCost > 0 && dynamic.earlyPairCost <= dynamic.middlePairCost && dynamic.middlePairCost <= dynamic.latePairCost && dynamic.latePairCost < 1) || !(dynamic.stopLossDelta > 0 && dynamic.stopLossDelta < 1) || dynamic.stopConfirmSeconds < 0 || dynamic.maxNakedSeconds < 0) throw new Error("Invalid dynamic-range-pullback configuration");
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

function runDeepReboundBacktest(rows: MarketRow[], cfg: BacktestConfig, logSummary = true): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    const historyByCycle = new Map<string, Btc5mRegimeSnapshot[]>();
    let signals = 0;

    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution" || row.btcPrice === undefined || cycle.openPrice === undefined) continue;
        if (!historyByCycle.has(row.slug)) historyByCycle.set(row.slug, []);
        const history = historyByCycle.get(row.slug)!;
        history.push({ t: row.timestampMs, upAsk: row.upAsk, downAsk: row.downAsk, btcPrice: row.btcPrice });
        const cutoff = row.timestampMs - 60_000;
        while (history.length > 0 && history[0].t < cutoff) history.shift();

        const decision = buildBtc5mDeepReboundOrders({
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
                minEntryPrice: cfg.deepReboundMinEntryPrice,
                maxEntryPrice: cfg.deepReboundMaxEntryPrice,
                orderUsdc: cfg.deepReboundOrderUsdc,
                maxUsdcPerLeg: cfg.deepReboundMaxUsdcPerLeg,
                scoreThreshold: cfg.deepReboundScoreThreshold,
                minDiscount: cfg.deepReboundMinDiscount,
                takeProfitPrice: cfg.deepReboundTakeProfitPrice,
                stopLossPct: cfg.deepReboundStopLossPct,
                minSecondsLeftToOpen: cfg.deepReboundMinSecondsLeftToOpen,
                maxSecondsLeftToOpen: cfg.deepReboundMaxSecondsLeftToOpen,
                forceExitSecondsLeft: cfg.deepReboundForceExitSecondsLeft,
            },
        });
        if (decision.quotes.some((quote) => quote.side === "BUY")) signals++;
        applyManagedQuotes(cycle, row, decision.quotes);
    }

    settleManagedCycles(cycles);
    if (logSummary) console.log(`Deep-rebound signals: ${signals}`);
    const cycleList = Array.from(cycles.values()).sort((left, right) => left.startMs - right.startMs);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function runExtreme020ReboundBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    const states = new Map<string, Record<Leg, Btc5mExtreme020Position>>();
    let entries = 0;
    let takeProfits = 0;
    let stopLosses = 0;
    let timeStops = 0;
    let forceExits = 0;

    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;
        const state = states.get(row.slug) ?? {
            UP: { shares: 0, cost: 0, entered: false, exited: false },
            DOWN: { shares: 0, cost: 0, entered: false, exited: false },
        };
        state.UP.shares = cycle.inventoryUp;
        state.UP.cost = cycle.costUp;
        state.DOWN.shares = cycle.inventoryDown;
        state.DOWN.cost = cycle.costDown;
        const decision = buildBtc5mExtreme020ReboundOrders({
            timestampMs: row.timestampMs,
            endMs: cycle.endMs,
            upAsk: row.upAsk,
            downAsk: row.downAsk,
            upBid: row.upBid,
            downBid: row.downBid,
            positions: state,
            params: {
                entryThreshold: cfg.extreme020EntryThreshold,
                takeProfitDelta: cfg.extreme020TakeProfitDelta,
                orderUsdc: cfg.extreme020OrderUsdc,
                minSecondsLeftToOpen: cfg.extreme020MinSecondsLeftToOpen,
                maxSecondsLeftToOpen: cfg.extreme020MaxSecondsLeftToOpen,
                stopLossPct: cfg.extreme020StopLossPct,
                maxHoldSeconds: cfg.extreme020MaxHoldSeconds,
                forceExitSecondsLeft: cfg.extreme020ForceExitSecondsLeft,
            },
        });
        for (const quote of decision.quotes) {
            const legState = state[quote.leg];
            if (quote.side === "BUY" && !legState.entered) {
                const ask = quote.leg === "UP" ? row.upAsk : row.downAsk;
                if (ask <= 0 || ask > quote.price) continue;
                buyAtPrice(cycle, row, quote.leg, ask, ask * quote.size, quote.fair, quote.edge, `${quote.note}; limit=${quote.price.toFixed(2)}`);
                legState.entered = true;
                legState.enteredAtMs = row.timestampMs;
                legState.shares = quote.size;
                legState.cost = ask * quote.size;
                entries++;
            } else if (quote.side === "SELL" && !legState.exited) {
                const bid = quote.leg === "UP" ? row.upBid : row.downBid;
                if (bid === undefined || bid < quote.price) continue;
                sellAtPrice(cycle, row, quote.leg, quote.price, quote.size, quote.fair, quote.edge, quote.note);
                legState.exited = true;
                legState.shares = 0;
                legState.cost = 0;
                if (quote.note?.includes("take-profit")) takeProfits++;
                else if (quote.note?.includes("stop-loss")) stopLosses++;
                else if (quote.note?.includes("time-stop")) timeStops++;
                else forceExits++;
            }
        }
        states.set(row.slug, state);
    }

    settleManagedCycles(cycles);
    console.log(`Extreme-020-rebound: entries=${entries}, takeProfits=${takeProfits}, stopLosses=${stopLosses}, timeStops=${timeStops}, forceExits=${forceExits}, takeProfitRate=${entries ? (takeProfits / entries * 100).toFixed(2) : "0.00"}%`);
    const cycleList = Array.from(cycles.values()).sort((left, right) => left.startMs - right.startMs);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function runFinal30HighBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    const entered = new Set<string>();
    const blocked = new Set<string>();
    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;
        const decision = buildBtc5mFinal30HighOrders({
            timestampMs: row.timestampMs,
            endMs: cycle.endMs,
            upAsk: row.upAsk,
            downAsk: row.downAsk,
            entered: entered.has(row.slug) || blocked.has(row.slug),
            params: {
                triggerPrice: cfg.final30HighTriggerPrice,
                earlyTriggerPrice: cfg.final30HighEarlyTriggerPrice,
                maxEntryPrice: cfg.final30HighMaxEntryPrice,
                orderShares: cfg.final30HighOrderShares,
                maxSecondsLeftToOpen: cfg.final30HighMaxSecondsLeftToOpen,
                earlyMaxSecondsLeftToOpen: cfg.final30HighEarlyMaxSecondsLeftToOpen,
                minSecondsLeftToOpen: cfg.final30HighMinSecondsLeftToOpen,
            },
        });
        if (decision.reason?.includes("blocked:")) blocked.add(row.slug);
        const quote = decision.quotes[0];
        if (!quote || quote.side !== "BUY") continue;
        const ask = quote.leg === "UP" ? row.upAsk : row.downAsk;
        if (ask <= 0 || ask >= 1 || ask < cfg.final30HighTriggerPrice) continue;
        buyAtPrice(cycle, row, quote.leg, ask, ask * quote.size, quote.fair, quote.edge, quote.note);
        entered.add(row.slug);
    }
    settleCycles(cycles);
    const cycleList = Array.from(cycles.values()).sort((left, right) => left.startMs - right.startMs);
    const traded = cycleList.filter((cycle) => cycle.trades.length > 0);
    const winners = traded.filter((cycle) => cycle.trades.some((trade) => trade.pnl !== undefined && trade.pnl > 0)).length;
    console.log(`Final-30-high: entries=${traded.length}, winners=${winners}, winRate=${traded.length ? (winners / traded.length * 100).toFixed(2) : "0.00"}%`);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function runFinal30HedgedBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    const positions = new Map<string, Btc5mFinal30HedgedPosition>();
    const blocked = new Set<string>();
    let hedged = 0;
    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;
        const position = positions.get(row.slug);
        const decision = buildBtc5mFinal30HedgedOrders({
            timestampMs: row.timestampMs,
            endMs: cycle.endMs,
            upAsk: row.upAsk,
            downAsk: row.downAsk,
            position,
            blocked: blocked.has(row.slug),
            params: {
                triggerPrice: cfg.final30HighTriggerPrice,
                earlyTriggerPrice: cfg.final30HighEarlyTriggerPrice,
                maxEntryPrice: cfg.final30HighMaxEntryPrice,
                orderShares: cfg.final30HighOrderShares,
                maxSecondsLeftToOpen: cfg.final30HighMaxSecondsLeftToOpen,
                earlyMaxSecondsLeftToOpen: cfg.final30HighEarlyMaxSecondsLeftToOpen,
                minSecondsLeftToOpen: cfg.final30HighMinSecondsLeftToOpen,
                maxPairCost: cfg.final30HedgedMaxPairCost,
            },
        });
        if (!position && decision.reason?.includes("blocked:")) blocked.add(row.slug);
        const quote = decision.quotes[0];
        if (!quote || quote.side !== "BUY") continue;
        const ask = quote.leg === "UP" ? row.upAsk : row.downAsk;
        if (ask <= 0 || ask >= 1 || ask > quote.price + 1e-9) continue;
        buyAtPrice(cycle, row, quote.leg, ask, ask * quote.size, quote.fair, quote.edge, quote.note);
        if (!position) {
            positions.set(row.slug, { leg: quote.leg, entryPrice: ask, shares: quote.size, hedged: false });
        } else {
            position.hedged = true;
            hedged++;
        }
    }
    settleCycles(cycles);
    const cycleList = Array.from(cycles.values()).sort((left, right) => left.startMs - right.startMs);
    const traded = cycleList.filter((cycle) => cycle.trades.length > 0);
    console.log(`Final-30-hedged: entries=${traded.length}, hedged=${hedged}, hedgeRate=${traded.length ? (hedged / traded.length * 100).toFixed(2) : "0.00"}%`);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function runFinal30ManagedBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    const positions = new Map<string, Btc5mFinal30ManagedPosition>();
    const blocked = new Set<string>();
    let takeProfits = 0;
    let stopLosses = 0;
    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;
        const position = positions.get(row.slug);
        const decision = buildBtc5mFinal30ManagedOrders({
            timestampMs: row.timestampMs,
            endMs: cycle.endMs,
            upAsk: row.upAsk,
            downAsk: row.downAsk,
            upBid: row.upBid,
            downBid: row.downBid,
            btcPrice: row.btcPrice,
            openPrice: cycle.openPrice,
            position,
            blocked: blocked.has(row.slug),
            params: final30ManagedParams(cfg),
        });
        if (position && decision.position) positions.set(row.slug, decision.position);
        if (!position && decision.reason?.includes("blocked:")) blocked.add(row.slug);
        const quote = decision.quotes[0];
        if (!quote) continue;
        if (quote.side === "BUY" && !position) {
            const ask = quote.leg === "UP" ? row.upAsk : row.downAsk;
            if (ask <= 0 || ask >= 1 || ask > quote.price + 1e-9) continue;
            buyAtPrice(cycle, row, quote.leg, ask, ask * quote.size, quote.fair, quote.edge, quote.note);
            positions.set(row.slug, { leg: quote.leg, entryPrice: ask, entryBtcPrice: row.btcPrice, shares: quote.size, exited: false });
        } else if (quote.side === "SELL" && position && !position.exited) {
            const bid = quote.leg === "UP" ? row.upBid : row.downBid;
            if (bid === undefined || bid <= 0 || bid + 1e-9 < quote.price) continue;
            sellAtPrice(cycle, row, quote.leg, quote.price, quote.size, quote.fair, quote.edge, quote.note);
            (decision.position ?? position).exited = true;
            if (quote.note?.includes("take-profit")) takeProfits++;
            else stopLosses++;
        }
    }
    settleManagedCycles(cycles);
    const cycleList = Array.from(cycles.values()).sort((left, right) => left.startMs - right.startMs);
    const entries = positions.size;
    console.log(`Final-30-managed: entries=${entries}, takeProfits=${takeProfits}, stopLosses=${stopLosses}, settled=${entries - takeProfits - stopLosses}`);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function final30ManagedParams(cfg: BacktestConfig) {
    return {
        triggerPrice: cfg.final30HighTriggerPrice,
        earlyTriggerPrice: cfg.final30HighEarlyTriggerPrice,
        maxEntryPrice: cfg.final30HighMaxEntryPrice,
        orderShares: cfg.final30HighOrderShares,
        maxSecondsLeftToOpen: cfg.final30HighMaxSecondsLeftToOpen,
        earlyMaxSecondsLeftToOpen: cfg.final30HighEarlyMaxSecondsLeftToOpen,
        minSecondsLeftToOpen: cfg.final30HighMinSecondsLeftToOpen,
        earlyBtcMinMoveUsd: cfg.final30ManagedEarlyBtcMinMoveUsd,
        earlyBtcMinAsk: cfg.final30ManagedEarlyBtcMinAsk,
        earlyBtcMaxSecondsLeftToOpen: cfg.final30ManagedEarlyBtcMaxSecondsLeft,
        takeProfitDelta: cfg.final30ManagedTakeProfitDelta,
        stopLossDelta: cfg.final30ManagedStopLossDelta,
        stopMinBtcReversalBps: cfg.final30ManagedStopMinBtcReversalBps,
        stopConfirmSeconds: cfg.final30ManagedStopConfirmSeconds,
        stopMaxDirectionalMarginBps: cfg.final30ManagedStopMaxDirectionalMarginBps,
    };
}

function runDynamicRangePullbackBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    const states = new Map<string, Btc5mDynamicRangePullbackState>();
    let entries = 0;
    let paired = 0;
    let stops = 0;
    let timeouts = 0;
    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;
        const state = states.get(row.slug) ?? {};
        const decision = buildBtc5mDynamicRangePullbackOrders({
            timestampMs: row.timestampMs,
            endMs: cycle.endMs,
            btcPrice: row.btcPrice,
            openPrice: cycle.openPrice,
            upAsk: row.upAsk,
            downAsk: row.downAsk,
            upBid: row.upBid,
            downBid: row.downBid,
            state,
            params: cfg.dynamicRangePullbackParams,
        });
        let nextState = decision.state;
        const quote = decision.quotes[0];
        if (quote?.side === "BUY") {
            const ask = quote.leg === "UP" ? row.upAsk : row.downAsk;
            if (ask > 0 && ask <= quote.price + 1e-9) {
                buyAtPrice(cycle, row, quote.leg, quote.price, quote.price * quote.size, quote.fair, quote.edge, quote.note);
                if (!state.entryLeg) {
                    nextState = {
                        ...nextState,
                        entryLeg: quote.leg,
                        entryPrice: quote.price,
                        entryShares: quote.size,
                        entryAtMs: row.timestampMs,
                        plannedHedgePrice: decision.entryPlan?.hedgePrice,
                        plannedHedgeShares: decision.entryPlan?.hedgeShares,
                        plannedExitPrice: decision.entryPlan?.exitPrice,
                        plannedLockedProfit: decision.entryPlan?.lockedProfit,
                        syntheticSell: decision.entryPlan?.mode === "synthetic-sell",
                        candidateLeg: undefined,
                        candidateSinceMs: undefined,
                    };
                    entries++;
                } else {
                    const pairedShares = (state.pairedShares ?? 0) + quote.size;
                    nextState = { ...nextState, pairedShares, paired: pairedShares + 1e-9 >= (state.plannedHedgeShares ?? state.entryShares ?? pairedShares) };
                    paired++;
                }
            }
        } else if (quote?.side === "SELL" && state.entryLeg && !state.exited) {
            const bid = quote.leg === "UP" ? row.upBid : row.downBid;
            const restingTakeProfit = quote.note?.includes("take-profit") ?? false;
            if (bid !== undefined && bid > 0 && (!restingTakeProfit || bid + 1e-9 >= quote.price)) {
                sellAtPrice(cycle, row, quote.leg, restingTakeProfit ? quote.price : bid, quote.size, quote.fair, quote.edge, quote.note);
                nextState = { ...nextState, exited: true };
                if (restingTakeProfit) paired++;
                else if (quote.note?.includes("stop-loss")) stops++;
                else timeouts++;
            }
        }
        states.set(row.slug, nextState);
    }
    settleManagedCycles(cycles);
    const cycleList = Array.from(cycles.values()).sort((left, right) => left.startMs - right.startMs);
    const completionLabel = cfg.dynamicRangePullbackParams.syntheticSell ? "syntheticTakeProfits" : "paired";
    const completionRateLabel = cfg.dynamicRangePullbackParams.syntheticSell ? "syntheticTakeProfitRate" : "pairRate";
    console.log(`Dynamic-range-pullback: entries=${entries}, ${completionLabel}=${paired}, ${completionRateLabel}=${entries ? (paired / entries * 100).toFixed(2) : "0.00"}%, stops=${stops}, timeouts=${timeouts}, settledNaked=${entries - paired - stops - timeouts}`);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function runDynamicRangeFinalManagedBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    const dynamicStates = new Map<string, Btc5mDynamicRangePullbackState>();
    const finalPositions = new Map<string, Btc5mFinal30ManagedPosition>();
    const finalBlocked = new Set<string>();
    let dynamicEntries = 0;
    let dynamicPairs = 0;
    let dynamicExits = 0;
    let dynamicSyntheticTakeProfits = 0;
    let finalEntries = 0;
    let finalTakeProfits = 0;
    let finalStopLosses = 0;
    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;
        const dynamicState = dynamicStates.get(row.slug) ?? {};
        const finalPosition = finalPositions.get(row.slug);
        const decision = buildBtc5mDynamicRangeFinalManagedOrders({
            timestampMs: row.timestampMs,
            endMs: cycle.endMs,
            btcPrice: row.btcPrice,
            openPrice: cycle.openPrice,
            upAsk: row.upAsk,
            downAsk: row.downAsk,
            upBid: row.upBid,
            downBid: row.downBid,
            state: dynamicState,
            params: cfg.dynamicRangePullbackParams,
            finalPosition,
            finalBlocked: finalBlocked.has(row.slug),
            finalParams: final30ManagedParams(cfg),
        });
        let nextDynamicState = decision.dynamicState;
        if (decision.finalPosition) finalPositions.set(row.slug, decision.finalPosition);
        if (decision.component === "final" && !finalPosition && decision.reason?.includes("blocked:")) finalBlocked.add(row.slug);
        const quote = decision.quotes[0];
        if (!quote) {
            dynamicStates.set(row.slug, nextDynamicState);
            continue;
        }
        if (decision.component === "dynamic" && quote.side === "BUY") {
            const ask = quote.leg === "UP" ? row.upAsk : row.downAsk;
            if (ask > 0 && ask <= quote.price + 1e-9) {
                buyAtPrice(cycle, row, quote.leg, quote.price, quote.price * quote.size, quote.fair, quote.edge, `dynamic-range-final-managed component=dynamic; ${quote.note ?? ""}`);
                if (!dynamicState.entryLeg) {
                    nextDynamicState = {
                        ...nextDynamicState,
                        entryLeg: quote.leg,
                        entryPrice: quote.price,
                        entryShares: quote.size,
                        entryAtMs: row.timestampMs,
                        plannedHedgePrice: decision.dynamicEntryPlan?.hedgePrice,
                        plannedHedgeShares: decision.dynamicEntryPlan?.hedgeShares,
                        plannedExitPrice: decision.dynamicEntryPlan?.exitPrice,
                        plannedLockedProfit: decision.dynamicEntryPlan?.lockedProfit,
                        syntheticSell: decision.dynamicEntryPlan?.mode === "synthetic-sell",
                        candidateLeg: undefined,
                        candidateSinceMs: undefined,
                    };
                    dynamicEntries++;
                } else {
                    const pairedShares = (dynamicState.pairedShares ?? 0) + quote.size;
                    nextDynamicState = { ...nextDynamicState, pairedShares, paired: pairedShares + 1e-9 >= (dynamicState.plannedHedgeShares ?? dynamicState.entryShares ?? pairedShares) };
                    dynamicPairs++;
                }
            }
        } else if (decision.component === "dynamic" && quote.side === "SELL" && dynamicState.entryLeg && !dynamicState.exited) {
            const bid = quote.leg === "UP" ? row.upBid : row.downBid;
            const restingTakeProfit = quote.note?.includes("take-profit") ?? false;
            if (bid !== undefined && bid > 0 && (!restingTakeProfit || bid + 1e-9 >= quote.price)) {
                sellAtPrice(cycle, row, quote.leg, restingTakeProfit ? quote.price : bid, quote.size, quote.fair, quote.edge, `dynamic-range-final-managed component=dynamic; ${quote.note ?? ""}`);
                nextDynamicState = { ...nextDynamicState, exited: true };
                dynamicExits++;
                if (restingTakeProfit) dynamicSyntheticTakeProfits++;
            }
        } else if (decision.component === "final" && quote.side === "BUY" && !finalPosition) {
            const ask = quote.leg === "UP" ? row.upAsk : row.downAsk;
            if (ask > 0 && ask < 1 && ask <= quote.price + 1e-9) {
                buyAtPrice(cycle, row, quote.leg, ask, ask * quote.size, quote.fair, quote.edge, `dynamic-range-final-managed component=final; ${quote.note ?? ""}`);
                finalPositions.set(row.slug, { leg: quote.leg, entryPrice: ask, entryBtcPrice: row.btcPrice, shares: quote.size, exited: false });
                finalEntries++;
            }
        } else if (decision.component === "final" && quote.side === "SELL" && finalPosition && !finalPosition.exited) {
            const bid = quote.leg === "UP" ? row.upBid : row.downBid;
            if (bid !== undefined && bid > 0 && bid + 1e-9 >= quote.price) {
                sellAtPrice(cycle, row, quote.leg, quote.price, quote.size, quote.fair, quote.edge, `dynamic-range-final-managed component=final; ${quote.note ?? ""}`);
                (decision.finalPosition ?? finalPosition).exited = true;
                finalPositions.set(row.slug, decision.finalPosition ?? finalPosition);
                if (quote.note?.includes("take-profit")) finalTakeProfits++;
                else finalStopLosses++;
            }
        }
        dynamicStates.set(row.slug, nextDynamicState);
    }
    settleManagedCycles(cycles);
    const cycleList = Array.from(cycles.values()).sort((left, right) => left.startMs - right.startMs);
    console.log(`Dynamic-range-final-managed: dynamicEntries=${dynamicEntries}, dynamicPairs=${dynamicPairs}, dynamicPairRate=${dynamicEntries ? (dynamicPairs / dynamicEntries * 100).toFixed(2) : "0.00"}%, dynamicSyntheticTakeProfits=${dynamicSyntheticTakeProfits}, dynamicExits=${dynamicExits}, finalEntries=${finalEntries}, finalTakeProfits=${finalTakeProfits}, finalStopLosses=${finalStopLosses}, finalSettled=${finalEntries - finalTakeProfits - finalStopLosses}`);
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

function runRangePairBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    const states = new Map<string, Btc5mRangePairState>();
    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;
        const secondsLeft = (cycle.endMs - row.timestampMs) / 1000;
        if (secondsLeft < cfg.minSecondsLeft) continue;
        const state = states.get(row.slug) ?? { filledUp: false, filledDown: false };
        const decision = buildBtc5mRangePairOrders(state, {
            firstPrice: cfg.trendRangeOverlayRangeFirstPrice,
            secondPrice: cfg.trendRangeOverlayRangeSecondPrice,
            maxTotalUsdc: cfg.trendRangeOverlayMaxTotalUsdc,
        });
        const filledLegs: Leg[] = [];
        for (const quote of decision.quotes) {
            const ask = quote.leg === "UP" ? row.upAsk : row.downAsk;
            if (ask > quote.price) continue;
            buyAtPrice(cycle, row, quote.leg, quote.price, quote.price * quote.size, quote.fair, quote.edge, `range-pair ${cfg.trendRangeOverlayRangeFirstPrice.toFixed(2)}->${cfg.trendRangeOverlayRangeSecondPrice.toFixed(2)}`);
            filledLegs.push(quote.leg);
            if (quote.leg === "UP") state.filledUp = true;
            else state.filledDown = true;
        }
        if (!state.firstLeg && filledLegs.length === 1) state.firstLeg = filledLegs[0];
        states.set(row.slug, state);
    }
    settleCycles(cycles);
    const cycleList = Array.from(cycles.values()).sort((left, right) => left.startMs - right.startMs);
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

function runConditionalMarketMakerBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    const history = new Map<string, Btc5mConditionalMarketMakerSample[]>();
    const activeQuotes = new Map<string, Map<string, Btc5mStrategyQuote>>();
    let quotedRows = 0;
    let filteredRows = 0;
    let buyFills = 0;
    let sellFills = 0;
    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;
        const secondsLeft = (cycle.endMs - row.timestampMs) / 1000;
        const quotes = activeQuotes.get(row.slug) ?? new Map<string, Btc5mStrategyQuote>();

        for (const [key, quote] of Array.from(quotes.entries())) {
            if (quote.side === "BUY") {
                const ask = quote.leg === "UP" ? row.upAsk : row.downAsk;
                if (ask <= quote.price) {
                    applyBuyQuotes(cycle, row, [quote], `conditional-market-maker ${quote.note ?? "bid fill"}`);
                    quotes.delete(key);
                    buyFills++;
                }
            } else {
                const bid = quote.leg === "UP" ? row.upBid : row.downBid;
                if (bid !== undefined && bid >= quote.price) {
                    sellAtPrice(cycle, row, quote.leg, quote.price, quote.size, quote.fair, quote.edge, `conditional-market-maker ${quote.note ?? "ask fill"}`);
                    quotes.delete(key);
                    sellFills++;
                }
            }
        }

        const samples = history.get(row.slug) ?? [];
        if (row.btcPrice !== undefined) samples.push({ timestampMs: row.timestampMs, btcPrice: row.btcPrice });
        const cutoff = row.timestampMs - Math.max(cfg.conditionalMmLookbackSeconds, cfg.conditionalMmAccelerationLookbackSeconds) * 1000 - 2000;
        while (samples.length && samples[0].timestampMs < cutoff) samples.shift();
        history.set(row.slug, samples);

        if (secondsLeft < cfg.minSecondsLeft) {
            quotes.clear();
            activeQuotes.set(row.slug, quotes);
            continue;
        }
        const decision = buildBtc5mConditionalMarketMakerQuotes({
            timestampMs: row.timestampMs,
            btcPrice: row.btcPrice,
            history: samples,
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
                enableSellExcess: true,
                minSecondsLeftToQuote: cfg.minSecondsLeft,
                tick: 0.01,
            },
            conditionalParams: {
                lookbackSeconds: cfg.conditionalMmLookbackSeconds,
                accelerationLookbackSeconds: cfg.conditionalMmAccelerationLookbackSeconds,
                maxRangeBps: cfg.conditionalMmMaxRangeBps,
                maxTrendBps: cfg.conditionalMmMaxTrendBps,
                maxTrendEfficiency: cfg.conditionalMmMaxTrendEfficiency,
                trendEfficiencyMinMomentumBps: cfg.conditionalMmTrendEfficiencyMinMomentumBps,
                maxAccelerationBps: cfg.conditionalMmMaxAccelerationBps,
                directionMinMomentumBps: cfg.conditionalMmDirectionMinMomentumBps,
                favoredPriceImprove: cfg.conditionalMmFavoredPriceImprove,
                unfavoredPriceOffset: cfg.conditionalMmUnfavoredPriceOffset,
                favoredSizeMultiplier: cfg.conditionalMmFavoredSizeMultiplier,
                unfavoredSizeMultiplier: cfg.conditionalMmUnfavoredSizeMultiplier,
                maxNetInventoryShares: cfg.conditionalMmMaxNetInventoryShares,
                minOrderUsdc: cfg.conditionalMmMinOrderUsdc,
            },
            state: {
                qUp: cycle.inventoryUp,
                qDown: cycle.inventoryDown,
                buyCostUp: cycle.spentUp,
                buyCostDown: cycle.spentDown,
            },
        });
        quotes.clear();
        for (const quote of decision.quotes) quotes.set(quote.key, quote);
        if (decision.quotes.length) quotedRows++;
        else filteredRows++;
        activeQuotes.set(row.slug, quotes);
    }
    settleCycles(cycles);
    const cycleList = Array.from(cycles.values()).sort((left, right) => left.startMs - right.startMs);
    console.log(`Conditional market maker: quotedRows=${quotedRows}, filteredRows=${filteredRows}, buyFills=${buyFills}, sellFills=${sellFills}`);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function runTrendPullbackBacktest(rows: MarketRow[], cfg: BacktestConfig, logStats = true): { cycles: CycleState[]; trades: Trade[] } {
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
            upBid: row.upBid,
            downBid: row.downBid,
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
                minSecondsLeftToFill: cfg.trendPullbackMinSecondsLeftToFill,
                triggerConfirmSeconds: cfg.trendPullbackTriggerConfirmSeconds,
                maxOrderAgeSeconds: cfg.trendPullbackMaxOrderAgeSeconds,
                maxBtcReversalBps: cfg.trendPullbackMaxBtcReversalBps,
                postFillStopLossPrice: cfg.trendPullbackPostFillStopLossPrice,
                postFillTakeProfitPrice: cfg.trendPullbackPostFillTakeProfitPrice,
                postFillMaxBtcReversalBps: cfg.trendPullbackPostFillMaxBtcReversalBps,
            },
        });
        if (!previousState.triggeredLeg && decision.state.triggeredLeg) triggeredCycles++;
        if (!previousState.cancelled && decision.state.cancelled) cancelledCycles++;

        const quote = decision.quotes[0];
        const ask = quote?.leg === "UP" ? row.upAsk : row.downAsk;
        const isLaterSnapshot = decision.state.triggeredAtMs !== undefined && row.timestampMs > decision.state.triggeredAtMs;
        if (quote && quote.side === "BUY" && isLaterSnapshot && ask > 0 && ask <= quote.price) {
            buyAtPrice(cycle, row, quote.leg, quote.price, quote.price * quote.size, quote.fair, quote.edge, quote.note);
            decision.state = {
                ...decision.state,
                filled: true,
                filledAtMs: row.timestampMs,
                fillPrice: quote.price,
                filledShares: quote.size,
            };
            filledCycles++;
        } else if (quote?.side === "SELL") {
            sellAtPrice(cycle, row, quote.leg, quote.price, quote.size, quote.fair, quote.edge, quote.note);
            decision.state = { ...decision.state, exited: true };
        }
        states.set(row.slug, decision.state);
    }

    settleTrendPullbackCycles(cycles);
    if (logStats) console.log(`Trend-pullback orders: triggered=${triggeredCycles}, filled=${filledCycles}, cancelled=${cancelledCycles}, fill rate=${triggeredCycles ? (filledCycles / triggeredCycles * 100).toFixed(2) : "0.00"}%`);
    const cycleList = Array.from(cycles.values()).sort((a, b) => a.startMs - b.startMs);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function runSustainedHighBacktest(rows: MarketRow[], cfg: BacktestConfig, logSummary = true): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    const states = new Map<string, Btc5mSustainedHighState>();
    let triggeredCycles = 0;
    let filledCycles = 0;
    let cancelledCycles = 0;

    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;

        const previousState = states.get(row.slug) ?? {};
        const decision = buildBtc5mSustainedHighOrders({
            timestampMs: row.timestampMs,
            endMs: cycle.endMs,
            upAsk: row.upAsk,
            downAsk: row.downAsk,
            btcPrice: row.btcPrice,
            openPrice: row.openPrice ?? cycle.openPrice,
            state: previousState,
            params: {
                triggerPrice: cfg.sustainedHighTriggerPrice,
                confirmSeconds: cfg.sustainedHighConfirmSeconds,
                entryPrice: cfg.sustainedHighEntryPrice,
                orderUsdc: cfg.sustainedHighOrderUsdc,
                maxSecondsLeftToTrigger: cfg.sustainedHighMaxSecondsLeftToTrigger,
                minSecondsLeftToTrigger: cfg.sustainedHighMinSecondsLeftToTrigger,
                minSecondsLeftToFill: cfg.sustainedHighMinSecondsLeftToFill,
                maxOrderAgeSeconds: cfg.sustainedHighMaxOrderAgeSeconds,
                minBtcMoveBps: cfg.sustainedHighMinBtcMoveBps,
                maxBtcReversalBps: cfg.sustainedHighMaxBtcReversalBps,
            },
        });
        if (!previousState.triggeredLeg && decision.state.triggeredLeg) triggeredCycles++;
        if (!previousState.cancelled && decision.state.cancelled) cancelledCycles++;

        const quote = decision.quotes[0];
        const ask = quote?.leg === "UP" ? row.upAsk : row.downAsk;
        if (quote?.side === "BUY" && ask > 0 && ask <= quote.price) {
            buyAtPrice(cycle, row, quote.leg, quote.price, quote.price * quote.size, quote.fair, quote.edge, quote.note);
            decision.state = { ...decision.state, filled: true };
            filledCycles++;
        }
        states.set(row.slug, decision.state);
    }

    settleSustainedHighCycles(cycles);
    if (logSummary) console.log(`Sustained-high orders: triggered=${triggeredCycles}, filled=${filledCycles}, cancelled=${cancelledCycles}, fill rate=${triggeredCycles ? (filledCycles / triggeredCycles * 100).toFixed(2) : "0.00"}%`);
    const cycleList = Array.from(cycles.values()).sort((a, b) => a.startMs - b.startMs);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function runLatencyScalpBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const cycles = createCycleMap(rows, cfg);
    const states = new Map<string, Btc5mLatencyScalpState>();
    let triggered = 0;
    let filled = 0;
    let takeProfits = 0;
    let riskExits = 0;

    for (const row of rows) {
        const cycle = cycles.get(row.slug)!;
        updateWinner(cycle, row);
        if (row.rowType === "resolution") continue;
        const previousState = states.get(row.slug) ?? {};
        const decision = buildBtc5mLatencyScalpOrders({
            timestampMs: row.timestampMs,
            endMs: cycle.endMs,
            upAsk: row.upAsk,
            downAsk: row.downAsk,
            upBid: row.upBid,
            downBid: row.downBid,
            btcPrice: row.btcPrice,
            openPrice: row.openPrice ?? cycle.openPrice,
            state: previousState,
            params: {
                minSignalPrice: cfg.latencyScalpMinSignalPrice,
                triggerConfirmSeconds: cfg.latencyScalpTriggerConfirmSeconds,
                signalLookbackSeconds: cfg.latencyScalpSignalLookbackSeconds,
                minContractMomentum: cfg.latencyScalpMinContractMomentum,
                minBtcMomentumBps: cfg.latencyScalpMinBtcMomentumBps,
                entryPrice: cfg.latencyScalpEntryPrice,
                takeProfitPrice: cfg.latencyScalpTakeProfitPrice,
                orderUsdc: cfg.latencyScalpOrderUsdc,
                maxSecondsLeftToTrigger: cfg.latencyScalpMaxSecondsLeftToTrigger,
                minSecondsLeftToTrigger: cfg.latencyScalpMinSecondsLeftToTrigger,
                maxEntryOrderAgeSeconds: cfg.latencyScalpMaxEntryOrderAgeSeconds,
                maxHoldSeconds: cfg.latencyScalpMaxHoldSeconds,
                minBtcMoveBps: cfg.latencyScalpMinBtcMoveBps,
                maxBtcReversalBps: cfg.latencyScalpMaxBtcReversalBps,
                stopLossPrice: cfg.latencyScalpStopLossPrice,
                forceExitSecondsLeft: cfg.latencyScalpForceExitSecondsLeft,
            },
        });
        let nextState = decision.state;
        if (!previousState.triggeredLeg && nextState.triggeredLeg) triggered++;
        const quote = decision.quotes[0];
        if (quote?.side === "BUY" && !nextState.filled) {
            const ask = quote.leg === "UP" ? row.upAsk : row.downAsk;
            if (ask > 0 && ask <= quote.price && row.timestampMs > (nextState.triggeredAtMs ?? row.timestampMs)) {
                buyAtPrice(cycle, row, quote.leg, ask, ask * quote.size, quote.fair, quote.edge, `${quote.note}; limit=${quote.price.toFixed(2)}`);
                nextState = { ...nextState, filled: true, filledAtMs: row.timestampMs, fillBtcPrice: row.btcPrice, filledShares: quote.size };
                filled++;
            }
        } else if (quote?.side === "SELL" && nextState.filled && !nextState.exited) {
            const bid = quote.leg === "UP" ? row.upBid : row.downBid;
            const isTakeProfit = quote.note?.includes("take profit") ?? false;
            if (bid !== undefined && bid > 0 && (!isTakeProfit || bid >= quote.price)) {
                sellAtPrice(cycle, row, quote.leg, isTakeProfit ? quote.price : bid, quote.size, quote.fair, quote.edge, quote.note);
                nextState = { ...nextState, exited: true };
                if (isTakeProfit) takeProfits++;
                else riskExits++;
            }
        }
        states.set(row.slug, nextState);
    }

    settleManagedCycles(cycles);
    console.log(`Latency-scalp orders: triggered=${triggered}, filled=${filled}, takeProfits=${takeProfits}, riskExits=${riskExits}, fillRate=${triggered ? (filled / triggered * 100).toFixed(2) : "0.00"}%`);
    const cycleList = Array.from(cycles.values()).sort((left, right) => left.startMs - right.startMs);
    return { cycles: cycleList, trades: cycleList.flatMap((cycle) => cycle.trades) };
}

function runTrendRangeSwitchBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    type Mode = "trend-pullback" | "range-arb";
    const rowsBySlug = new Map<string, MarketRow[]>();
    for (const row of rows) {
        if (!rowsBySlug.has(row.slug)) rowsBySlug.set(row.slug, []);
        rowsBySlug.get(row.slug)!.push(row);
    }
    const cycleRows = Array.from(rowsBySlug.values()).sort((left, right) => left[0].timestampMs - right[0].timestampMs);
    const cycles: CycleState[] = [];
    let mode: Mode = "trend-pullback";
    let consecutiveFailures = 0;
    let switches = 0;
    const modeStats = {
        "trend-pullback": { cycles: 0, traded: 0, failures: 0, pnl: 0 },
        "range-arb": { cycles: 0, traded: 0, failures: 0, pnl: 0 },
    };
    for (const rowsForCycle of cycleRows) {
        const activeMode = mode;
        const result = activeMode === "trend-pullback"
            ? runTrendPullbackBacktest(rowsForCycle, cfg, false)
            : runRangeArbBacktest(rowsForCycle, cfg);
        const cycle = result.cycles[0];
        if (!cycle) continue;
        modeStats[activeMode].cycles++;
        for (const trade of cycle.trades) trade.note = `trend-range-switch mode=${activeMode}; ${trade.note ?? ""}`.trim();
        const cost = cycle.trades.reduce((sum, trade) => sum + trade.cost, 0);
        const payout = cycle.trades.reduce((sum, trade) => sum + (trade.payout ?? 0), 0);
        const pnl = payout - cost;
        modeStats[activeMode].pnl += pnl;
        if (cost > 0) {
            modeStats[activeMode].traded++;
            if (pnl < 0) {
                consecutiveFailures++;
                modeStats[activeMode].failures++;
            } else {
                consecutiveFailures = 0;
            }
            if (consecutiveFailures >= cfg.trendRangeSwitchFailures) {
                mode = activeMode === "trend-pullback" ? "range-arb" : "trend-pullback";
                console.log(`Mode switch after ${cycle.slug}: ${activeMode} -> ${mode} after ${cfg.trendRangeSwitchFailures} consecutive losing traded cycles`);
                consecutiveFailures = 0;
                switches++;
            }
        }
        cycles.push(cycle);
    }

    console.log(`Trend-range switch: threshold=${cfg.trendRangeSwitchFailures}, switches=${switches}, finalMode=${mode}`);
    console.log(`  trend-pullback: cycles=${modeStats["trend-pullback"].cycles}, traded=${modeStats["trend-pullback"].traded}, failures=${modeStats["trend-pullback"].failures}, pnl=${modeStats["trend-pullback"].pnl.toFixed(4)}`);
    console.log(`  range-arb@${cfg.rangePriceX.toFixed(2)}: cycles=${modeStats["range-arb"].cycles}, traded=${modeStats["range-arb"].traded}, failures=${modeStats["range-arb"].failures}, pnl=${modeStats["range-arb"].pnl.toFixed(4)}`);
    return { cycles, trades: cycles.flatMap((cycle) => cycle.trades) };
}

function runTrendRangeRegimeBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    type Mode = "trend-pullback" | "range-arb";
    const rowsBySlug = new Map<string, MarketRow[]>();
    for (const row of rows) {
        if (!rowsBySlug.has(row.slug)) rowsBySlug.set(row.slug, []);
        rowsBySlug.get(row.slug)!.push(row);
    }
    const cycleRows = Array.from(rowsBySlug.values())
        .map((rowsForCycle) => rowsForCycle.sort((left, right) => left.timestampMs - right.timestampMs))
        .sort((left, right) => left[0].timestampMs - right[0].timestampMs);
    const cycles: CycleState[] = [];
    let nextMode: Mode = "trend-pullback";
    let rangeSignals = 0;
    const modeStats = {
        "trend-pullback": { cycles: 0, traded: 0, profitable: 0, pnl: 0 },
        "range-arb": { cycles: 0, traded: 0, profitable: 0, pnl: 0 },
    };
    const regimeRangeConfig = {
        ...cfg,
        rangePriceX: cfg.trendRangeRegimeRangePrice,
        rangeUsdcPerLeg: cfg.trendRangeRegimeRangeUsdcPerLeg,
    };

    for (const rowsForCycle of cycleRows) {
        const activeMode = nextMode;
        const result = activeMode === "range-arb"
            ? runRangeArbBacktest(rowsForCycle, regimeRangeConfig)
            : runTrendPullbackBacktest(rowsForCycle, cfg, false);
        const cycle = result.cycles[0];
        if (!cycle) continue;
        const cost = cycle.trades.reduce((sum, trade) => sum + trade.cost, 0);
        const payout = cycle.trades.reduce((sum, trade) => sum + (trade.payout ?? 0), 0);
        const pnl = payout - cost;
        modeStats[activeMode].cycles++;
        modeStats[activeMode].pnl += pnl;
        if (cost > 0) {
            modeStats[activeMode].traded++;
            if (pnl > 0) modeStats[activeMode].profitable++;
        }
        for (const trade of cycle.trades) trade.note = `trend-range-regime mode=${activeMode}; ${trade.note ?? ""}`.trim();
        cycles.push(cycle);

        const metrics = classifyTrendRangeCycle(rowsForCycle, cycle, cfg);
        nextMode = metrics.oscillating ? "range-arb" : "trend-pullback";
        if (metrics.oscillating) rangeSignals++;
    }

    console.log(`Trend-range regime: rangeSignals=${rangeSignals}, band=${cfg.trendRangeRegimeBandLower.toFixed(2)}-${cfg.trendRangeRegimeBandUpper.toFixed(2)}, minBandRatio=${cfg.trendRangeRegimeMinBandRatio.toFixed(2)}, centerBuffer=${cfg.trendRangeRegimeCenterBuffer.toFixed(2)}, minSwings=${cfg.trendRangeRegimeMinCrossCount}, minRange=${cfg.trendRangeRegimeMinPriceRange.toFixed(2)}, minChoppiness=${cfg.trendRangeRegimeMinChoppiness.toFixed(2)}, ignoreFinalSeconds=${cfg.trendRangeRegimeIgnoreFinalSeconds}`);
    console.log(`  trend-pullback: cycles=${modeStats["trend-pullback"].cycles}, traded=${modeStats["trend-pullback"].traded}, profitable=${modeStats["trend-pullback"].profitable}, pnl=${modeStats["trend-pullback"].pnl.toFixed(4)}`);
    console.log(`  range-arb@${cfg.trendRangeRegimeRangePrice.toFixed(2)} (${cfg.trendRangeRegimeRangeUsdcPerLeg.toFixed(2)} USDC/leg): cycles=${modeStats["range-arb"].cycles}, traded=${modeStats["range-arb"].traded}, profitable=${modeStats["range-arb"].profitable}, pnl=${modeStats["range-arb"].pnl.toFixed(4)}`);
    return { cycles, trades: cycles.flatMap((cycle) => cycle.trades) };
}

function runTrendRangeOverlayBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const rowsBySlug = new Map<string, MarketRow[]>();
    for (const row of rows) {
        if (!rowsBySlug.has(row.slug)) rowsBySlug.set(row.slug, []);
        rowsBySlug.get(row.slug)!.push(row);
    }
    const cycleRows = Array.from(rowsBySlug.values())
        .map((rowsForCycle) => rowsForCycle.sort((left, right) => left.timestampMs - right.timestampMs))
        .sort((left, right) => left[0].timestampMs - right[0].timestampMs);
    const cycles: CycleState[] = [];
    let previousMetrics: ReturnType<typeof classifyPreviousCycleRegime> | undefined;
    let rangeSignals = 0;
    const componentStats = {
        trend: { traded: 0, profitable: 0, pnl: 0 },
        range: { traded: 0, profitable: 0, pnl: 0 },
        high: { traded: 0, profitable: 0, pnl: 0 },
    };

    for (const rowsForCycle of cycleRows) {
        const trendConfig = previousMetrics?.oscillating && cfg.trendRangeOverlayTrendTakeProfitPrice > 0
            ? { ...cfg, trendPullbackPostFillTakeProfitPrice: cfg.trendRangeOverlayTrendTakeProfitPrice }
            : cfg;
        const trendResult = runTrendPullbackBacktest(rowsForCycle, trendConfig, false);
        const cycle = trendResult.cycles[0];
        if (!cycle) continue;
        const trendTotals = cycleTradeTotals(cycle);
        if (trendTotals.cost > 0) {
            componentStats.trend.traded++;
            if (trendTotals.pnl > 0) componentStats.trend.profitable++;
        }
        componentStats.trend.pnl += trendTotals.pnl;
        for (const trade of cycle.trades) trade.note = `trend-range-overlay component=trend; ${trade.note ?? ""}`.trim();

        if (!previousMetrics?.oscillating && trendTotals.cost <= 0) {
            const highResult = runSustainedHighBacktest(rowsForCycle, cfg, false);
            const highCycle = highResult.cycles[0];
            if (highCycle) {
                const highTotals = cycleTradeTotals(highCycle);
                if (highTotals.cost > 0) {
                    componentStats.high.traded++;
                    if (highTotals.pnl > 0) componentStats.high.profitable++;
                }
                componentStats.high.pnl += highTotals.pnl;
                for (const trade of highCycle.trades) {
                    trade.note = `trend-range-overlay component=sustained-high fallback; ${trade.note ?? ""}`.trim();
                    cycle.trades.push(trade);
                }
            }
        }

        if (previousMetrics?.oscillating) {
            const rangeResult = runRangePairBacktest(rowsForCycle, cfg);
            const rangeCycle = rangeResult.cycles[0];
            if (rangeCycle) {
                const rangeTotals = cycleTradeTotals(rangeCycle);
                if (rangeTotals.cost > 0) {
                    componentStats.range.traded++;
                    if (rangeTotals.pnl > 0) componentStats.range.profitable++;
                }
                componentStats.range.pnl += rangeTotals.pnl;
                const signal = `band=${previousMetrics.bandRatio.toFixed(2)} swings=${previousMetrics.crossCount} range=${previousMetrics.priceRange.toFixed(2)} chop=${previousMetrics.choppiness.toFixed(2)}`;
                for (const trade of rangeCycle.trades) {
                    trade.note = `trend-range-overlay component=range previous=${signal}; ${trade.note ?? ""}`.trim();
                    cycle.trades.push(trade);
                }
            }
        }
        cycles.push(cycle);
        previousMetrics = classifyTrendRangeCycle(rowsForCycle, cycle, cfg);
        if (previousMetrics.oscillating) rangeSignals++;
    }

    console.log(`Trend-range overlay: rangeSignals=${rangeSignals}, trendAlwaysOn=true, sustainedHighFallback=non-range/no-trend-fill, rangePair=${cfg.trendRangeOverlayRangeFirstPrice.toFixed(2)}->${cfg.trendRangeOverlayRangeSecondPrice.toFixed(2)}, rangeMaxTotalUsdc=${cfg.trendRangeOverlayMaxTotalUsdc.toFixed(2)}, conditionalTrendTakeProfit=${cfg.trendRangeOverlayTrendTakeProfitPrice.toFixed(2)}`);
    console.log(`  trend-pullback: traded=${componentStats.trend.traded}, profitable=${componentStats.trend.profitable}, pnl=${componentStats.trend.pnl.toFixed(4)}`);
    console.log(`  sustained-high fallback: traded=${componentStats.high.traded}, profitable=${componentStats.high.profitable}, pnl=${componentStats.high.pnl.toFixed(4)}`);
    console.log(`  conditional range-arb: traded=${componentStats.range.traded}, profitable=${componentStats.range.profitable}, pnl=${componentStats.range.pnl.toFixed(4)}`);
    return { cycles, trades: cycles.flatMap((cycle) => cycle.trades) };
}

function runAdaptiveOverlayBacktest(rows: MarketRow[], cfg: BacktestConfig): { cycles: CycleState[]; trades: Trade[] } {
    const rowsBySlug = new Map<string, MarketRow[]>();
    for (const row of rows) {
        if (!rowsBySlug.has(row.slug)) rowsBySlug.set(row.slug, []);
        rowsBySlug.get(row.slug)!.push(row);
    }
    const cycleRows = Array.from(rowsBySlug.values())
        .map((items) => items.sort((left, right) => left.timestampMs - right.timestampMs))
        .sort((left, right) => left[0].timestampMs - right[0].timestampMs);
    const deepRows: MarketRow[] = [];
    let previousMetrics: ReturnType<typeof classifyPreviousCycleRegime> | undefined;
    let enabledCycles = 0;
    for (const rowsForCycle of cycleRows) {
        const deepEnabled = cfg.adaptiveOverlayDeepInRange || !previousMetrics?.oscillating;
        if (deepEnabled) {
            deepRows.push(...rowsForCycle);
            enabledCycles++;
        }
        const cycle = createCycleMap(rowsForCycle, cfg).get(rowsForCycle[0].slug)!;
        previousMetrics = classifyTrendRangeCycle(rowsForCycle, cycle, cfg);
    }

    const overlay = runTrendRangeOverlayBacktest(rows, cfg);
    const deep = runDeepReboundBacktest(deepRows, cfg, false);
    const overlayBySlug = new Map(overlay.cycles.map((cycle) => [cycle.slug, cycle]));
    let deepTraded = 0;
    let deepProfitable = 0;
    let deepPnl = 0;
    for (const deepCycle of deep.cycles) {
        const target = overlayBySlug.get(deepCycle.slug);
        if (!target) continue;
        const totals = cycleTradeTotals(deepCycle);
        if (totals.cost > 0) {
            deepTraded++;
            if (totals.pnl > 0) deepProfitable++;
        }
        deepPnl += totals.pnl;
        for (const trade of deepCycle.trades) {
            trade.note = `adaptive-overlay component=deep-rebound; ${trade.note ?? ""}`.trim();
            target.trades.push(trade);
        }
    }
    console.log(`Adaptive overlay: deepEnabledCycles=${enabledCycles}, deepInRange=${cfg.adaptiveOverlayDeepInRange}, deepTraded=${deepTraded}, deepProfitable=${deepProfitable}, deepPnl=${deepPnl.toFixed(4)}`);
    return { cycles: overlay.cycles, trades: overlay.cycles.flatMap((cycle) => cycle.trades) };
}

function classifyTrendRangeCycle(rows: MarketRow[], cycle: CycleState, cfg: BacktestConfig): ReturnType<typeof classifyPreviousCycleRegime> {
    return classifyPreviousCycleRegime(rows.flatMap((row) => {
        if (row.rowType === "resolution") return [];
        const upMid = row.upMid ?? (row.upBid !== undefined ? (row.upBid + row.upAsk) / 2 : row.upAsk);
        return [{
            timestampMs: row.timestampMs,
            secondsLeft: Math.max(0, (cycle.endMs - row.timestampMs) / 1000),
            upMid,
        }];
    }), {
        bandLower: cfg.trendRangeRegimeBandLower,
        bandUpper: cfg.trendRangeRegimeBandUpper,
        minBandRatio: cfg.trendRangeRegimeMinBandRatio,
        minCrossCount: cfg.trendRangeRegimeMinCrossCount,
        minPriceRange: cfg.trendRangeRegimeMinPriceRange,
        centerBuffer: cfg.trendRangeRegimeCenterBuffer,
        minChoppiness: cfg.trendRangeRegimeMinChoppiness,
        ignoreFinalSeconds: cfg.trendRangeRegimeIgnoreFinalSeconds,
        minSamples: cfg.trendRangeRegimeMinSamples,
    });
}

function cycleTradeTotals(cycle: CycleState): { cost: number; payout: number; pnl: number } {
    const cost = cycle.trades.reduce((sum, trade) => sum + trade.cost, 0);
    const payout = cycle.trades.reduce((sum, trade) => sum + (trade.payout ?? 0), 0);
    return { cost, payout, pnl: payout - cost };
}

function settleTrendPullbackCycles(cycles: Map<string, CycleState>): void {
    for (const cycle of cycles.values()) {
        const winner = inferWinner(cycle);
        const shares = winner === "UP" ? cycle.inventoryUp : winner === "DOWN" ? cycle.inventoryDown : 0;
        if (winner && shares > 0) {
            cycle.trades.push({
                slug: cycle.slug,
                timestampMs: cycle.endMs,
                leg: winner,
                price: 1,
                shares,
                cost: 0,
                finalPrice: cycle.finalPrice,
                payout: shares,
                pnl: shares,
                note: "trend-pullback settlement",
            });
        }
        for (const trade of cycle.trades) trade.finalPrice = trade.finalPrice ?? cycle.finalPrice;
    }
}

function settleSustainedHighCycles(cycles: Map<string, CycleState>): void {
    for (const cycle of cycles.values()) {
        const winner = inferWinner(cycle);
        const shares = winner === "UP" ? cycle.inventoryUp : winner === "DOWN" ? cycle.inventoryDown : 0;
        if (winner && shares > 0) {
            cycle.trades.push({
                slug: cycle.slug,
                timestampMs: cycle.endMs,
                leg: winner,
                price: 1,
                shares,
                cost: 0,
                finalPrice: cycle.finalPrice,
                payout: shares,
                pnl: shares,
                note: "sustained-high settlement",
            });
        }
        for (const trade of cycle.trades) trade.finalPrice = trade.finalPrice ?? cycle.finalPrice;
    }
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
    if (cfg.strategy === "conditional-market-maker" || cfg.strategy === "trend-pullback" || cfg.strategy === "sustained-high" || cfg.strategy === "latency-scalp" || cfg.strategy === "deep-rebound" || cfg.strategy === "extreme-020-rebound" || cfg.strategy === "final-30-high" || cfg.strategy === "final-30-hedged" || cfg.strategy === "final-30-managed" || cfg.strategy === "dynamic-range-pullback" || cfg.strategy === "dynamic-range-final-managed" || cfg.strategy === "trend-range-switch" || cfg.strategy === "trend-range-regime" || cfg.strategy === "trend-range-overlay" || cfg.strategy === "adaptive-overlay") {
        const entries = trades.filter((trade) => trade.cost > 0);
        const profitableCycles = cycles.filter((cycle) => {
            const cost = cycle.trades.reduce((sum, trade) => sum + trade.cost, 0);
            const payout = cycle.trades.reduce((sum, trade) => sum + (trade.payout ?? 0), 0);
            return cost > 0 && payout > cost;
        }).length;
        console.log(`Entries: ${entries.length}, profitable cycles: ${profitableCycles}, cycle win rate: ${tradedCycles ? (profitableCycles / tradedCycles * 100).toFixed(2) : "0.00"}%`);
    } else {
        console.log(`Trades: ${trades.length}, winners: ${winners}, win rate: ${trades.length ? (winners / trades.length * 100).toFixed(2) : "0.00"}%`);
    }
    console.log(`Cost: ${totalCost.toFixed(4)}, payout: ${totalPayout.toFixed(4)}, PnL: ${totalPnl.toFixed(4)}, ROI: ${(roi * 100).toFixed(2)}%`);
    let cumulativePnl = 0;
    let peakPnl = 0;
    let maxDrawdown = 0;
    let losingStreak = 0;
    let maxLosingStreak = 0;
    for (const cycle of cycles) {
        const cycleCost = cycle.trades.reduce((sum, trade) => sum + trade.cost, 0);
        const cyclePayout = cycle.trades.reduce((sum, trade) => sum + (trade.payout ?? 0), 0);
        const cyclePnl = cyclePayout - cycleCost;
        cumulativePnl += cyclePnl;
        peakPnl = Math.max(peakPnl, cumulativePnl);
        maxDrawdown = Math.max(maxDrawdown, peakPnl - cumulativePnl);
        losingStreak = cyclePnl < 0 ? losingStreak + 1 : 0;
        maxLosingStreak = Math.max(maxLosingStreak, losingStreak);
    }
    console.log(`Risk: maxDrawdown=${maxDrawdown.toFixed(4)} USDC, maxConsecutiveLosingCycles=${maxLosingStreak}`);
    if (cfg.strategy === "conditional-market-maker") {
        console.log(`Params: lookback=${cfg.conditionalMmLookbackSeconds}s, acceleration=${cfg.conditionalMmAccelerationLookbackSeconds}s/${cfg.conditionalMmMaxAccelerationBps}bps, maxRange=${cfg.conditionalMmMaxRangeBps}bps, maxTrend=${cfg.conditionalMmMaxTrendBps}bps, maxEfficiency=${cfg.conditionalMmMaxTrendEfficiency}@${cfg.conditionalMmTrendEfficiencyMinMomentumBps}bps, directionMin=${cfg.conditionalMmDirectionMinMomentumBps}bps, skew=+${cfg.conditionalMmFavoredPriceImprove}/-${cfg.conditionalMmUnfavoredPriceOffset}, size=${cfg.conditionalMmFavoredSizeMultiplier}/${cfg.conditionalMmUnfavoredSizeMultiplier}, maxNet=${cfg.conditionalMmMaxNetInventoryShares}, orderUsdc=${cfg.conditionalMmMinOrderUsdc}-${cfg.marketMakerMaxUsdcPerLeg}/leg`);
    } else if (cfg.strategy === "trend-pullback") {
        console.log(`Params: trigger=${cfg.trendPullbackTriggerPrice}, entry=${cfg.trendPullbackEntryPrice}, orderUsdc=${cfg.trendPullbackOrderUsdc}, minSecondsLeftToFill=${cfg.trendPullbackMinSecondsLeftToFill}, confirmSeconds=${cfg.trendPullbackTriggerConfirmSeconds}, maxOrderAgeSeconds=${cfg.trendPullbackMaxOrderAgeSeconds}, maxBtcReversalBps=${cfg.trendPullbackMaxBtcReversalBps}`);
    } else if (cfg.strategy === "sustained-high") {
        console.log(`Params: trigger=${cfg.sustainedHighTriggerPrice}, confirmSeconds=${cfg.sustainedHighConfirmSeconds}, entry=${cfg.sustainedHighEntryPrice}, orderUsdc=${cfg.sustainedHighOrderUsdc}, maxSecondsLeftToTrigger=${cfg.sustainedHighMaxSecondsLeftToTrigger}, minSecondsLeftToTrigger=${cfg.sustainedHighMinSecondsLeftToTrigger}, minSecondsLeftToFill=${cfg.sustainedHighMinSecondsLeftToFill}, maxOrderAgeSeconds=${cfg.sustainedHighMaxOrderAgeSeconds}, minBtcMoveBps=${cfg.sustainedHighMinBtcMoveBps}, maxBtcReversalBps=${cfg.sustainedHighMaxBtcReversalBps}`);
    } else if (cfg.strategy === "latency-scalp") {
        console.log(`Params: signalRange=${cfg.latencyScalpMinSignalPrice}-${cfg.latencyScalpEntryPrice}, confirmSeconds=${cfg.latencyScalpTriggerConfirmSeconds}, entry=${cfg.latencyScalpEntryPrice}, takeProfit=${cfg.latencyScalpTakeProfitPrice}, orderUsdc=${cfg.latencyScalpOrderUsdc}, entryAge=${cfg.latencyScalpMaxEntryOrderAgeSeconds}s, maxHold=${cfg.latencyScalpMaxHoldSeconds}s, minBtcMove=${cfg.latencyScalpMinBtcMoveBps}bps, reversal=${cfg.latencyScalpMaxBtcReversalBps}bps, stopLoss=${cfg.latencyScalpStopLossPrice}`);
    } else if (cfg.strategy === "deep-rebound") {
        console.log(`Params: entry=${cfg.deepReboundMinEntryPrice}-${cfg.deepReboundMaxEntryPrice}, score=${cfg.deepReboundScoreThreshold}, minDiscount=${cfg.deepReboundMinDiscount}, takeProfitDelta=${cfg.deepReboundTakeProfitPrice}, orderUsdc=${cfg.deepReboundOrderUsdc}, maxUsdcPerLeg=${cfg.deepReboundMaxUsdcPerLeg}, stopLossPct=${cfg.deepReboundStopLossPct}`);
    } else if (cfg.strategy === "extreme-020-rebound") {
        console.log(`Params: entryAsk<=${cfg.extreme020EntryThreshold}, takeProfitDelta=${cfg.extreme020TakeProfitDelta}, orderUsdc=${cfg.extreme020OrderUsdc}, secondsLeft=${cfg.extreme020MinSecondsLeftToOpen}-${cfg.extreme020MaxSecondsLeftToOpen}, stopLossPct=${cfg.extreme020StopLossPct}, maxHold=${cfg.extreme020MaxHoldSeconds}s, forceExit=${cfg.extreme020ForceExitSecondsLeft}s`);
    } else if (cfg.strategy === "final-30-high") {
        console.log(`Params: ask>=${cfg.final30HighTriggerPrice} in final ${cfg.final30HighMaxSecondsLeftToOpen}s, ask>=${cfg.final30HighEarlyTriggerPrice} until ${cfg.final30HighEarlyMaxSecondsLeftToOpen}s, maxEntry=${cfg.final30HighMaxEntryPrice}, shares=${cfg.final30HighOrderShares}`);
    } else if (cfg.strategy === "final-30-hedged") {
        console.log(`Params: ask>=${cfg.final30HighTriggerPrice} in final ${cfg.final30HighMaxSecondsLeftToOpen}s, maxEntry=${cfg.final30HighMaxEntryPrice}, shares=${cfg.final30HighOrderShares}, maxPairCost=${cfg.final30HedgedMaxPairCost}`);
    } else if (cfg.strategy === "final-30-managed") {
        console.log(`Params: ask>=${cfg.final30HighTriggerPrice} in final ${cfg.final30HighMaxSecondsLeftToOpen}s, earlyBtcMove=$${cfg.final30ManagedEarlyBtcMinMoveUsd}/ask>=${cfg.final30ManagedEarlyBtcMinAsk}/until=${cfg.final30ManagedEarlyBtcMaxSecondsLeft}s, maxEntry=${cfg.final30HighMaxEntryPrice}, shares=${cfg.final30HighOrderShares}, takeProfitDelta=${cfg.final30ManagedTakeProfitDelta}, stopLossDelta=${cfg.final30ManagedStopLossDelta}, stopBtcReversal=${cfg.final30ManagedStopMinBtcReversalBps}bps, stopConfirm=${cfg.final30ManagedStopConfirmSeconds}s, stopMaxMargin=${cfg.final30ManagedStopMaxDirectionalMarginBps}bps`);
    } else if (cfg.strategy === "dynamic-range-pullback") {
        const params = cfg.dynamicRangePullbackParams;
        console.log(`Params: contractPullback>=${params.minContractPullback}, entry=currentAsk, syntheticSell=${params.syntheticSell}, dynamicSizing=${params.dynamicSizing}, minShares=${params.orderShares}, pairCap=${params.maxPairUsdc}, lockedProfit>=${params.minLockedProfit}, secondsLeft=${params.minSecondsLeftToOpen}-${params.maxSecondsLeftToOpen}, confirm=${params.entryConfirmSeconds}s, btcMargin>=${params.minDirectionalBtcMarginBps}bps, btcRetracement<=${params.maxBtcRetracementBps}bps, pairCosts=${params.earlyPairCost}/${params.middlePairCost}/${params.latePairCost}, stopDelta=${params.stopLossDelta}, maxNaked=${params.maxNakedSeconds}s`);
    } else if (cfg.strategy === "dynamic-range-final-managed") {
        const params = cfg.dynamicRangePullbackParams;
        console.log(`Params: dynamicPullback>=${params.minContractPullback}, syntheticSell=${params.syntheticSell}, dynamicSizing=${params.dynamicSizing}, dynamicMinShares=${params.orderShares}, dynamicPairCap=${params.maxPairUsdc}, dynamicLockedProfit>=${params.minLockedProfit}, finalTrigger=${cfg.final30HighTriggerPrice}, finalEarlyTrigger=${cfg.final30HighEarlyTriggerPrice}, finalWindow=${cfg.final30HighMinSecondsLeftToOpen}-${cfg.final30HighEarlyMaxSecondsLeftToOpen}s, finalShares=${cfg.final30HighOrderShares}`);
    } else if (cfg.strategy === "trend-range-switch") {
        console.log(`Params: switchFailures=${cfg.trendRangeSwitchFailures}, rangePrice=${cfg.rangePriceX}, trendTrigger=${cfg.trendPullbackTriggerPrice}, trendEntry=${cfg.trendPullbackEntryPrice}, trendMaxOrderAgeSeconds=${cfg.trendPullbackMaxOrderAgeSeconds}`);
    } else if (cfg.strategy === "trend-range-regime") {
        console.log(`Params: previousBand=${cfg.trendRangeRegimeBandLower}-${cfg.trendRangeRegimeBandUpper}, minBandRatio=${cfg.trendRangeRegimeMinBandRatio}, minCrosses=${cfg.trendRangeRegimeMinCrossCount}, rangePrice=${cfg.trendRangeRegimeRangePrice}, rangeUsdcPerLeg=${cfg.trendRangeRegimeRangeUsdcPerLeg}, trendMaxOrderAgeSeconds=${cfg.trendPullbackMaxOrderAgeSeconds}`);
    } else if (cfg.strategy === "trend-range-overlay") {
        console.log(`Params: trendAlwaysOn=true, previousBand=${cfg.trendRangeRegimeBandLower}-${cfg.trendRangeRegimeBandUpper}, minBandRatio=${cfg.trendRangeRegimeMinBandRatio}, minCrosses=${cfg.trendRangeRegimeMinCrossCount}, rangePair=${cfg.trendRangeOverlayRangeFirstPrice}->${cfg.trendRangeOverlayRangeSecondPrice}, rangeMaxTotalUsdc=${cfg.trendRangeOverlayMaxTotalUsdc}, conditionalTrendTakeProfit=${cfg.trendRangeOverlayTrendTakeProfitPrice}`);
    } else if (cfg.strategy === "adaptive-overlay") {
        console.log(`Params: trend+range+high+deep, deepInRange=${cfg.adaptiveOverlayDeepInRange}, deepEntry=${cfg.deepReboundMinEntryPrice}-${cfg.deepReboundMaxEntryPrice}, deepScore=${cfg.deepReboundScoreThreshold}, deepTakeProfitDelta=${cfg.deepReboundTakeProfitPrice}`);
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
        case "conditional-market-maker":
            return runConditionalMarketMakerBacktest(rows, cfg);
        case "hybrid":
            return runHybridBacktest(rows, cfg);
        case "managed-edge":
            return runManagedEdgeBacktest(rows, cfg);
        case "adaptive-edge":
            return runAdaptiveEdgeBacktest(rows, cfg);
        case "trend-pullback":
            return runTrendPullbackBacktest(rows, cfg);
        case "sustained-high":
            return runSustainedHighBacktest(rows, cfg);
        case "latency-scalp":
            return runLatencyScalpBacktest(rows, cfg);
        case "deep-rebound":
            return runDeepReboundBacktest(rows, cfg);
        case "extreme-020-rebound":
            return runExtreme020ReboundBacktest(rows, cfg);
        case "final-30-high":
            return runFinal30HighBacktest(rows, cfg);
        case "final-30-hedged":
            return runFinal30HedgedBacktest(rows, cfg);
        case "final-30-managed":
            return runFinal30ManagedBacktest(rows, cfg);
        case "dynamic-range-pullback":
            return runDynamicRangePullbackBacktest(rows, cfg);
        case "dynamic-range-final-managed":
            return runDynamicRangeFinalManagedBacktest(rows, cfg);
        case "trend-range-switch":
            return runTrendRangeSwitchBacktest(rows, cfg);
        case "trend-range-regime":
            return runTrendRangeRegimeBacktest(rows, cfg);
        case "trend-range-overlay":
            return runTrendRangeOverlayBacktest(rows, cfg);
        case "adaptive-overlay":
            return runAdaptiveOverlayBacktest(rows, cfg);
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
