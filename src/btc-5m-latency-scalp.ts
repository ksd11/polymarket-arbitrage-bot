import "./setup-proxy";
import "./patch-exchange-v2";

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { ClobClient, CreateOrderOptions, OrderType, Side, UserOrderV2 as UserOrder } from "@polymarket/clob-client-v2";
import { config } from "./config";
import { getClobClient } from "./providers/clobclient";
import { BtcPriceProvider, defaultBtcPriceConfig } from "./providers/btcPriceProvider";
import { MarketResolvedPayload, WebSocketOrderBook } from "./providers/websocketOrderbook";
import { approveUSDCAllowance, updateClobBalanceAllowance } from "./security/allowance";
import { createCredential } from "./security/createCredential";
import { validatePrivateKey } from "./security/validatePrivateKey";
import { buildBtc5mLatencyScalpOrders, Btc5mLatencyScalpParams, Btc5mLatencyScalpState } from "./strategies/btc5m/latency-scalp";
import { buildBtc5mDeepReboundOrders, Btc5mDeepReboundParams } from "./strategies/btc5m/deep-rebound";
import { buildBtc5mFinal30HighOrders, Btc5mFinal30HighParams } from "./strategies/btc5m/final-30-high";
import { buildBtc5mFinal30ManagedOrders, Btc5mFinal30ManagedParams, Btc5mFinal30ManagedPosition, final30ManagedDirectionalMarginBps, final30ManagedSession } from "./strategies/btc5m/final-30-managed";
import { buildBtc5mUndervaluedHoldOrders, Btc5mUndervaluedHoldParams, Btc5mUndervaluedHoldPosition } from "./strategies/btc5m/undervalued-hold";
import { buildBtc5mUndervaluedFinalManagedOrders, Btc5mUndervaluedFinalManagedDecision } from "./strategies/btc5m/undervalued-final-managed";
import { buildDynamicRangeHedgePlan, Btc5mDynamicRangePairPlan, Btc5mDynamicRangePullbackParams, Btc5mDynamicRangePullbackState } from "./strategies/btc5m/dynamic-range-pullback";
import { buildBtc5mDynamicRangeFinalManagedOrders, Btc5mDynamicRangeFinalManagedDecision } from "./strategies/btc5m/dynamic-range-final-managed";
import { Btc5mRegimeSnapshot } from "./strategies/btc5m/regime";
import { waitForMinimumUsdcBalance } from "./utils/balance";
import { setupConsoleFileLogging } from "./utils/console-file";
import { executionsForOrder, summarizeOrderExecutions } from "./utils/clob-order-reconciliation";
import { addHoldings, removeHoldings } from "./utils/holdings";
import { logger } from "./utils/logger";

type Leg = "UP" | "DOWN";
type Role = "entry" | "dynamic-entry" | "dynamic-hedge" | "final-entry" | "take-profit" | "risk-exit";

type RunnerConfig = {
    mode: "latency-scalp" | "deep-rebound" | "final-30-high" | "final-30-managed" | "undervalued-hold" | "undervalued-final-managed" | "dynamic-range-final-managed";
    dryRun: boolean;
    market: string;
    intervalMinutes: number;
    tickSize: CreateOrderOptions["tickSize"];
    negRisk: boolean;
    evaluationIntervalMs: number;
    orderPollIntervalMs: number;
    orderRetryIntervalMs: number;
    orderReconcileGraceMs: number;
    entryMaxAgeSeconds: number;
    marketLogIntervalMs: number;
    recordIntervalMs: number;
    btcPriceRefreshMs: number;
    btcPriceMaxStaleMs: number;
    btcPriceUrls: string[];
    recordEnabled: boolean;
    recordPath: string;
    params: Btc5mLatencyScalpParams;
    deepParams: Btc5mDeepReboundParams;
    final30HighParams: Btc5mFinal30HighParams;
    final30ManagedParams: Btc5mFinal30ManagedParams;
    undervaluedHoldParams: Btc5mUndervaluedHoldParams;
    dynamicRangePullbackParams: Btc5mDynamicRangePullbackParams;
};

type Tokens = {
    slug: string;
    conditionId: string;
    upTokenId: string;
    downTokenId: string;
    startMs: number;
    endMs: number;
};

type TrackedOrder = {
    role: Role;
    leg: Leg;
    side: "BUY" | "SELL";
    orderId: string;
    tokenId: string;
    price: number;
    size: number;
    filledSize: number;
    accountedFilledSize: number;
    accountedNotional: number;
    status: string;
    placedAtMs: number;
    cancelledAtMs?: number;
    accounting: Accounting;
    executionIds: string[];
    dynamicEntryPlan?: Btc5mDynamicRangePairPlan;
};

type Accounting = {
    tokens: Tokens;
    entryLeg?: Leg;
    cost: number;
    shares: number;
    proceeds: number;
    soldShares: number;
    sharesUp: number;
    sharesDown: number;
    soldUp: number;
    soldDown: number;
    resolving?: boolean;
    resolved: boolean;
};

const HEADERS = [
    "row_type", "timestamp", "timestamp_ms", "slug", "condition_id", "dry_run",
    "btc_price", "open_price", "seconds_left", "up_bid", "up_ask", "down_bid", "down_ask",
    "candidate_leg", "triggered_leg", "state_filled", "state_cancelled", "state_exited", "decision_reason", "quotes",
    "strategy_component", "dynamic_entry_leg", "dynamic_entry_shares", "dynamic_synthetic_sell", "dynamic_planned_exit_price", "dynamic_planned_hedge_price", "dynamic_planned_hedge_shares", "dynamic_planned_locked_profit", "dynamic_paired", "dynamic_exited", "final_blocked",
    "event_role", "event_leg", "event_side", "event_price", "event_size", "event_cost", "event_notional", "execution_source", "execution_ids", "order_id", "order_status", "filled_size", "event_error",
    "winning_outcome", "entry_cost", "exit_proceeds", "settlement_payout", "pnl",
] as const;
type RecordRow = Partial<Record<typeof HEADERS[number], string | number | boolean>>;

