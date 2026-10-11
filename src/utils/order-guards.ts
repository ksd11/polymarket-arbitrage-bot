/**
 * Pure pre-flight guards shared by the live runners.
 *
 * Every helper here exists because a rejected order used to be indistinguishable from a
 * network blip: the CLOB client is constructed without `throwOnError`, so a 400 arrives as a
 * raw response body whose real reason (`error`) was previously thrown away, leaving a bare
 * "400" in the logs. These helpers keep the reason, classify it, and normalise the order
 * parameters so the exchange never has to reject it in the first place.
 */

import { OrderType } from "@polymarket/clob-client-v2";

export type OrderErrorKind = "insufficient_balance" | "invalid_price" | "invalid_size" | "market_closed" | "rate_limited" | "network" | "taker_no_match" | "unknown";

export type ClassifiedOrderError = { kind: OrderErrorKind; retryable: boolean; text: string };

/**
 * Flatten an unknown thrown value (Error / ApiError / axios error / raw CLOB response) into
 * the message plus the most specific body we can find.
 */
export function extractErrorDetail(error: unknown): { message: string; detail: string } {
    const value = error as any;
    const message = error instanceof Error ? error.message : String(error);
    const candidates = [value?.data, value?.response?.data, value?.errorMsg, value?.error, value?.body, value?.response?.statusText];
    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null || candidate === "") continue;
        try {
            const text = typeof candidate === "string" ? candidate : JSON.stringify(candidate);
            if (text && text !== message) return { message, detail: text };
        } catch { /* ignore unserialisable values */ }
    }
    return { message, detail: "" };
}

export function formatOrderError(error: unknown): string {
    const { message, detail } = extractErrorDetail(error);
    return detail ? `${message} ${detail}` : message;
}

/**
 * Extract the failure reason hidden inside a *successful-looking* CLOB response.
 *
 * The v2 client is constructed without `throwOnError`, so a rejected post arrives as a plain
 * body. Verified live (2026-10-09 probe): a FAK order that cannot match is killed on arrival
 * and the body is
 *   {"error":"no orders found to match with FAK order...","orderID":"0x...","status":400}
 * The orderID is present even for killed orders, so an orderID alone is NOT proof of
 * acceptance -- checking only the ID once made the runner track a phantom order for 12s and
 * block re-posting. Returns the failure text, or null when the order was accepted.
 */
export function orderResponseError(response: unknown): string | null {
    if (response === null || response === undefined) return "CLOB returned an empty response";
    const body = response as Record<string, unknown>;
    const orderId = body.orderID ?? body.orderId;
    const reason = body.error ?? body.errorMsg ?? body.errorMessage;
    const status = typeof body.status === "number" ? body.status : undefined;
    if (reason !== undefined && reason !== null && String(reason).length > 0) return String(reason);
    if (body.success === false) return status !== undefined ? `CLOB returned status ${status}` : "CLOB reported success=false";
    if (status !== undefined && status >= 400) return `CLOB returned status ${status}`;
    if (!orderId) return "CLOB returned no orderID";
    return null;
}

/**
 * Map a CLOB rejection onto a retry policy. Transient classes (settlement lag, throttling,
 * blips) deserve another attempt; permanent ones (off-grid price, size below the exchange
 * minimum, closed market) must never be hammered.
 */
export function classifyOrderError(error: unknown): ClassifiedOrderError {
    const text = formatOrderError(error).toLowerCase();
    const has = (...needles: string[]) => needles.some((needle) => text.includes(needle));
    if (has("not enough balance", "insufficient balance", "balance is not enough", "not enough allowance", "insufficient allowance", "not enough funds", "not enough token")) {
        return { kind: "insufficient_balance", retryable: true, text };
    }
    if (has("429", "rate limit", "too many requests", "throttl")) return { kind: "rate_limited", retryable: true, text };
    if (has("no orders found to match", "does not match", "no match")) return { kind: "taker_no_match", retryable: true, text };
    if (has("econnreset", "etimedout", "socket hang up", "fetch failed", "network error", "timeout", "eai_again")) return { kind: "network", retryable: true, text };
    if (has("invalid price", "tick size", "price is not", "invalid tick", "price outside")) return { kind: "invalid_price", retryable: false, text };
    if (has("min size", "minimum size", "invalid size", "size is too", "below minimum", "min order", "minimum order", "size too small")) return { kind: "invalid_size", retryable: false, text };
    if (has("market is not", "market closed", "not active", "trading is not", "market not found", "archived")) return { kind: "market_closed", retryable: false, text };
    return { kind: "unknown", retryable: true, text };
}

