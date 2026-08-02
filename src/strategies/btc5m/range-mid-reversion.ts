import { Btc5mLeg, Btc5mStrategyDecision, clamp } from "./types";

export type Btc5mRangeMidSample = {
    timestampMs: number;
    upMid: number;
};

export type Btc5mRangeMidPosition = {
    leg?: Btc5mLeg;
    shares: number;
    cost: number;
    enteredAtMs?: number;
};

export type Btc5mRangeMidParams = {
    observeSeconds: number;
    profitDelta: number;
    maxHoldSeconds: number;
    forceExitSecondsLeft: number;
    minSecondsLeftToOpen: number;
    minMidCrosses: number;
    shares: number;
    tick: number;
};

export type Btc5mRangeMidInput = {
    timestampMs: number;
    startMs: number;
    endMs: number;
    upAsk?: number;
    downAsk?: number;
    upBid?: number;
    downBid?: number;
    history: Btc5mRangeMidSample[];
    attempted: boolean;
    position: Btc5mRangeMidPosition;
    params: Btc5mRangeMidParams;
};

export function buildBtc5mRangeMidReversionOrders(input: Btc5mRangeMidInput): Btc5mStrategyDecision {
    const elapsedSeconds = (input.timestampMs - input.startMs) / 1000;
    const secondsLeft = Math.max(0, (input.endMs - input.timestampMs) / 1000);
    if (elapsedSeconds < input.params.observeSeconds) return { quotes: [], reason: "range-mid observing" };

    const observationEndMs = input.startMs + input.params.observeSeconds * 1000;
    const samples = input.history.filter((sample) => sample.timestampMs >= input.startMs && sample.timestampMs <= observationEndMs && sample.upMid > 0 && sample.upMid < 1);
    if (samples.length < 3) return { quotes: [], reason: "range-mid insufficient observations" };
    const prices = samples.map((sample) => sample.upMid);
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const midpoint = (low + high) / 2;
    const midpointCrosses = countCrosses(prices, midpoint);
    if (midpointCrosses < input.params.minMidCrosses) {
        return { quotes: [], fairUp: midpoint, fairDown: 1 - midpoint, reason: `range-mid crosses ${midpointCrosses}/${input.params.minMidCrosses}` };
    }

    if (input.position.leg && input.position.shares > 0) {
        const leg = input.position.leg;
        const target = leg === "UP" ? midpoint : 1 - midpoint;
        const bid = leg === "UP" ? input.upBid : input.downBid;
        const heldSeconds = input.position.enteredAtMs === undefined ? 0 : (input.timestampMs - input.position.enteredAtMs) / 1000;
        const forceExit = secondsLeft <= input.params.forceExitSecondsLeft;
        const timeStop = heldSeconds >= input.params.maxHoldSeconds;
        if ((forceExit || timeStop) && bid !== undefined && bid > 0) {
            return {
                quotes: [{ key: `${leg}:SELL`, leg, side: "SELL", price: roundToTick(bid, input.params.tick, "floor"), size: input.position.shares, note: forceExit ? "range-mid force-exit" : "range-mid time-stop" }],
                fairUp: midpoint,
                fairDown: 1 - midpoint,
                reason: forceExit ? "range-mid force-exit" : "range-mid time-stop",
            };
        }
        return {
            quotes: [{ key: `${leg}:SELL`, leg, side: "SELL", price: roundToTick(target, input.params.tick, "ceil"), size: input.position.shares, note: "range-mid take-profit" }],
            fairUp: midpoint,
            fairDown: 1 - midpoint,
            reason: "range-mid take-profit",
        };
    }

    if (input.attempted || secondsLeft < input.params.minSecondsLeftToOpen) {
        return { quotes: [], fairUp: midpoint, fairDown: 1 - midpoint, reason: input.attempted ? "range-mid already attempted" : "range-mid entry window closed" };
    }

    const candidates = [
        buildEntryCandidate("UP", midpoint - input.params.profitDelta, input.upAsk, input.params),
        buildEntryCandidate("DOWN", 1 - midpoint - input.params.profitDelta, input.downAsk, input.params),
    ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
    candidates.sort((left, right) => left.distance - right.distance);
    const selected = candidates[0];
    if (!selected) return { quotes: [], fairUp: midpoint, fairDown: 1 - midpoint, reason: "range-mid invalid entry prices" };
    return {
        quotes: [{ key: `${selected.leg}:BUY`, leg: selected.leg, side: "BUY", price: selected.price, size: input.params.shares, note: `range-mid entry low=${low.toFixed(4)} high=${high.toFixed(4)} mid=${midpoint.toFixed(4)} crosses=${midpointCrosses}` }],
        fairUp: midpoint,
        fairDown: 1 - midpoint,
        reason: `range-mid quote ${selected.leg}`,
    };
}

function buildEntryCandidate(leg: Btc5mLeg, rawPrice: number, ask: number | undefined, params: Btc5mRangeMidParams): { leg: Btc5mLeg; price: number; distance: number } | undefined {
    if (ask === undefined || ask <= 0 || ask >= 1) return undefined;
    const price = roundToTick(clamp(rawPrice, params.tick, 1 - params.tick), params.tick, "floor");
    return { leg, price, distance: Math.abs(ask - price) };
}

function countCrosses(prices: number[], midpoint: number): number {
    let previousSide = 0;
    let crosses = 0;
    for (const price of prices) {
        const side = price > midpoint ? 1 : price < midpoint ? -1 : previousSide;
        if (previousSide !== 0 && side !== 0 && side !== previousSide) crosses++;
        if (side !== 0) previousSide = side;
    }
    return crosses;
}

function roundToTick(value: number, tick: number, mode: "floor" | "ceil"): number {
    const units = mode === "floor" ? Math.floor((value + 1e-9) / tick) : Math.ceil((value - 1e-9) / tick);
    const decimals = (tick.toString().split(".")[1] ?? "").length;
    return Number((units * tick).toFixed(decimals));
}