function envString(name: string, fallback: string): string { return process.env[name]?.trim() || fallback; }
function envNumber(name: string, fallback: number): number { const value = Number(process.env[name]?.trim()); return Number.isFinite(value) ? value : fallback; }
function envBool(name: string, fallback: boolean): boolean { const value = process.env[name]?.trim(); return value ? value.toLowerCase() === "true" : fallback; }
function parseList(value: string): string[] { return value.split(/[|,]/).map((item) => item.trim()).filter(Boolean); }
function optional(value: number | null | undefined, digits = 6): string | undefined { return value === null || value === undefined || !Number.isFinite(value) ? undefined : value.toFixed(digits); }
function csvValue(value: RecordRow[keyof RecordRow]): string { if (value === undefined) return ""; const text = String(value); return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
function appendRecord(path: string, row: RecordRow): void { mkdirSync(dirname(path), { recursive: true }); if (!existsSync(path)) appendFileSync(path, `${HEADERS.join(",")}\n`); appendFileSync(path, `${HEADERS.map((header) => csvValue(row[header])).join(",")}\n`); }
function isFinal(status: string): boolean { return ["FILLED", "MATCHED", "CANCELLED", "CANCELED", "REJECTED", "FAILED"].includes(status.toUpperCase()); }
function orderFilledSize(order: any): number { const value = Number(order?.size_matched ?? order?.sizeMatched ?? order?.filled_size ?? order?.filledSize ?? 0); return Number.isFinite(value) ? value : 0; }
function formatError(error: unknown): string {
    const value = error as any;
    const message = error instanceof Error ? error.message : String(error);
    const details = value?.response?.data ?? value?.data ?? value?.error;
    if (details === undefined) return message;
    try { return `${message} ${typeof details === "string" ? details : JSON.stringify(details)}`; }
    catch { return message; }
}
function loadConfig(): RunnerConfig {
    const btc = defaultBtcPriceConfig();
    const requestedMode = process.env.BTC5M_SCALP_MODE;
    const mode: RunnerConfig["mode"] = requestedMode === "deep-rebound" ? "deep-rebound" : requestedMode === "final-30-high" ? "final-30-high" : requestedMode === "final-30-managed" ? "final-30-managed" : requestedMode === "undervalued-hold" ? "undervalued-hold" : requestedMode === "undervalued-final-managed" ? "undervalued-final-managed" : requestedMode === "dynamic-range-final-managed" ? "dynamic-range-final-managed" : "latency-scalp";
    const deep = mode === "deep-rebound";
    const final30High = mode === "final-30-high";
    const final30Managed = mode === "final-30-managed";
    const undervaluedHold = mode === "undervalued-hold";
    const undervaluedFinalManaged = mode === "undervalued-final-managed";
    const dynamicRangeFinalManaged = mode === "dynamic-range-final-managed";
    const prefix = deep ? "DEEP_REBOUND" : final30High ? "FINAL_30_HIGH" : final30Managed ? "FINAL_30_MANAGED" : undervaluedHold ? "UNDERVALUED_HOLD" : undervaluedFinalManaged ? "UNDERVALUED_FINAL_MANAGED" : dynamicRangeFinalManaged ? "DYNAMIC_RANGE_FINAL_MANAGED" : "LATENCY_SCALP";
    const cfg: RunnerConfig = {
        mode,
        dryRun: envBool(`${prefix}_DRY_RUN`, true), market: envString(`${prefix}_MARKET`, "btc").toLowerCase(),
        intervalMinutes: envNumber(`${prefix}_INTERVAL_MINUTES`, 5), tickSize: envString(`${prefix}_TICK_SIZE`, "0.01") as CreateOrderOptions["tickSize"],
        negRisk: envBool(`${prefix}_NEG_RISK`, config.copytrade.negRisk), evaluationIntervalMs: envNumber(`${prefix}_EVALUATION_INTERVAL_MS`, deep ? 250 : 100),
        orderPollIntervalMs: envNumber(`${prefix}_ORDER_POLL_INTERVAL_MS`, deep ? 500 : 250), marketLogIntervalMs: envNumber(`${prefix}_MARKET_LOG_INTERVAL_MS`, 1000),
        orderRetryIntervalMs: envNumber(`${prefix}_ORDER_RETRY_INTERVAL_MS`, 1_000), entryMaxAgeSeconds: envNumber(`${prefix}_ENTRY_MAX_AGE_SECONDS`, final30Managed ? 12 : 2),
        orderReconcileGraceMs: envNumber(`${prefix}_ORDER_RECONCILE_GRACE_MS`, 5_000),
        recordIntervalMs: envNumber(`${prefix}_RECORD_INTERVAL_MS`, 1000), btcPriceRefreshMs: envNumber(`${prefix}_BTC_PRICE_REFRESH_MS`, Math.min(250, btc.refreshIntervalMs)),
        btcPriceMaxStaleMs: envNumber(`${prefix}_BTC_PRICE_MAX_STALE_MS`, btc.maxStalenessMs), btcPriceUrls: parseList(envString(`${prefix}_BTC_PRICE_URLS`, btc.urls.join("|"))),
        recordEnabled: envBool(`${prefix}_RECORD_ENABLED`, true), recordPath: resolve(envString(`${prefix}_RECORD_FILE`, `data/btc5m-${mode}-live.csv`)),
        params: {
            minSignalPrice: envNumber("LATENCY_SCALP_MIN_SIGNAL_PRICE", 0.72),
            triggerConfirmSeconds: envNumber("LATENCY_SCALP_TRIGGER_CONFIRM_SECONDS", 2),
            signalLookbackSeconds: envNumber("LATENCY_SCALP_SIGNAL_LOOKBACK_SECONDS", 5),
            minContractMomentum: envNumber("LATENCY_SCALP_MIN_CONTRACT_MOMENTUM", 0.03),
            minBtcMomentumBps: envNumber("LATENCY_SCALP_MIN_BTC_MOMENTUM_BPS", 0),
            entryPrice: envNumber("LATENCY_SCALP_ENTRY_PRICE", 0.75),
            takeProfitPrice: envNumber("LATENCY_SCALP_TAKE_PROFIT_PRICE", 0.80),
            orderUsdc: envNumber("LATENCY_SCALP_ORDER_USDC", 3.75),
            maxSecondsLeftToTrigger: envNumber("LATENCY_SCALP_MAX_SECONDS_LEFT_TO_TRIGGER", 180),
            minSecondsLeftToTrigger: envNumber("LATENCY_SCALP_MIN_SECONDS_LEFT_TO_TRIGGER", 45),
            maxEntryOrderAgeSeconds: envNumber("LATENCY_SCALP_MAX_ENTRY_ORDER_AGE_SECONDS", 15),
            maxHoldSeconds: envNumber("LATENCY_SCALP_MAX_HOLD_SECONDS", 30),
            minBtcMoveBps: envNumber("LATENCY_SCALP_MIN_BTC_MOVE_BPS", 3),
            maxBtcReversalBps: envNumber("LATENCY_SCALP_MAX_BTC_REVERSAL_BPS", 3),
            stopLossPrice: envNumber("LATENCY_SCALP_STOP_LOSS_PRICE", 0.70),
            forceExitSecondsLeft: envNumber("LATENCY_SCALP_FORCE_EXIT_SECONDS_LEFT", 20),
        },
        deepParams: {
            intervalMinutes: envNumber("DEEP_REBOUND_INTERVAL_MINUTES", 5),
            volPerInterval: envNumber("DEEP_REBOUND_VOL_PER_INTERVAL", 0.0015),
            minEntryPrice: envNumber("DEEP_REBOUND_MIN_ENTRY_PRICE", 0.03),
            maxEntryPrice: envNumber("DEEP_REBOUND_MAX_ENTRY_PRICE", 0.10),
            orderUsdc: envNumber("DEEP_REBOUND_ORDER_USDC", 1.01),
            maxUsdcPerLeg: envNumber("DEEP_REBOUND_MAX_USDC_PER_LEG", 1.01),
            scoreThreshold: envNumber("DEEP_REBOUND_SCORE_THRESHOLD", 0.20),
            minDiscount: envNumber("DEEP_REBOUND_MIN_DISCOUNT", 0.05),
            takeProfitPrice: envNumber("DEEP_REBOUND_TAKE_PROFIT_PRICE", 0.05),
            stopLossPct: envNumber("DEEP_REBOUND_STOP_LOSS_PCT", 0.50),
            minSecondsLeftToOpen: envNumber("DEEP_REBOUND_MIN_SECONDS_LEFT_TO_OPEN", 60),
            maxSecondsLeftToOpen: envNumber("DEEP_REBOUND_MAX_SECONDS_LEFT_TO_OPEN", 240),
            forceExitSecondsLeft: envNumber("DEEP_REBOUND_FORCE_EXIT_SECONDS_LEFT", 30),
        },
        final30HighParams: {
            triggerPrice: envNumber("FINAL_30_HIGH_TRIGGER_PRICE", 0.85),
            earlyTriggerPrice: envNumber("FINAL_30_HIGH_EARLY_TRIGGER_PRICE", 0.90),
            maxEntryPrice: envNumber("FINAL_30_HIGH_MAX_ENTRY_PRICE", 0.90),
            orderShares: envNumber("FINAL_30_HIGH_ORDER_SHARES", 2),
            maxSecondsLeftToOpen: envNumber("FINAL_30_HIGH_MAX_SECONDS_LEFT_TO_OPEN", 30),
            earlyMaxSecondsLeftToOpen: envNumber("FINAL_30_HIGH_EARLY_MAX_SECONDS_LEFT_TO_OPEN", 30),
            minSecondsLeftToOpen: envNumber("FINAL_30_HIGH_MIN_SECONDS_LEFT_TO_OPEN", 0),
        },
        final30ManagedParams: {
            triggerPrice: envNumber("FINAL_30_MANAGED_TRIGGER_PRICE", envNumber("FINAL_30_HIGH_TRIGGER_PRICE", 0.85)),
            earlyTriggerPrice: envNumber("FINAL_30_MANAGED_EARLY_TRIGGER_PRICE", envNumber("FINAL_30_HIGH_EARLY_TRIGGER_PRICE", 0.90)),
            maxEntryPrice: envNumber("FINAL_30_MANAGED_MAX_ENTRY_PRICE", envNumber("FINAL_30_HIGH_MAX_ENTRY_PRICE", 0.90)),
            orderShares: envNumber("FINAL_30_MANAGED_ORDER_SHARES", 5),
            maxSecondsLeftToOpen: envNumber("FINAL_30_MANAGED_MAX_SECONDS_LEFT_TO_OPEN", envNumber("FINAL_30_HIGH_MAX_SECONDS_LEFT_TO_OPEN", 30)),
            earlyMaxSecondsLeftToOpen: envNumber("FINAL_30_MANAGED_EARLY_MAX_SECONDS_LEFT_TO_OPEN", envNumber("FINAL_30_HIGH_EARLY_MAX_SECONDS_LEFT_TO_OPEN", 30)),
            minSecondsLeftToOpen: envNumber("FINAL_30_MANAGED_MIN_SECONDS_LEFT_TO_OPEN", 8),
            earlyBtcMinMoveUsd: envNumber("FINAL_30_MANAGED_EARLY_BTC_MIN_MOVE_USD", 0),
            earlyBtcMinAsk: envNumber("FINAL_30_MANAGED_EARLY_BTC_MIN_ASK", 0.85),
            earlyBtcMaxSecondsLeftToOpen: envNumber("FINAL_30_MANAGED_EARLY_BTC_MAX_SECONDS_LEFT", 90),
            btcDirectionRequired: envBool("FINAL_30_MANAGED_BTC_DIRECTION_REQUIRED", true),
            trendAtrLookbackSeconds: envNumber("FINAL_30_MANAGED_TREND_ATR_LOOKBACK_SECONDS", 14),
            trendMinGapSafety: envNumber("FINAL_30_MANAGED_TREND_MIN_GAP_SAFETY", 0),
            trendMinPeakGapRatio: envNumber("FINAL_30_MANAGED_TREND_MIN_PEAK_GAP_RATIO", 0.80),
            trendMaxSpread: envNumber("FINAL_30_MANAGED_TREND_MAX_SPREAD", 0.03),
            timezoneOffsetHours: envNumber("FINAL_30_MANAGED_TIMEZONE_OFFSET_HOURS", 8),
            dayStartHour: envNumber("FINAL_30_MANAGED_DAY_START_HOUR", 9),
            dayEndHour: envNumber("FINAL_30_MANAGED_DAY_END_HOUR", 21),
            dayMinDirectionalMarginBps: envNumber("FINAL_30_MANAGED_DAY_MIN_BTC_MARGIN_BPS", 2),
            nightMinDirectionalMarginBps: envNumber("FINAL_30_MANAGED_NIGHT_MIN_BTC_MARGIN_BPS", 1),
            takeProfitDelta: envNumber("FINAL_30_MANAGED_TAKE_PROFIT_DELTA", 0),
            stopLossDelta: envNumber("FINAL_30_MANAGED_STOP_LOSS_DELTA", 0.10),
            stopMinBtcReversalBps: envNumber("FINAL_30_MANAGED_STOP_MIN_BTC_REVERSAL_BPS", 2),
            stopConfirmSeconds: envNumber("FINAL_30_MANAGED_STOP_CONFIRM_SECONDS", 2),
            stopMaxDirectionalMarginBps: envNumber("FINAL_30_MANAGED_STOP_MAX_DIRECTIONAL_MARGIN_BPS", 999),
        },
        undervaluedHoldParams: {
            minEntryPrice: envNumber("UNDERVALUED_HOLD_MIN_ENTRY_PRICE", 0.30),
            maxEntryPrice: envNumber("UNDERVALUED_HOLD_MAX_ENTRY_PRICE", 0.50),
            orderShares: envNumber("UNDERVALUED_HOLD_ORDER_SHARES", 5),
            minSecondsLeftToOpen: envNumber("UNDERVALUED_HOLD_MIN_SECONDS_LEFT_TO_OPEN", 90),
            maxSecondsLeftToOpen: envNumber("UNDERVALUED_HOLD_MAX_SECONDS_LEFT_TO_OPEN", 300),
            minDirectionalBtcMarginBps: envNumber("UNDERVALUED_HOLD_MIN_BTC_MARGIN_BPS", 1),
            stopLossPct: envNumber("UNDERVALUED_HOLD_STOP_LOSS_PCT", 0.20),
        },
        dynamicRangePullbackParams: {
            minContractPullback: envNumber("DYNAMIC_RANGE_PULLBACK_MIN_CONTRACT_PULLBACK", 0.20),
            minOrderNotional: envNumber("DYNAMIC_RANGE_PULLBACK_MIN_ORDER_NOTIONAL", 1.01),
            orderShares: envNumber("DYNAMIC_RANGE_PULLBACK_ORDER_SHARES", 2),
            syntheticSell: envBool("DYNAMIC_RANGE_PULLBACK_SYNTHETIC_SELL", true),
            dynamicSizing: envBool("DYNAMIC_RANGE_PULLBACK_DYNAMIC_SIZING", true),
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
    };
    if (!deep && !(cfg.params.minSignalPrice > 0 && cfg.params.minSignalPrice <= cfg.params.entryPrice && cfg.params.entryPrice < cfg.params.takeProfitPrice && cfg.params.takeProfitPrice < 1)) throw new Error("Invalid latency-scalp prices");
    if (deep && !(cfg.deepParams.minEntryPrice > 0 && cfg.deepParams.minEntryPrice < cfg.deepParams.maxEntryPrice && cfg.deepParams.maxEntryPrice < 1)) throw new Error("Invalid deep-rebound prices");
    if (deep && (cfg.deepParams.orderUsdc < 1.01 || cfg.deepParams.maxUsdcPerLeg < cfg.deepParams.orderUsdc)) throw new Error("Marketable deep-rebound BUY requires DEEP_REBOUND_ORDER_USDC >= 1.01 and matching max budget");
    if (final30High && (!(cfg.final30HighParams.triggerPrice > 0.5 && cfg.final30HighParams.triggerPrice < 1 && cfg.final30HighParams.earlyTriggerPrice >= cfg.final30HighParams.triggerPrice && cfg.final30HighParams.earlyTriggerPrice <= cfg.final30HighParams.maxEntryPrice && cfg.final30HighParams.maxEntryPrice < 1) || cfg.final30HighParams.orderShares <= 0 || cfg.final30HighParams.earlyMaxSecondsLeftToOpen < cfg.final30HighParams.maxSecondsLeftToOpen)) throw new Error("Invalid FINAL_30_HIGH tiered configuration");
    if ((final30Managed || undervaluedFinalManaged || dynamicRangeFinalManaged) && (!(cfg.final30ManagedParams.triggerPrice > 0.5 && cfg.final30ManagedParams.triggerPrice < 1 && cfg.final30ManagedParams.earlyTriggerPrice >= cfg.final30ManagedParams.triggerPrice && cfg.final30ManagedParams.earlyTriggerPrice <= cfg.final30ManagedParams.maxEntryPrice && cfg.final30ManagedParams.maxEntryPrice < 1) || cfg.final30ManagedParams.orderShares <= 0 || cfg.final30ManagedParams.earlyMaxSecondsLeftToOpen < cfg.final30ManagedParams.maxSecondsLeftToOpen || cfg.final30ManagedParams.earlyBtcMinMoveUsd < 0 || cfg.final30ManagedParams.earlyBtcMinAsk <= 0.5 || cfg.final30ManagedParams.earlyBtcMinAsk > cfg.final30ManagedParams.maxEntryPrice || cfg.final30ManagedParams.earlyBtcMaxSecondsLeftToOpen <= cfg.final30ManagedParams.maxSecondsLeftToOpen || cfg.final30ManagedParams.trendAtrLookbackSeconds <= 0 || cfg.final30ManagedParams.trendMinGapSafety < 0 || cfg.final30ManagedParams.trendMinPeakGapRatio < 0 || cfg.final30ManagedParams.trendMinPeakGapRatio > 1 || cfg.final30ManagedParams.trendMaxSpread < 0 || !Number.isInteger(cfg.final30ManagedParams.timezoneOffsetHours) || cfg.final30ManagedParams.timezoneOffsetHours < -23 || cfg.final30ManagedParams.timezoneOffsetHours > 23 || !Number.isInteger(cfg.final30ManagedParams.dayStartHour) || cfg.final30ManagedParams.dayStartHour < 0 || cfg.final30ManagedParams.dayStartHour > 23 || !Number.isInteger(cfg.final30ManagedParams.dayEndHour) || cfg.final30ManagedParams.dayEndHour < 0 || cfg.final30ManagedParams.dayEndHour > 23 || cfg.final30ManagedParams.dayStartHour === cfg.final30ManagedParams.dayEndHour || cfg.final30ManagedParams.dayMinDirectionalMarginBps < 0 || cfg.final30ManagedParams.nightMinDirectionalMarginBps < 0 || cfg.final30ManagedParams.takeProfitDelta < 0 || cfg.final30ManagedParams.stopLossDelta < 0 || cfg.final30ManagedParams.stopMinBtcReversalBps < 0 || cfg.final30ManagedParams.stopConfirmSeconds < 0 || cfg.final30ManagedParams.stopMaxDirectionalMarginBps < 0)) throw new Error("Invalid FINAL_30_MANAGED configuration");
    if ((undervaluedHold || undervaluedFinalManaged) && (!(cfg.undervaluedHoldParams.minEntryPrice > 0 && cfg.undervaluedHoldParams.minEntryPrice < cfg.undervaluedHoldParams.maxEntryPrice && cfg.undervaluedHoldParams.maxEntryPrice < 1) || cfg.undervaluedHoldParams.orderShares <= 0 || cfg.undervaluedHoldParams.minSecondsLeftToOpen < 0 || cfg.undervaluedHoldParams.maxSecondsLeftToOpen <= cfg.undervaluedHoldParams.minSecondsLeftToOpen || cfg.undervaluedHoldParams.minDirectionalBtcMarginBps <= 0 || !(cfg.undervaluedHoldParams.stopLossPct >= 0 && cfg.undervaluedHoldParams.stopLossPct < 1))) throw new Error("Invalid UNDERVALUED_HOLD configuration");
    const dynamic = cfg.dynamicRangePullbackParams;
    if (dynamicRangeFinalManaged && (!(dynamic.minContractPullback > 0 && dynamic.minContractPullback < 1) || dynamic.minOrderNotional <= 0 || dynamic.orderShares <= 0 || dynamic.maxPairUsdc < dynamic.minOrderNotional * 2 || dynamic.minLockedProfit < 0 || dynamic.shareStep <= 0 || dynamic.maxSecondsLeftToOpen <= dynamic.minSecondsLeftToOpen || dynamic.maxSpread <= 0 || dynamic.entryConfirmSeconds < 0 || !(dynamic.earlyPairCost > 0 && dynamic.earlyPairCost <= dynamic.middlePairCost && dynamic.middlePairCost <= dynamic.latePairCost && dynamic.latePairCost < 1) || dynamic.stopLossDelta <= 0 || dynamic.stopConfirmSeconds < 0 || dynamic.maxNakedSeconds < 0)) throw new Error("Invalid DYNAMIC_RANGE_PULLBACK configuration");
    if ((deep ? cfg.deepParams.orderUsdc : cfg.params.orderUsdc) <= 0 || cfg.evaluationIntervalMs < 50 || cfg.orderPollIntervalMs < 100 || cfg.orderRetryIntervalMs < 250 || cfg.entryMaxAgeSeconds <= 0) throw new Error("Invalid scalp budget or intervals");
    return cfg;
}

function cycleNow(market: string, intervalMinutes: number): { slug: string; startMs: number; endMs: number } {
    const intervalMs = intervalMinutes * 60_000;
    const startMs = Math.floor(Date.now() / intervalMs) * intervalMs;
    return { slug: `${market}-updown-${intervalMinutes}m-${Math.floor(startMs / 1000)}`, startMs, endMs: startMs + intervalMs };
}

function parseArray(raw: unknown): string[] { if (typeof raw !== "string") throw new Error("Expected JSON array string"); const value = JSON.parse(raw); if (!Array.isArray(value)) throw new Error("Expected JSON array"); return value.map(String); }

async function fetchTokens(cycle: { slug: string; startMs: number; endMs: number }): Promise<Tokens> {
    const response = await fetch(`https://gamma-api.polymarket.com/markets/slug/${cycle.slug}`);
    if (!response.ok) throw new Error(`Gamma API ${response.status} for ${cycle.slug}`);
    const market = await response.json() as any;
    const outcomes = parseArray(market.outcomes); const ids = parseArray(market.clobTokenIds);
    const up = outcomes.indexOf("Up"); const down = outcomes.indexOf("Down");
    if (up < 0 || down < 0 || !ids[up] || !ids[down]) throw new Error(`Missing tokens for ${cycle.slug}`);
    return { ...cycle, conditionId: String(market.conditionId || ""), upTokenId: ids[up], downTokenId: ids[down] };
}

class LatencyScalpBot {
    private ws: WebSocketOrderBook | null = null;
    private btc: BtcPriceProvider;
    private tokens: Tokens | null = null;
    private state: Btc5mLatencyScalpState = {};
    private dynamicState: Btc5mDynamicRangePullbackState = {};
    private managedPosition?: Btc5mFinal30ManagedPosition;
    private undervaluedPosition?: Btc5mUndervaluedHoldPosition;
    private finalBlocked = false;
    private history: Btc5mRegimeSnapshot[] = [];
    private btcOpenPrice?: number;
    private lastBtcPrice?: number;
    private entryOrder: TrackedOrder | null = null;
    private exitOrder: TrackedOrder | null = null;
    private trackedOrders = new Map<string, TrackedOrder>();
    private accounting: Accounting | null = null;
    private accountingByAsset = new Map<string, Accounting>();
    private timers: NodeJS.Timeout[] = [];
    private evaluating = false;
    private polling = false;
    private switching = false;
    private stopped = false;
    private lastRecordAt = 0;
    private lastMarketLogAt = 0;
    private nextOrderAttemptAt = 0;
    private executionVersion = 0;

    constructor(private client: ClobClient, private cfg: RunnerConfig) {
        this.btc = new BtcPriceProvider({ urls: cfg.btcPriceUrls, refreshIntervalMs: cfg.btcPriceRefreshMs, maxStalenessMs: cfg.btcPriceMaxStaleMs });
    }

    async start(): Promise<void> {
        const p = this.cfg.params;
        const description = this.cfg.mode === "deep-rebound"
            ? `entry=${this.cfg.deepParams.minEntryPrice}-${this.cfg.deepParams.maxEntryPrice}, score=${this.cfg.deepParams.scoreThreshold}, takeProfitDelta=${this.cfg.deepParams.takeProfitPrice}`
            : this.cfg.mode === "final-30-high"
                ? `ask>=${this.cfg.final30HighParams.earlyTriggerPrice} until ${this.cfg.final30HighParams.earlyMaxSecondsLeftToOpen}s, then >=${this.cfg.final30HighParams.triggerPrice} in final ${this.cfg.final30HighParams.maxSecondsLeftToOpen}s, max=${this.cfg.final30HighParams.maxEntryPrice}, shares=${this.cfg.final30HighParams.orderShares}`
                : this.cfg.mode === "final-30-managed"
                    ? `ask>=${this.cfg.final30ManagedParams.triggerPrice} in final ${this.cfg.final30ManagedParams.maxSecondsLeftToOpen}s, max=${this.cfg.final30ManagedParams.maxEntryPrice}, shares=${this.cfg.final30ManagedParams.orderShares}, BTC margin day=${this.cfg.final30ManagedParams.dayMinDirectionalMarginBps}bps/night=${this.cfg.final30ManagedParams.nightMinDirectionalMarginBps}bps (${this.cfg.final30ManagedParams.dayStartHour}:00-${this.cfg.final30ManagedParams.dayEndHour}:00 UTC${this.cfg.final30ManagedParams.timezoneOffsetHours >= 0 ? "+" : ""}${this.cfg.final30ManagedParams.timezoneOffsetHours}), entryMaxAge=${this.cfg.entryMaxAgeSeconds}s, takeProfitDelta=${this.cfg.final30ManagedParams.takeProfitDelta}, stopLossDelta=${this.cfg.final30ManagedParams.stopLossDelta}, btcReversal=${this.cfg.final30ManagedParams.stopMinBtcReversalBps}bps/${this.cfg.final30ManagedParams.stopConfirmSeconds}s`
                : this.cfg.mode === "undervalued-hold"
                    ? `entry=${this.cfg.undervaluedHoldParams.minEntryPrice}-${this.cfg.undervaluedHoldParams.maxEntryPrice}, BTC margin>=${this.cfg.undervaluedHoldParams.minDirectionalBtcMarginBps}bps, window=${this.cfg.undervaluedHoldParams.minSecondsLeftToOpen}-${this.cfg.undervaluedHoldParams.maxSecondsLeftToOpen}s, shares=${this.cfg.undervaluedHoldParams.orderShares}, stopLoss=${(this.cfg.undervaluedHoldParams.stopLossPct * 100).toFixed(1)}%, noTakeProfit=true`
                : this.cfg.mode === "undervalued-final-managed"
                    ? `undervalued until final ${this.cfg.final30ManagedParams.earlyMaxSecondsLeftToOpen}s, entry=${this.cfg.undervaluedHoldParams.minEntryPrice}-${this.cfg.undervaluedHoldParams.maxEntryPrice}, BTC margin>=${this.cfg.undervaluedHoldParams.minDirectionalBtcMarginBps}bps, stopLoss=${(this.cfg.undervaluedHoldParams.stopLossPct * 100).toFixed(1)}%; final trigger=${this.cfg.final30ManagedParams.triggerPrice}, shares=${this.cfg.final30ManagedParams.orderShares}`
                : this.cfg.mode === "dynamic-range-final-managed"
                    ? `dynamicPullback>=${this.cfg.dynamicRangePullbackParams.minContractPullback}, syntheticSell=${this.cfg.dynamicRangePullbackParams.syntheticSell}, dynamicSizing=${this.cfg.dynamicRangePullbackParams.dynamicSizing}, dynamicPairCap=${this.cfg.dynamicRangePullbackParams.maxPairUsdc}, dynamicLockedProfit>=${this.cfg.dynamicRangePullbackParams.minLockedProfit}, finalTrigger=${this.cfg.final30ManagedParams.triggerPrice}, finalShares=${this.cfg.final30ManagedParams.orderShares}`
                : `signal=${p.minSignalPrice}-${p.entryPrice}, momentum=${p.minContractMomentum}, entry=${p.entryPrice}, takeProfit=${p.takeProfitPrice}`;
        logger.info(`Starting ${this.cfg.mode}: ${description}, dryRun=${this.cfg.dryRun}`);
        logger.info(`Trajectory CSV: ${this.cfg.recordPath}`);
        await this.btc.start();
        this.ws = new WebSocketOrderBook("market", [], null, -1);
        await this.ws.connect();
        this.ws.onMarketResolved((payload) => void this.handleResolution(payload));
        await this.initializeCycle();
        this.timers.push(setInterval(() => void this.cycleTick(), 1_000));
        this.timers.push(setInterval(() => void this.evaluate(), this.cfg.evaluationIntervalMs));
        this.timers.push(setInterval(() => void this.pollOrders(), this.cfg.orderPollIntervalMs));
    }

    async stop(): Promise<void> {
        this.stopped = true;
        for (const timer of this.timers) clearInterval(timer);
        await this.cancelOrder(this.entryOrder, "shutdown");
        await this.cancelOrder(this.exitOrder, "shutdown");
        this.btc.stop(); this.ws?.disconnect();
    }

    private async cycleTick(): Promise<void> {
        if (this.stopped || this.switching || this.evaluating || this.polling) return;
        const cycle = cycleNow(this.cfg.market, this.cfg.intervalMinutes);
        if (this.tokens?.slug === cycle.slug) return;
        this.switching = true;
        try {
            await this.cancelOrder(this.entryOrder, "new cycle");
            await this.cancelOrder(this.exitOrder, "new cycle");
            this.resetCycle();
            await this.initializeCycle();
        } finally { this.switching = false; }
    }

    private resetCycle(): void {
        this.tokens = null; this.state = {}; this.dynamicState = {}; this.managedPosition = undefined; this.undervaluedPosition = undefined; this.finalBlocked = false; this.history = []; this.btcOpenPrice = undefined; this.lastBtcPrice = undefined;
        this.entryOrder = null; this.exitOrder = null; this.accounting = null; this.lastRecordAt = 0; this.lastMarketLogAt = 0;
    }

    private async initializeCycle(): Promise<void> {
        try {
            const tokens = await fetchTokens(cycleNow(this.cfg.market, this.cfg.intervalMinutes));
            this.tokens = tokens;
            this.accounting = { tokens, cost: 0, shares: 0, proceeds: 0, soldShares: 0, sharesUp: 0, sharesDown: 0, soldUp: 0, soldDown: 0, resolved: false };
            this.accountingByAsset.set(tokens.upTokenId, this.accounting); this.accountingByAsset.set(tokens.downTokenId, this.accounting);
            if (!this.ws) throw new Error("WebSocket unavailable");
            this.ws.subscribeToTokenIds([tokens.upTokenId, tokens.downTokenId]);
            this.ws.setTokenLabel(tokens.upTokenId, "Up"); this.ws.setTokenLabel(tokens.downTokenId, "Down"); this.ws.setTokenPair(tokens.upTokenId, tokens.downTokenId);
            this.ws.onPriceUpdate(tokens.upTokenId, () => undefined); this.ws.onPriceUpdate(tokens.downTokenId, () => undefined);
            logger.info(`Cycle ready: ${tokens.slug}`);
        } catch (error) { logger.error(`Failed to initialize latency-scalp cycle: ${error instanceof Error ? error.message : String(error)}`); }
    }

    private async evaluate(): Promise<void> {
        if (this.stopped || this.switching || this.evaluating || this.polling || !this.tokens || !this.ws) return;
        this.evaluating = true;
        try {
            const now = Date.now(); const secondsLeft = Math.max(0, (this.tokens.endMs - now) / 1000);
            const up = this.ws.getPrice(this.tokens.upTokenId); const down = this.ws.getPrice(this.tokens.downTokenId);
            if (!up?.bestAsk || !down?.bestAsk) return;
            const btcPrice = this.btc.getPrice() ?? undefined; this.lastBtcPrice = btcPrice;
            if (btcPrice !== undefined && this.btcOpenPrice === undefined) this.btcOpenPrice = btcPrice;
            this.logMarketSnapshot(now, secondsLeft, up.bestAsk, down.bestAsk, btcPrice);
            await this.fillDryOrders(now, up.bestAsk, down.bestAsk, up.bestBid ?? undefined, down.bestBid ?? undefined);
            if (btcPrice !== undefined && (this.history.length === 0 || now - this.history[this.history.length - 1].t >= 250)) {
                this.history.push({ t: now, upAsk: up.bestAsk, downAsk: down.bestAsk, btcPrice });
                const cutoff = now - this.cfg.intervalMinutes * 60_000; while (this.history.length > 0 && this.history[0].t < cutoff) this.history.shift();
            }
            if (this.cfg.mode === "final-30-managed" && this.active(this.entryOrder)) {
                const session = final30ManagedSession(now, this.cfg.final30ManagedParams);
                const marginBps = final30ManagedDirectionalMarginBps(this.entryOrder!.leg, this.btcOpenPrice, btcPrice);
                const ageSeconds = (now - this.entryOrder!.placedAtMs) / 1000;
                const stale = ageSeconds >= this.cfg.entryMaxAgeSeconds;
                const invalidMargin = marginBps < session.minDirectionalMarginBps;
                const tooLate = secondsLeft <= this.cfg.final30ManagedParams.minSecondsLeftToOpen;
                if (stale || invalidMargin || tooLate) {
                    const executionVersion = this.executionVersion;
                    const reason = tooLate
                        ? `only ${secondsLeft.toFixed(1)}s left; minimum is ${this.cfg.final30ManagedParams.minSecondsLeftToOpen}s`
                        : invalidMargin
                            ? `${session.name} BTC margin ${marginBps.toFixed(2)}bps below ${session.minDirectionalMarginBps.toFixed(2)}bps`
                            : `entry refresh after ${ageSeconds.toFixed(1)}s`;
                    await this.cancelOrder(this.entryOrder, reason);
                    logger.info(`Revalidating final entry: ${reason}`);
                    if (this.executionVersion !== executionVersion) {
                        this.recordDecision(now, secondsLeft, up, down, btcPrice, "entry filled while cancelling; recompute next tick", [], "final");
                        return;
                    }
                }
            }
            const decision = this.cfg.mode === "deep-rebound"
                ? buildBtc5mDeepReboundOrders({
                    timestampMs: now,
                    endMs: this.tokens.endMs,
                    btcPrice,
                    openPrice: this.btcOpenPrice,
                    up,
                    down,
                    positions: {
                        UP: this.position("UP"),
                        DOWN: this.position("DOWN"),
                    },
                    history: this.history,
                    params: this.cfg.deepParams,
                    emitRestingTakeProfit: true,
                })
                : this.cfg.mode === "final-30-high"
                    ? buildBtc5mFinal30HighOrders({ timestampMs: now, endMs: this.tokens.endMs, upAsk: up.bestAsk, downAsk: down.bestAsk, entered: Boolean(this.state.filled || this.state.cancelled || this.active(this.entryOrder)), params: this.cfg.final30HighParams })
                    : this.cfg.mode === "final-30-managed"
                        ? buildBtc5mFinal30ManagedOrders({ timestampMs: now, endMs: this.tokens.endMs, upAsk: up.bestAsk, downAsk: down.bestAsk, upBid: up.bestBid ?? undefined, downBid: down.bestBid ?? undefined, btcPrice, openPrice: this.btcOpenPrice, history: this.history, position: this.managedPosition, blocked: Boolean(this.state.cancelled || (!this.managedPosition && this.active(this.entryOrder))), params: this.cfg.final30ManagedParams })
                    : this.cfg.mode === "undervalued-hold"
                        ? buildBtc5mUndervaluedHoldOrders({ timestampMs: now, endMs: this.tokens.endMs, upAsk: up.bestAsk, downAsk: down.bestAsk, upBid: up.bestBid ?? undefined, downBid: down.bestBid ?? undefined, btcPrice, openPrice: this.btcOpenPrice, position: this.undervaluedPosition, blocked: Boolean(this.state.filled || this.state.cancelled || (!this.undervaluedPosition && this.active(this.entryOrder))), params: this.cfg.undervaluedHoldParams })
                    : this.cfg.mode === "undervalued-final-managed"
                        ? buildBtc5mUndervaluedFinalManagedOrders({ timestampMs: now, endMs: this.tokens.endMs, upAsk: up.bestAsk, downAsk: down.bestAsk, upBid: up.bestBid ?? undefined, downBid: down.bestBid ?? undefined, btcPrice, openPrice: this.btcOpenPrice, history: this.history, undervaluedPosition: this.undervaluedPosition, undervaluedBlocked: Boolean(this.undervaluedPosition || (this.active(this.entryOrder) && this.entryOrder?.role === "entry")), undervaluedParams: this.cfg.undervaluedHoldParams, finalPosition: this.managedPosition, finalBlocked: this.finalBlocked || Boolean(this.active(this.entryOrder) && this.entryOrder?.role === "final-entry"), finalParams: this.cfg.final30ManagedParams })
                    : this.cfg.mode === "dynamic-range-final-managed"
                        ? buildBtc5mDynamicRangeFinalManagedOrders({ timestampMs: now, endMs: this.tokens.endMs, upAsk: up.bestAsk, downAsk: down.bestAsk, upBid: up.bestBid ?? undefined, downBid: down.bestBid ?? undefined, btcPrice, openPrice: this.btcOpenPrice, history: this.history, state: this.dynamicState, params: this.cfg.dynamicRangePullbackParams, finalPosition: this.managedPosition, finalBlocked: this.finalBlocked, finalParams: this.cfg.final30ManagedParams })
                    : buildBtc5mLatencyScalpOrders({ timestampMs: now, endMs: this.tokens.endMs, upAsk: up.bestAsk, downAsk: down.bestAsk, upBid: up.bestBid ?? undefined, downBid: down.bestBid ?? undefined, btcPrice, openPrice: this.btcOpenPrice, state: this.state, params: this.cfg.params });
            const combinedDecision = this.cfg.mode === "dynamic-range-final-managed" ? decision as Btc5mDynamicRangeFinalManagedDecision : undefined;
            const undervaluedFinalDecision = this.cfg.mode === "undervalued-final-managed" ? decision as Btc5mUndervaluedFinalManagedDecision : undefined;
            if (this.cfg.mode === "final-30-managed" && "position" in decision && decision.position) this.managedPosition = decision.position as Btc5mFinal30ManagedPosition;
            if (this.cfg.mode === "undervalued-hold" && "position" in decision && decision.position) this.undervaluedPosition = decision.position as Btc5mUndervaluedHoldPosition;
            if (undervaluedFinalDecision) {
                if (undervaluedFinalDecision.undervaluedPosition) this.undervaluedPosition = undervaluedFinalDecision.undervaluedPosition;
                if (undervaluedFinalDecision.finalPosition) this.managedPosition = undervaluedFinalDecision.finalPosition;
                if (undervaluedFinalDecision.component === "final" && undervaluedFinalDecision.reason?.includes("blocked:")) this.finalBlocked = true;
            }
            if (combinedDecision) {
                this.dynamicState = combinedDecision.dynamicState;
                if (combinedDecision.finalPosition) this.managedPosition = combinedDecision.finalPosition;
                if (combinedDecision.component === "final" && combinedDecision.reason?.includes("blocked:")) this.finalBlocked = true;
            }
            if ("state" in decision) {
                const wasCancelled = Boolean(this.state.cancelled); this.state = decision.state;
                if (!wasCancelled && this.state.cancelled) await this.cancelOrder(this.entryOrder, decision.reason || "strategy cancelled");
            }
            if ((this.cfg.mode === "final-30-high" || this.cfg.mode === "final-30-managed") && decision.reason?.includes("blocked:")) this.state = { ...this.state, cancelled: true };
            const decisionExecutionVersion = this.executionVersion;
            const quote = decision.quotes[0];
            if (this.cfg.mode === "deep-rebound" && quote?.side !== "BUY" && !this.state.filled && this.active(this.entryOrder)) {
                await this.cancelOrder(this.entryOrder, "deep-rebound signal disappeared");
            }
            if (this.cfg.mode === "undervalued-hold" && quote?.side !== "BUY" && !this.state.filled && this.active(this.entryOrder)) {
                await this.cancelOrder(this.entryOrder, "undervalued-hold signal disappeared");
            }
            if ((this.cfg.mode === "final-30-managed" || this.cfg.mode === "undervalued-hold" || this.cfg.mode === "undervalued-final-managed" || this.cfg.mode === "dynamic-range-final-managed") && quote?.side !== "SELL" && this.active(this.exitOrder)) {
                await this.cancelOrder(this.exitOrder, "managed exit signal disappeared");
            }
            if (this.cfg.mode === "dynamic-range-final-managed" && this.active(this.entryOrder)) {
                const expectedRole: Role | undefined = quote?.side === "BUY" ? combinedDecision?.component === "final" ? "final-entry" : this.dynamicState.entryLeg ? "dynamic-hedge" : "dynamic-entry" : undefined;
                const orderAgeSeconds = (now - this.entryOrder!.placedAtMs) / 1000;
                const hedgeChanged = this.entryOrder!.role === "dynamic-hedge" && (!expectedRole || expectedRole !== "dynamic-hedge" || this.entryOrder!.leg !== quote!.leg || Math.abs(this.entryOrder!.price - quote!.price) > 1e-9);
                const entryExpired = (this.entryOrder!.role === "dynamic-entry" || this.entryOrder!.role === "final-entry") && orderAgeSeconds >= this.cfg.entryMaxAgeSeconds;
                if (hedgeChanged || entryExpired) await this.cancelOrder(this.entryOrder, hedgeChanged ? "combined hedge quote changed" : "combined entry expired");
            }
            if (this.cfg.mode === "undervalued-final-managed" && this.active(this.entryOrder)) {
                const expectedRole: Role | undefined = quote?.side === "BUY" ? undervaluedFinalDecision?.component === "final" ? "final-entry" : "entry" : undefined;
                const orderAgeSeconds = (now - this.entryOrder!.placedAtMs) / 1000;
                if (!expectedRole || this.entryOrder!.role !== expectedRole || orderAgeSeconds >= this.cfg.entryMaxAgeSeconds) {
                    await this.cancelOrder(this.entryOrder, !expectedRole || this.entryOrder!.role !== expectedRole ? "combined component changed" : "combined entry expired");
                }
            }
            if (this.executionVersion !== decisionExecutionVersion) {
                this.recordDecision(now, secondsLeft, up, down, btcPrice, "execution changed while reconciling; recompute next tick", [], combinedDecision?.component);
                return;
            }
            const canBuy = this.cfg.mode === "dynamic-range-final-managed" ? !this.managedPosition : this.cfg.mode === "undervalued-final-managed" ? quote?.side === "BUY" && (undervaluedFinalDecision?.component === "final" ? !this.managedPosition : !this.undervaluedPosition) : !this.state.exited;
            if (quote?.side === "BUY" && canBuy && !this.active(this.entryOrder) && !this.pendingReconciliation("BUY") && now >= this.nextOrderAttemptAt) {
                const role: Role = this.cfg.mode === "undervalued-final-managed" ? undervaluedFinalDecision?.component === "final" ? "final-entry" : "entry" : this.cfg.mode !== "dynamic-range-final-managed" ? "entry" : combinedDecision?.component === "final" ? "final-entry" : this.dynamicState.entryLeg ? "dynamic-hedge" : "dynamic-entry";
                if (this.cfg.mode === "final-30-managed" || this.cfg.mode === "undervalued-hold") logger.info(`Entry decision: ${quote.note ?? decision.reason ?? `${quote.leg} @ ${quote.price.toFixed(2)}`}`);
                await this.placeOrder(role, quote.leg, quote.side, quote.price, quote.size, role === "dynamic-entry" ? combinedDecision?.dynamicEntryPlan : undefined);
            }
            if (quote?.side === "SELL") {
                if (this.active(this.entryOrder)) await this.cancelOrder(this.entryOrder, "risk exit takes priority");
                const role: Role = quote.note?.includes("take profit") || quote.note?.includes("take-profit") ? "take-profit" : "risk-exit";
                const executionVersion = this.executionVersion;
                if (this.active(this.exitOrder) && (this.exitOrder!.role !== role || Math.abs(this.exitOrder!.price - quote.price) > 1e-9)) await this.cancelOrder(this.exitOrder, "exit quote changed");
                if (this.executionVersion !== executionVersion) {
                    this.recordDecision(now, secondsLeft, up, down, btcPrice, "exit filled while cancelling; recompute next tick", [], combinedDecision?.component);
                    return;
                }
                const size = Math.min(quote.size, this.availableShares(quote.leg));
                if (!this.active(this.exitOrder) && !this.pendingReconciliation("SELL") && size > 1e-9 && now >= this.nextOrderAttemptAt) await this.placeOrder(role, quote.leg, quote.side, quote.price, size);
            }
            this.recordDecision(now, secondsLeft, up, down, btcPrice, decision.reason, decision.quotes, combinedDecision?.component ?? undervaluedFinalDecision?.component);
        } finally { this.evaluating = false; }
    }

    private active(order: TrackedOrder | null): boolean { return Boolean(order && !isFinal(order.status)); }

    private logMarketSnapshot(now: number, secondsLeft: number, upAsk: number, downAsk: number, btcPrice?: number): void {
        if (this.cfg.marketLogIntervalMs > 0 && now - this.lastMarketLogAt < this.cfg.marketLogIntervalMs) return;
        this.lastMarketLogAt = now;
        if (btcPrice === undefined || this.btcOpenPrice === undefined) {
            logger.info(`📊 Up Ask: ${upAsk.toFixed(4)} | Down Ask: ${downAsk.toFixed(4)} | BTC: -- | Open: -- | Left: ${secondsLeft.toFixed(1)}s`);
            return;
        }
        const offsetUsd = btcPrice - this.btcOpenPrice;
        const offsetBps = this.btcOpenPrice > 0 ? offsetUsd / this.btcOpenPrice * 10_000 : 0;
        const signedUsd = `${offsetUsd >= 0 ? "+" : "-"}$${Math.abs(offsetUsd).toFixed(2)}`;
        const signedBps = `${offsetBps >= 0 ? "+" : ""}${offsetBps.toFixed(2)}bps`;
        logger.info(`📊 Up Ask: ${upAsk.toFixed(4)} | Down Ask: ${downAsk.toFixed(4)} | BTC: $${btcPrice.toFixed(2)} | Open: $${this.btcOpenPrice.toFixed(2)} | Δ: ${signedUsd} (${signedBps}) | Left: ${secondsLeft.toFixed(1)}s`);
    }

    private pendingReconciliation(side: "BUY" | "SELL"): boolean {
        const now = Date.now();
        return [...this.trackedOrders.values()].some((order) => order.side === side && order.cancelledAtMs !== undefined && now - order.cancelledAtMs < this.cfg.orderReconcileGraceMs && order.accountedFilledSize + 1e-9 < order.size);
    }

    private position(leg: Leg): { shares: number; cost: number; tookProfit: boolean } {
        if (!this.accounting) return { shares: 0, cost: 0, tookProfit: false };
        const bought = leg === "UP" ? this.accounting.sharesUp : this.accounting.sharesDown;
        const sold = leg === "UP" ? this.accounting.soldUp : this.accounting.soldDown;
        const shares = Math.max(0, bought - sold);
        const averagePrice = this.accounting.shares > 0 ? this.accounting.cost / this.accounting.shares : 0;
        return { shares, cost: shares * averagePrice, tookProfit: Boolean(this.state.exited) };
    }

    private availableShares(leg: Leg): number {
        if (!this.accounting) return 0;
        return leg === "UP"
            ? Math.max(0, this.accounting.sharesUp - this.accounting.soldUp)
            : Math.max(0, this.accounting.sharesDown - this.accounting.soldDown);
    }

    private async placeOrder(role: Role, leg: Leg, side: "BUY" | "SELL", price: number, size: number, dynamicEntryPlan?: Btc5mDynamicRangePairPlan): Promise<void> {
        if (!this.tokens || !this.accounting) return;
        const tokenId = leg === "UP" ? this.tokens.upTokenId : this.tokens.downTokenId;
        const base = { role, leg, side, tokenId, price, size, filledSize: 0, accountedFilledSize: 0, accountedNotional: 0, status: "NEW", placedAtMs: Date.now(), accounting: this.accounting, executionIds: [], dynamicEntryPlan };
        if (this.cfg.dryRun) {
            const order = { ...base, orderId: `dry-${role}-${Date.now()}` } satisfies TrackedOrder;
            this.trackedOrders.set(order.orderId, order);
            if (side === "BUY") this.entryOrder = order; else this.exitOrder = order;
            this.recordOrder("dry_run_order_posted", order); return;
        }
        try {
            const response = await this.client.createAndPostOrder({ tokenID: tokenId, side: side === "BUY" ? Side.BUY : Side.SELL, price, size } satisfies UserOrder, { tickSize: this.cfg.tickSize, negRisk: this.cfg.negRisk }, OrderType.GTC);
            const orderId = response?.orderID ?? response?.orderId;
            if (!orderId || response?.success === false) throw new Error(String(response?.errorMsg ?? response?.status ?? "CLOB returned no orderID"));
            const order = { ...base, orderId } satisfies TrackedOrder;
            this.trackedOrders.set(order.orderId, order);
            if (side === "BUY") this.entryOrder = order; else this.exitOrder = order;
            this.nextOrderAttemptAt = 0;
            logger.info(`Posted ${role} ${side} ${leg} ${size.toFixed(4)} @ ${price.toFixed(2)}`); this.recordOrder("order_posted", order);
        } catch (error) {
            const errorMessage = formatError(error);
            this.nextOrderAttemptAt = Date.now() + this.cfg.orderRetryIntervalMs;
            logger.error(`Failed to post ${role} ${side} ${leg} ${size.toFixed(4)} @ ${price.toFixed(6)}: ${errorMessage}`);
            this.recordOrder("order_rejected", { ...base, orderId: "", status: "FAILED" }, price, undefined, "clob", [], errorMessage);
            if ((this.cfg.mode === "final-30-high" || this.cfg.mode === "final-30-managed") && role === "entry") this.state = { ...this.state, cancelled: true };
        }
    }

    private async fillDryOrders(now: number, upAsk: number, downAsk: number, upBid?: number, downBid?: number): Promise<void> {
        if (!this.cfg.dryRun) return;
        if (this.active(this.entryOrder) && now > this.entryOrder!.placedAtMs) {
            const ask = this.entryOrder!.leg === "UP" ? upAsk : downAsk;
            if (ask <= this.entryOrder!.price) this.fillOrder(this.entryOrder!, this.entryOrder!.size, "dry_run_entry_fill", ask);
        }
        if (this.active(this.exitOrder) && now > this.exitOrder!.placedAtMs) {
            const bid = this.exitOrder!.leg === "UP" ? upBid : downBid;
            if (bid !== undefined && (this.exitOrder!.role === "risk-exit" || bid >= this.exitOrder!.price)) this.fillOrder(this.exitOrder!, this.exitOrder!.size, "dry_run_exit_fill", this.exitOrder!.role === "risk-exit" ? bid : this.exitOrder!.price);
        }
    }

    private async pollOrders(): Promise<void> {
        if (this.cfg.dryRun || this.stopped || this.evaluating || this.polling) return;
        this.polling = true;
        try {
            const orders = [...this.trackedOrders.values()].filter((order) => this.active(order) || (order.cancelledAtMs !== undefined && Date.now() - order.cancelledAtMs < this.cfg.orderReconcileGraceMs));
            await this.reconcileTradesForOrders(orders);
            for (const order of orders) {
                if (!this.active(order)) continue;
                try {
                    const latest = await this.client.getOrder(order.orderId); if (!latest) continue;
                    this.reconcileOrder(order, latest, "order_fill");
                    if (order.filledSize > 0 && order.filledSize + 1e-9 < order.size && order.role !== "dynamic-hedge") await this.cancelOrder(order, "partial fill; cancel remainder");
                } catch (error) { logger.error(`Failed to poll order: ${formatError(error)}`); }
            }
            this.cleanupTrackedOrders();
        } finally {
            this.polling = false;
        }
    }

    private fillOrder(order: TrackedOrder, shares: number, event: string, executionPrice: number): void {
        order.filledSize += shares; order.accountedFilledSize += shares; order.accountedNotional += shares * executionPrice; order.status = "FILLED"; this.accountFill(order, shares, executionPrice); this.recordOrder(event, order, executionPrice, shares * executionPrice, "simulation");
    }

    private accountFill(order: TrackedOrder, shares: number, executionPrice: number): void {
        const accounting = order.accounting;
        if (order.side === "BUY") {
            accounting.entryLeg = order.leg; accounting.cost += shares * executionPrice; accounting.shares += shares;
            if (order.leg === "UP") accounting.sharesUp += shares;
            else accounting.sharesDown += shares;
            if (!this.cfg.dryRun) addHoldings(accounting.tokens.conditionId, order.tokenId, shares);
            if (accounting !== this.accounting) return;
            this.state = { ...this.state, filled: true, filledAtMs: this.state.filledAtMs ?? Date.now(), fillBtcPrice: this.lastBtcPrice, filledShares: accounting.shares - accounting.soldShares };
            if (this.cfg.mode === "dynamic-range-final-managed" && order.role === "dynamic-entry") {
                const entryShares = (this.dynamicState.entryShares ?? 0) + shares;
                const plannedHedgePrice = order.dynamicEntryPlan?.hedgePrice;
                const fillComplete = order.filledSize + 1e-9 >= order.size;
                const fillPlan = fillComplete
                    ? order.dynamicEntryPlan
                    : order.dynamicEntryPlan?.mode === "synthetic-sell"
                        ? order.dynamicEntryPlan
                    : plannedHedgePrice === undefined
                        ? undefined
                        : buildDynamicRangeHedgePlan(order.price, entryShares, plannedHedgePrice, this.cfg.dynamicRangePullbackParams);
                this.dynamicState = {
                    ...this.dynamicState,
                    entryLeg: order.leg,
                    entryPrice: order.price,
                    entryShares,
                    entryAtMs: this.dynamicState.entryAtMs ?? Date.now(),
                    plannedHedgePrice,
                    plannedHedgeShares: fillPlan?.hedgeShares,
                    plannedExitPrice: fillPlan?.exitPrice,
                    plannedLockedProfit: fillPlan?.lockedProfit,
                    syntheticSell: fillPlan?.mode === "synthetic-sell",
                    unhedgeable: !fillPlan && order.dynamicEntryPlan?.mode !== "synthetic-sell",
                    candidateLeg: undefined,
                    candidateSinceMs: undefined,
                };
            } else if (this.cfg.mode === "dynamic-range-final-managed" && order.role === "dynamic-hedge") {
                const pairedShares = (this.dynamicState.pairedShares ?? 0) + shares;
                this.dynamicState = { ...this.dynamicState, pairedShares, paired: pairedShares + 1e-9 >= (this.dynamicState.plannedHedgeShares ?? this.dynamicState.entryShares ?? pairedShares) };
            }
            if (this.cfg.mode === "final-30-managed" || (this.cfg.mode === "undervalued-final-managed" && order.role === "final-entry") || (this.cfg.mode === "dynamic-range-final-managed" && order.role === "final-entry")) {
                const previous = this.managedPosition && !this.managedPosition.exited && this.managedPosition.leg === order.leg
                    ? this.managedPosition
                    : undefined;
                const positionShares = (previous?.shares ?? 0) + shares;
                const entryPrice = positionShares > 0
                    ? ((previous?.entryPrice ?? 0) * (previous?.shares ?? 0) + executionPrice * shares) / positionShares
                    : executionPrice;
                this.managedPosition = {
                    leg: order.leg,
                    entryPrice,
                    entryBtcPrice: previous?.entryBtcPrice ?? this.lastBtcPrice,
                    shares: positionShares,
                    exited: false,
                };
            }
            if (this.cfg.mode === "undervalued-hold" || (this.cfg.mode === "undervalued-final-managed" && order.role === "entry")) {
                const previous = this.undervaluedPosition && !this.undervaluedPosition.exited && this.undervaluedPosition.leg === order.leg
                    ? this.undervaluedPosition
                    : undefined;
                const positionShares = (previous?.shares ?? 0) + shares;
                const entryPrice = positionShares > 0
                    ? ((previous?.entryPrice ?? 0) * (previous?.shares ?? 0) + executionPrice * shares) / positionShares
                    : executionPrice;
                this.undervaluedPosition = { leg: order.leg, entryPrice, shares: positionShares, exited: false };
            }
        } else {
            accounting.proceeds += shares * executionPrice; accounting.soldShares += shares;
            if (order.leg === "UP") accounting.soldUp += shares;
            else accounting.soldDown += shares;
            if (!this.cfg.dryRun) removeHoldings(accounting.tokens.conditionId, order.tokenId, shares);
            if (accounting !== this.accounting) return;
            if (this.managedPosition && this.managedPosition.leg === order.leg) {
                const remainingShares = Math.max(0, this.managedPosition.shares - shares);
                this.managedPosition = { ...this.managedPosition, exited: remainingShares <= 1e-9, shares: remainingShares };
            }
            if (this.undervaluedPosition && this.undervaluedPosition.leg === order.leg) {
                const remainingShares = Math.max(0, this.undervaluedPosition.shares - shares);
                this.undervaluedPosition = { ...this.undervaluedPosition, exited: remainingShares <= 1e-9, shares: remainingShares };
            }
            const remainingPosition = this.availableShares(order.leg);
            if (remainingPosition <= 1e-9) {
                this.state = { ...this.state, exited: true };
                if (this.cfg.mode === "dynamic-range-final-managed" && !this.managedPosition) this.dynamicState = { ...this.dynamicState, exited: true };
            }
        }
    }

    private async cancelOrder(order: TrackedOrder | null, reason: string): Promise<void> {
        if (!this.active(order)) return;
        if (this.cfg.dryRun) { order!.status = "CANCELLED"; order!.cancelledAtMs = Date.now(); this.recordOrder("dry_run_order_cancelled", order!); return; }
        try {
            await this.client.cancelOrder({ orderID: order!.orderId });
            const latest = await this.client.getOrder(order!.orderId).catch(() => undefined);
            if (latest) this.reconcileOrder(order!, latest, "order_fill_during_cancel");
            if (!isFinal(order!.status)) order!.status = "CANCELLED";
            order!.cancelledAtMs = Date.now();
            this.recordOrder("order_cancelled", order!); logger.info(`Cancelled ${order!.role} (${reason})`);
        } catch (error) { logger.error(`Failed to cancel ${order!.role}: ${formatError(error)}`); }
    }

    private reconcileOrder(order: TrackedOrder, latest: any, fillEvent: string): void {
        order.status = String(latest?.status || order.status);
        order.filledSize = Math.max(order.filledSize, orderFilledSize(latest));
        const newlyFilled = Math.max(0, order.filledSize - order.accountedFilledSize);
        if (newlyFilled <= 0) return;
        order.accountedFilledSize = order.filledSize;
        order.accountedNotional += newlyFilled * order.price;
        this.accountFill(order, newlyFilled, order.price);
        this.executionVersion += 1;
        this.recordOrder(fillEvent, order, order.price, newlyFilled * order.price, "order-status");
    }

    private async reconcileTradesForOrders(orders: TrackedOrder[], onlyFirstPage = true): Promise<void> {
        const byMarket = new Map<string, TrackedOrder[]>();
        for (const order of orders) {
            const market = order.accounting.tokens.conditionId;
            const marketOrders = byMarket.get(market) ?? [];
            marketOrders.push(order);
            byMarket.set(market, marketOrders);
        }
        for (const [market, marketOrders] of byMarket) {
            try {
                const trades = await this.client.getTrades({ market }, onlyFirstPage);
                for (const order of marketOrders) {
                    const summary = summarizeOrderExecutions(executionsForOrder(trades, order.orderId));
                    if (summary.shares <= 0) continue;
                    const newlyFilled = Math.max(0, summary.shares - order.accountedFilledSize);
                    if (newlyFilled > 1e-9) {
                        const newNotional = Math.max(0, summary.notional - order.accountedNotional);
                        const executionPrice = newNotional / newlyFilled;
                        order.accountedFilledSize += newlyFilled;
                        order.accountedNotional += newNotional;
                        order.filledSize = Math.max(order.filledSize, summary.shares);
                        this.accountFill(order, newlyFilled, executionPrice);
                        this.executionVersion += 1;
                        this.recordOrder("order_trade_fill", order, executionPrice, newNotional, "trades-api", summary.executionIds);
                    }
                    if (summary.shares + 1e-9 >= order.accountedFilledSize) {
                        const correction = summary.notional - order.accountedNotional;
                        if (Math.abs(correction) > 1e-9) {
                            if (order.side === "BUY") order.accounting.cost += correction;
                            else order.accounting.proceeds += correction;
                            order.accountedNotional = summary.notional;
                            this.executionVersion += 1;
                            this.recordOrder("order_trade_correction", order, summary.averagePrice ?? order.price, correction, "trades-api", summary.executionIds);
                        }
                    }
                    order.executionIds = summary.executionIds;
                    if (summary.shares + 1e-9 >= order.size) order.status = "FILLED";
                }
            } catch (error) {
                logger.error(`Failed to reconcile trades for ${market}: ${formatError(error)}`);
            }
        }
    }

    private cleanupTrackedOrders(): void {
        const now = Date.now();
        for (const [orderId, order] of this.trackedOrders) {
            const reconciliationExpired = now - (order.cancelledAtMs ?? order.placedAtMs) >= this.cfg.orderReconcileGraceMs;
            if (order.accounting.resolved && !this.active(order) && reconciliationExpired) this.trackedOrders.delete(orderId);
        }
    }

    private async handleResolution(payload: MarketResolvedPayload): Promise<void> {
        const accounting = this.accountingByAsset.get(payload.winningAssetId) ?? payload.assetIds.map((id) => this.accountingByAsset.get(id)).find(Boolean);
        if (!accounting || accounting.resolved || accounting.resolving) return;
        accounting.resolving = true;
        await this.reconcileTradesForOrders([...this.trackedOrders.values()].filter((order) => order.accounting === accounting), false);
        const outcome = payload.winningOutcome.toUpperCase();
        const winner: Leg | undefined = payload.winningAssetId === accounting.tokens.upTokenId || outcome === "UP" ? "UP" : payload.winningAssetId === accounting.tokens.downTokenId || outcome === "DOWN" ? "DOWN" : undefined;
        if (!winner) { accounting.resolving = false; return; }
        accounting.resolved = true; accounting.resolving = false;
        const remainingUp = Math.max(0, accounting.sharesUp - accounting.soldUp);
        const remainingDown = Math.max(0, accounting.sharesDown - accounting.soldDown);
        const settlement = winner === "UP" ? remainingUp : remainingDown; const pnl = accounting.proceeds + settlement - accounting.cost;
        logger.info(`${this.cfg.mode} resolved ${accounting.tokens.slug}: winner=${winner}, pnl=${pnl.toFixed(4)}`);
        this.write({ row_type: "resolution", timestamp: new Date().toISOString(), timestamp_ms: Date.now(), slug: accounting.tokens.slug, condition_id: accounting.tokens.conditionId, dry_run: this.cfg.dryRun, winning_outcome: winner, entry_cost: accounting.cost.toFixed(6), exit_proceeds: accounting.proceeds.toFixed(6), settlement_payout: settlement.toFixed(6), pnl: pnl.toFixed(6) });
        this.accountingByAsset.delete(accounting.tokens.upTokenId); this.accountingByAsset.delete(accounting.tokens.downTokenId);
    }

    private recordDecision(now: number, secondsLeft: number, up: any, down: any, btcPrice: number | undefined, reason: string | undefined, quotes: any[], component?: string): void {
        if (now - this.lastRecordAt < this.cfg.recordIntervalMs) return; this.lastRecordAt = now;
        this.write({ row_type: "decision", timestamp: new Date(now).toISOString(), timestamp_ms: now, slug: this.tokens?.slug, condition_id: this.tokens?.conditionId, dry_run: this.cfg.dryRun, btc_price: optional(btcPrice, 2), open_price: optional(this.btcOpenPrice, 2), seconds_left: secondsLeft.toFixed(3), up_bid: optional(up.bestBid), up_ask: optional(up.bestAsk), down_bid: optional(down.bestBid), down_ask: optional(down.bestAsk), candidate_leg: this.state.candidateLeg, triggered_leg: this.state.triggeredLeg, state_filled: Boolean(this.state.filled), state_cancelled: Boolean(this.state.cancelled), state_exited: Boolean(this.state.exited), decision_reason: reason, quotes: quotes.map((quote) => `${quote.side} ${quote.leg}@${quote.price.toFixed(2)}x${quote.size.toFixed(4)}`).join("|"), strategy_component: component, dynamic_entry_leg: this.dynamicState.entryLeg, dynamic_entry_shares: optional(this.dynamicState.entryShares, 4), dynamic_synthetic_sell: Boolean(this.dynamicState.syntheticSell), dynamic_planned_exit_price: optional(this.dynamicState.plannedExitPrice, 2), dynamic_planned_hedge_price: optional(this.dynamicState.plannedHedgePrice, 2), dynamic_planned_hedge_shares: optional(this.dynamicState.plannedHedgeShares, 4), dynamic_planned_locked_profit: optional(this.dynamicState.plannedLockedProfit, 4), dynamic_paired: Boolean(this.dynamicState.paired), dynamic_exited: Boolean(this.dynamicState.exited), final_blocked: this.finalBlocked });
    }

    private recordOrder(rowType: string, order: TrackedOrder, executionPrice = order.price, eventNotional?: number, executionSource?: string, executionIds = order.executionIds, eventError?: string): void {
        this.write({ row_type: rowType, timestamp: new Date().toISOString(), timestamp_ms: Date.now(), slug: order.accounting.tokens.slug, condition_id: order.accounting.tokens.conditionId, dry_run: this.cfg.dryRun, event_role: order.role, event_leg: order.leg, event_side: order.side, event_price: executionPrice.toFixed(6), event_size: order.size.toFixed(6), event_cost: (executionPrice * order.size).toFixed(6), event_notional: optional(eventNotional), execution_source: executionSource, execution_ids: executionIds.join("|"), order_id: order.orderId, order_status: order.status, filled_size: order.filledSize.toFixed(6), event_error: eventError });
    }

    private write(row: RecordRow): void { if (this.cfg.recordEnabled) appendRecord(this.cfg.recordPath, row); }
}

async function bootstrap(cfg: RunnerConfig): Promise<ClobClient> {
    if (cfg.dryRun) return {} as ClobClient;
    if (!validatePrivateKey()) throw new Error("WALLET_PRIVATE_KEY is invalid or missing");
    await createCredential(); const client = await getClobClient();
    if (process.env.SKIP_ALLOWANCE_APPROVE !== "true") { try { await approveUSDCAllowance(); await updateClobBalanceAllowance(client); } catch (error) { logger.error(`Allowance approval failed: ${error instanceof Error ? error.message : String(error)}`); } }
    const orderUsdc = cfg.mode === "deep-rebound" ? cfg.deepParams.orderUsdc : cfg.mode === "final-30-high" ? cfg.final30HighParams.orderShares * cfg.final30HighParams.maxEntryPrice : cfg.mode === "final-30-managed" ? cfg.final30ManagedParams.orderShares * cfg.final30ManagedParams.maxEntryPrice : cfg.mode === "undervalued-hold" ? cfg.undervaluedHoldParams.orderShares * cfg.undervaluedHoldParams.maxEntryPrice : cfg.mode === "undervalued-final-managed" ? Math.max(cfg.undervaluedHoldParams.orderShares * cfg.undervaluedHoldParams.maxEntryPrice, cfg.final30ManagedParams.orderShares * cfg.final30ManagedParams.maxEntryPrice) : cfg.mode === "dynamic-range-final-managed" ? Math.max(cfg.dynamicRangePullbackParams.maxPairUsdc, cfg.final30ManagedParams.orderShares * cfg.final30ManagedParams.maxEntryPrice) : cfg.params.orderUsdc;
    const gate = await waitForMinimumUsdcBalance(client, Math.max(config.bot.minUsdcBalance, orderUsdc), { pollIntervalMs: 15_000, timeoutMs: 0, logEveryPoll: true });
    if (!gate.ok) throw new Error("USDC balance gate failed"); return client;
}

async function main(): Promise<void> {
    const cfg = loadConfig(); setupConsoleFileLogging({ logFilePath: config.logging.logFilePath, logDir: config.logging.logDir, filePrefix: config.logging.logFilePrefix });
    const bot = new LatencyScalpBot(await bootstrap(cfg), cfg);
    const shutdown = async (signal: string) => { logger.info(`Received ${signal}, shutting down...`); await bot.stop(); process.exit(0); };
    process.once("SIGINT", () => void shutdown("SIGINT")); process.once("SIGTERM", () => void shutdown("SIGTERM")); await bot.start();
}

main().catch((error) => { logger.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