/**
 * Snap a price onto the market tick grid.
 * Returns null when the value cannot be traded (non-positive, or outside `[tick, 1 - tick]`).
 */
export function normalizeOrderPrice(price: number, tickSize: number | string): number | null {
    const tick = Number(tickSize);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tick) || tick <= 0) return null;
    const snapped = Number((Math.round(price / tick) * tick).toFixed(6));
    if (snapped < tick || snapped > 1 - tick) return null;
    return snapped;
}

/**
 * Floor a share size onto the exchange step. Rounding down is always safe: it can only shrink
 * the order, and it guarantees the size is a valid multiple of the step.
 */
export function normalizeOrderSize(size: number, step: number): number {
    if (!Number.isFinite(size) || size <= 0) return 0;
    if (!Number.isFinite(step) || step <= 0) return size;
    return Number((Math.floor(size / step + 1e-9) * step).toFixed(8));
}

/**
 * Raise a taker BUY limit so it still crosses after the final-seconds price drift.
 *
 * The live failure this fixes: the strategy fires when the favoured ask is inside the band
 * (e.g. 0.96), but signing + posting the order takes ~1.7s and by then the ask has ticked up
 * (0.97), so a limit pinned to the snapshot ask just rests unfilled. Bidding `buffer` above
 * the snapshot ask (clamped to `cap`) keeps the order marketable while never paying above the
 * top of the researched band. Returns the original price when no buffer is set or the shifted
 * value is not tradable.
 */
export function bufferedTakerBuyPrice(price: number, buffer: number, cap: number, tickSize: number | string): number {
    if (!Number.isFinite(buffer) || buffer <= 0) return price;
    const ceiling = Number.isFinite(cap) && cap > 0 ? cap : 1;
    const shifted = Math.min(ceiling, price + buffer);
    return normalizeOrderPrice(shifted, tickSize) ?? price;
}

/**
 * CLOB's hard floor on order size, in shares.
 *
 * Every market exposes its own `min_order_size` on `GET /book`; for Polymarket BTC 5-minute
 * Up/Down markets this is `5` (verified live: `GET /book?token_id=...` -> `min_order_size: "5"`).
 * The CLOB rejects anything below it with "Size lower than the minimum: 5", which is a
 * *permanent* rejection -- retrying can never succeed, so it must be caught before signing.
 *
 * Note this is a share floor, independent of the $1 notional floor. At BTC-5m entry prices
 * (~0.85) the share floor binds first, and it cannot be worked around by shrinking the order.
 */
export const CLOB_MIN_ORDER_SHARES = 5;

/** True when `size` is below the exchange's minimum tradable size (in shares). */
export function belowMinOrderShares(size: number, minShares: number = CLOB_MIN_ORDER_SHARES): boolean {
    if (!Number.isFinite(minShares) || minShares <= 0) return false;
    return !Number.isFinite(size) || size + 1e-9 < minShares;
}

const ORDER_TYPES: Record<string, OrderType> = { GTC: OrderType.GTC, FOK: OrderType.FOK, GTD: OrderType.GTD, FAK: OrderType.FAK };

/** Parse an `*_ORDER_TYPE` env value; unknown values fall back to GTC (resting maker order). */
export function parseOrderType(value: string | undefined): OrderType {
    return ORDER_TYPES[(value ?? "GTC").toUpperCase()] ?? OrderType.GTC;
}

export function isTakerOrderType(orderType: OrderType): boolean {
    return orderType === OrderType.FAK || orderType === OrderType.FOK;
}
