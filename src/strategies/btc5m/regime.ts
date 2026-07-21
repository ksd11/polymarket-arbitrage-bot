export type Btc5mRegime = "oscillating" | "trending" | "panic-discount" | "unknown";

export type Btc5mRegimeSnapshot = {
    t: number;
    upAsk: number;
    downAsk?: number;
    btcPrice?: number;
};

export type Btc5mRegimeMetrics = {
    regime: Btc5mRegime;
    btcMoveBps: number;
    crossCount: number;
    priceRange: number;
    choppiness: number;
    netMove: number;
    pathLength: number;
    btcMomentumBps: number;
    upAskMomentum: number;
    downAskMomentum: number;
};

export type Btc5mRegimeParams = {
    lookbackSeconds: number;
    minHistoryPoints: number;
    oscillationCrossCount: number;
    oscillationChoppiness: number;
    oscillationMaxBtcMoveBps: number;
    trendMinBtcMoveBps: number;
    trendMaxChoppiness: number;
};

export function calculateRegimeMetrics(history: Btc5mRegimeSnapshot[], nowMs: number, openPrice: number | undefined, currentBtcPrice: number | undefined, params: Btc5mRegimeParams): Btc5mRegimeMetrics {
    const cutoff = nowMs - params.lookbackSeconds * 1000;
    const recent = history.filter((point) => point.t >= cutoff && Number.isFinite(point.upAsk));
    const btcMoveBps = openPrice && currentBtcPrice ? Math.abs((currentBtcPrice - openPrice) / openPrice) * 10_000 : 0;

    if (recent.length < params.minHistoryPoints) {
        return { regime: "unknown", btcMoveBps, crossCount: 0, priceRange: 0, choppiness: 0, netMove: 0, pathLength: 0, btcMomentumBps: 0, upAskMomentum: 0, downAskMomentum: 0 };
    }

    let crossCount = 0;
    let pathLength = 0;
    for (let idx = 1; idx < recent.length; idx++) {
        const prev = recent[idx - 1].upAsk;
        const curr = recent[idx].upAsk;
        if ((prev < 0.5 && curr >= 0.5) || (prev >= 0.5 && curr < 0.5)) crossCount++;
        pathLength += Math.abs(curr - prev);
    }

    const values = recent.map((point) => point.upAsk);
    const priceRange = Math.max(...values) - Math.min(...values);
    const netMove = Math.abs(recent[recent.length - 1].upAsk - recent[0].upAsk);
    const choppiness = pathLength / Math.max(netMove, 0.01);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const btcMomentumBps = first.btcPrice && last.btcPrice ? ((last.btcPrice - first.btcPrice) / first.btcPrice) * 10_000 : 0;
    const upAskMomentum = last.upAsk - first.upAsk;
    const downAskMomentum = last.downAsk !== undefined && first.downAsk !== undefined ? last.downAsk - first.downAsk : 0;

    if (btcMoveBps >= params.trendMinBtcMoveBps && choppiness <= params.trendMaxChoppiness) {
        return { regime: "trending", btcMoveBps, crossCount, priceRange, choppiness, netMove, pathLength, btcMomentumBps, upAskMomentum, downAskMomentum };
    }

    if (btcMoveBps <= params.oscillationMaxBtcMoveBps && (crossCount >= params.oscillationCrossCount || choppiness >= params.oscillationChoppiness)) {
        return { regime: "oscillating", btcMoveBps, crossCount, priceRange, choppiness, netMove, pathLength, btcMomentumBps, upAskMomentum, downAskMomentum };
    }

    return { regime: "unknown", btcMoveBps, crossCount, priceRange, choppiness, netMove, pathLength, btcMomentumBps, upAskMomentum, downAskMomentum };
}
