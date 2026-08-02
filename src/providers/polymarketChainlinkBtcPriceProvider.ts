import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { BtcPriceSnapshot, BtcPriceSource } from "./btcPriceProvider";
import { logger } from "../utils/logger";

export type PolymarketChainlinkBtcPriceConfig = {
    url: string;
    symbol: string;
    maxStalenessMs: number;
    connectTimeoutMs: number;
    reconnectDelayMs: number;
    pingIntervalMs: number;
    historyRetentionMs: number;
};

export function defaultPolymarketChainlinkBtcPriceConfig(): PolymarketChainlinkBtcPriceConfig {
    return {
        url: "wss://ws-live-data.polymarket.com",
        symbol: "btc/usd",
        maxStalenessMs: 10_000,
        connectTimeoutMs: 15_000,
        reconnectDelayMs: 1_000,
        pingIntervalMs: 5_000,
        historyRetentionMs: 10 * 60_000,
    };
}

export class PolymarketChainlinkBtcPriceProvider implements BtcPriceSource {
    private ws: WebSocket | null = null;
    private latest: BtcPriceSnapshot | null = null;
    private history: BtcPriceSnapshot[] = [];
    private pingTimer: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private stopped = false;
    private firstPriceResolve?: () => void;
    private firstPriceReject?: (error: Error) => void;

    constructor(private cfg: PolymarketChainlinkBtcPriceConfig = defaultPolymarketChainlinkBtcPriceConfig()) {}

    async start(): Promise<void> {
        this.stopped = false;
        const firstPrice = new Promise<void>((resolve, reject) => {
            this.firstPriceResolve = resolve;
            this.firstPriceReject = reject;
        });
        this.connect();
        const timeout = setTimeout(() => this.firstPriceReject?.(new Error(`Polymarket Chainlink BTC price timed out after ${this.cfg.connectTimeoutMs}ms`)), this.cfg.connectTimeoutMs);
        try {
            await firstPrice;
        } finally {
            clearTimeout(timeout);
            this.firstPriceResolve = undefined;
            this.firstPriceReject = undefined;
        }
        logger.info(`Polymarket Chainlink BTC provider started: ${this.cfg.url}, symbol=${this.cfg.symbol}`);
    }

    stop(): void {
        this.stopped = true;
        this.clearTimers();
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
        }
        logger.info("Polymarket Chainlink BTC provider stopped");
    }

    getPrice(): number | null {
        if (!this.latest) return null;
        if (Date.now() - this.latest.updatedAt > this.cfg.maxStalenessMs) {
            logger.warning(`Polymarket Chainlink BTC price stale: ${((Date.now() - this.latest.updatedAt) / 1000).toFixed(1)}s old`);
            return null;
        }
        return this.latest.price;
    }

    getSnapshot(): BtcPriceSnapshot | null {
        return this.latest;
    }

    getPriceNear(timestampMs: number, toleranceMs: number): BtcPriceSnapshot | null {
        let selected: BtcPriceSnapshot | null = null;
        let selectedDistance = Number.POSITIVE_INFINITY;
        for (const snapshot of this.history) {
            const distance = Math.abs(snapshot.updatedAt - timestampMs);
            if (distance <= toleranceMs && distance < selectedDistance) {
                selected = snapshot;
                selectedDistance = distance;
            }
        }
        return selected;
    }

    private connect(): void {
        if (this.stopped || this.ws?.readyState === WebSocket.CONNECTING || this.ws?.readyState === WebSocket.OPEN) return;
        const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
        const options: WebSocket.ClientOptions = {};
        if (proxyUrl) options.agent = new HttpsProxyAgent(proxyUrl) as any;
        logger.info(`Connecting to Polymarket Chainlink RTDS: ${this.cfg.url}${proxyUrl ? " via proxy" : ""}`);
        this.ws = new WebSocket(this.cfg.url, options);
        this.ws.on("open", () => this.handleOpen());
        this.ws.on("message", (data) => this.handleMessage(data));
        this.ws.on("error", (error) => logger.error(`Polymarket Chainlink RTDS error: ${error.message}`));
        this.ws.on("close", (code, reason) => this.handleClose(code, reason.toString()));
    }

    private handleOpen(): void {
        this.ws?.send(JSON.stringify({
            action: "subscribe",
            subscriptions: [{ topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol: this.cfg.symbol }) }],
        }));
        this.pingTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("PING");
        }, this.cfg.pingIntervalMs);
        logger.info(`Subscribed to Polymarket Chainlink RTDS ${this.cfg.symbol}`);
    }

    private handleMessage(data: WebSocket.RawData): void {
        const snapshots = parsePolymarketChainlinkBtcMessage(data.toString(), this.cfg.symbol);
        for (const snapshot of snapshots) this.acceptSnapshot(snapshot);
    }

    private acceptSnapshot(snapshot: BtcPriceSnapshot): void {
        if (!this.latest || snapshot.updatedAt >= this.latest.updatedAt) this.latest = snapshot;
        this.history.push(snapshot);
        const cutoff = Date.now() - this.cfg.historyRetentionMs;
        this.history = this.history
            .filter((item) => item.updatedAt >= cutoff)
            .sort((left, right) => left.updatedAt - right.updatedAt);
        this.firstPriceResolve?.();
    }

    private handleClose(code: number, reason: string): void {
        this.ws = null;
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
        if (this.stopped) return;
        logger.warning(`Polymarket Chainlink RTDS disconnected: code=${code}, reason=${reason || "none"}; reconnecting in ${this.cfg.reconnectDelayMs}ms`);
        this.reconnectTimer = setTimeout(() => this.connect(), this.cfg.reconnectDelayMs);
    }

    private clearTimers(): void {
        if (this.pingTimer) clearInterval(this.pingTimer);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.pingTimer = null;
        this.reconnectTimer = null;
    }
}

export function parsePolymarketChainlinkBtcMessage(raw: string | object, symbol = "btc/usd"): BtcPriceSnapshot[] {
    let message: any;
    try {
        message = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
        return [];
    }
    const messages = Array.isArray(message) ? message : [message];
    const snapshots: BtcPriceSnapshot[] = [];
    for (const item of messages) {
        if (item?.topic && item.topic !== "crypto_prices_chainlink") continue;
        const payloads = Array.isArray(item?.payload) ? item.payload : [item?.payload];
        for (const payload of payloads) {
            const value = Number(payload?.value);
            const payloadSymbol = String(payload?.symbol ?? "").toLowerCase();
            if (payloadSymbol !== symbol.toLowerCase() || !Number.isFinite(value) || value <= 0) continue;
            const rawTimestamp = Number(payload?.timestamp ?? item?.timestamp ?? Date.now());
            const updatedAt = rawTimestamp > 0 && rawTimestamp < 1_000_000_000_000 ? rawTimestamp * 1000 : rawTimestamp;
            if (!Number.isFinite(updatedAt) || updatedAt <= 0) continue;
            snapshots.push({ price: value, updatedAt, source: `polymarket-chainlink:${payloadSymbol}` });
        }
    }
    return snapshots.sort((left, right) => left.updatedAt - right.updatedAt);
}
