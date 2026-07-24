import { Btc5mLeg, Btc5mStrategyDecision } from "./types";

export type Btc5mExtreme020ReboundParams = {
    entryThreshold: number;
    takeProfitDelta: number;
    orderUsdc: number;
    minSecondsLeftToOpen: number;
    maxSecondsLeftToOpen: number;
    stopLossPct: number;
    maxHoldSeconds: number;
    forceExitSecondsLeft: number;
};

export type Btc5mExtreme020Position = {
    shares: number;
    cost: number;
    entered: boolean;
    exited: boolean;
    enteredAtMs?: number;
};

export type Btc5mExtreme020ReboundInput = {
    timestampMs: number;
    endMs: number;
    upAsk?: number;
    downAsk?: number;
    upBid?: number;
    downBid?: number;
    positions: Record<Btc5mLeg, Btc5mExtreme020Position>;
    params: Btc5mExtreme020ReboundParams;
};

export function buildBtc5mExtreme020ReboundOrders(input: Btc5mExtreme020ReboundInput): Btc5mStrategyDecision {
    const quotes: Btc5mStrategyDecision["quotes"] = [];
    const secondsLeft = Math.max(0, (input.endMs - input.timestampMs) / 1000);

    for (const leg of ["UP", "DOWN"] as const) {
        const position = input.positions[leg];
        if (position.shares > 0) {
            const averagePrice = position.cost / position.shares;
            const bid = leg === "UP" ? input.upBid : input.downBid;
            const holdSeconds = position.enteredAtMs === undefined ? 0 : (input.timestampMs - position.enteredAtMs) / 1000;
            const stopLoss = input.params.stopLossPct > 0 && bid !== undefined && bid <= averagePrice * (1 - input.params.stopLossPct);
            const timeout = input.params.maxHoldSeconds > 0 && holdSeconds >= input.params.maxHoldSeconds;
            const forceExit = input.params.forceExitSecondsLeft > 0 && secondsLeft <= input.params.forceExitSecondsLeft;
            if ((stopLoss || timeout || forceExit) && bid !== undefined && bid > 0) {
                quotes.push({
                    key: `${leg}:SELL`, leg, side: "SELL", price: bid, size: position.shares,
                    note: stopLoss ? "extreme-020-rebound stop-loss" : timeout ? "extreme-020-rebound time-stop" : "extreme-020-rebound force-exit",
                });
                continue;
            }
            if (input.params.takeProfitDelta > 0) {
                quotes.push({
                    key: `${leg}:SELL`, leg, side: "SELL",
                    price: Math.min(0.99, averagePrice + input.params.takeProfitDelta),
                    size: position.shares,
                    note: "extreme-020-rebound take-profit",
                });
            }
            continue;
        }
        if (position.entered || position.exited) continue;
        if (secondsLeft < input.params.minSecondsLeftToOpen || secondsLeft > input.params.maxSecondsLeftToOpen) continue;
        const ask = leg === "UP" ? input.upAsk : input.downAsk;
        if (ask === undefined || ask <= 0 || ask > input.params.entryThreshold) continue;
        quotes.push({
            key: `${leg}:BUY`, leg, side: "BUY",
            price: input.params.entryThreshold,
            size: input.params.orderUsdc / input.params.entryThreshold,
            note: `extreme-020-rebound entry ask=${ask.toFixed(2)}`,
        });
    }

    return { quotes, reason: quotes.length ? "extreme-020-rebound active" : "extreme-020-rebound waiting" };
}
