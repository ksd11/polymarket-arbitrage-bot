import { fairUpProbability } from "./edge";
import { Btc5mRegimeSnapshot } from "./regime";
import { Btc5mLeg, Btc5mStrategyDecision } from "./types";

export type Btc5mReverseTouchEdgeParams = {
    intervalMinutes: number;
    volPerInterval: number;
    triggerPrice: number;
    triggerResetPrice: number;
    minEntryPrice: number;
    maxEntryPrice: number;
    minSecondsLeftToOpen: number;
    maxSecondsLeftToOpen: number;
    confirmSeconds: number;
    minDirectionalBtcMarginBps: number;
    minEdge: number;
    maxSpread: number;
    orderShares: number;
};

export type Btc5mReverseTouchEdgeState = {
    triggerLeg?: Btc5mLeg;
    candidateLeg?: Btc5mLeg;
    candidateSinceMs?: number;
    entered?: boolean;
};

export type Btc5mReverseTouchEdgeInput = {
    timestampMs: number;
    endMs: number;
    upAsk?: number;
    downAsk?: number;
    upBid?: number;
    downBid?: number;
    btcPrice?: number;
    openPrice?: number;
    history?: Btc5mRegimeSnapshot[];
    state: Btc5mReverseTouchEdgeState;
    blocked: boolean;
    params: Btc5mReverseTouchEdgeParams;
};

export type Btc5mReverseTouchEdgeDecision = Btc5mStrategyDecision & {
    reverseState: Btc5mReverseTouchEdgeState;
};

export function buildBtc5mReverseTouchEdgeOrders(input: Btc5mReverseTouchEdgeInput): Btc5mReverseTouchEdgeDecision {
    if (input.blocked || input.state.entered) return { quotes: [], reverseState: input.state, reason: "reverse-touch-edge already entered" };
    const secondsLeft = Math.max(0, (input.endMs - input.timestampMs) / 1000);
    if (secondsLeft < input.params.minSecondsLeftToOpen || secondsLeft > input.params.maxSecondsLeftToOpen) {
        return { quotes: [], reverseState: clearCandidate(input.state), reason: `reverse-touch-edge outside window (${secondsLeft.toFixed(1)}s)` };
    }
    if (!input.btcPrice || !input.openPrice || input.upAsk === undefined || input.downAsk === undefined) {
        return { quotes: [], reverseState: input.state, reason: "reverse-touch-edge waiting for prices" };
    }

    const triggerLeg = touchedLeg(input.upAsk, input.downAsk, input.params.triggerPrice);
    if (!triggerLeg) {
        const triggerAsk = input.state.triggerLeg === "UP" ? input.upAsk : input.state.triggerLeg === "DOWN" ? input.downAsk : undefined;
        const reverseState = triggerAsk !== undefined && triggerAsk <= input.params.triggerResetPrice ? input.state : clearCandidate(input.state);
        return { quotes: [], reverseState, reason: "reverse-touch-edge waiting for 0.40 touch" };
    }
    const candidateLeg: Btc5mLeg = triggerLeg === "UP" ? "DOWN" : "UP";
    const candidateSinceMs = input.state.candidateLeg === candidateLeg ? input.state.candidateSinceMs ?? input.timestampMs : input.timestampMs;
    const reverseState = { ...input.state, triggerLeg, candidateLeg, candidateSinceMs };
    const confirmedSeconds = (input.timestampMs - candidateSinceMs) / 1000;
    if (confirmedSeconds < input.params.confirmSeconds || !historyConfirms(input, candidateLeg, candidateSinceMs)) {
        return { quotes: [], reverseState, reason: `reverse-touch-edge confirming ${candidateLeg} ${confirmedSeconds.toFixed(1)}s` };
    }

    const ask = candidateLeg === "UP" ? input.upAsk : input.downAsk;
    const bid = candidateLeg === "UP" ? input.upBid : input.downBid;
    if (ask < input.params.minEntryPrice || ask > input.params.maxEntryPrice) {
        return { quotes: [], reverseState, reason: `reverse-touch-edge ${candidateLeg} ask ${ask.toFixed(2)} outside entry range` };
    }
    const spread = bid === undefined ? Number.POSITIVE_INFINITY : ask - bid;
    if (spread > input.params.maxSpread) return { quotes: [], reverseState, reason: `reverse-touch-edge spread ${spread.toFixed(3)} too wide` };

    const moveBps = (input.btcPrice / input.openPrice - 1) * 10_000;
    const directionalMarginBps = candidateLeg === "UP" ? moveBps : -moveBps;
    if (directionalMarginBps < input.params.minDirectionalBtcMarginBps) {
        return { quotes: [], reverseState, reason: `reverse-touch-edge BTC margin ${directionalMarginBps.toFixed(2)}bps below ${input.params.minDirectionalBtcMarginBps.toFixed(2)}bps` };
    }
    const fairUp = fairUpProbability(input.btcPrice, input.openPrice, input.endMs - input.timestampMs, input.params);
    const fair = candidateLeg === "UP" ? fairUp : 1 - fairUp;
    const edge = fair - ask;
    if (edge < input.params.minEdge) {
        return { quotes: [], fairUp, fairDown: 1 - fairUp, reverseState, reason: `reverse-touch-edge edge ${edge.toFixed(3)} below ${input.params.minEdge.toFixed(3)}` };
    }
    return {
        quotes: [{ key: `${candidateLeg}:BUY`, leg: candidateLeg, side: "BUY", price: ask, size: input.params.orderShares, fair, edge, note: `reverse-touch-edge ${triggerLeg}@${(triggerLeg === "UP" ? input.upAsk : input.downAsk).toFixed(2)} -> ${candidateLeg}@${ask.toFixed(2)} fair=${fair.toFixed(3)} edge=${edge.toFixed(3)} btcMargin=${directionalMarginBps.toFixed(2)}bps` }],
        fairUp,
        fairDown: 1 - fairUp,
        reverseState,
        reason: `reverse-touch-edge confirmed ${candidateLeg}`,
    };
}

function touchedLeg(upAsk: number, downAsk: number, triggerPrice: number): Btc5mLeg | undefined {
    if (upAsk <= triggerPrice && downAsk > triggerPrice) return "UP";
    if (downAsk <= triggerPrice && upAsk > triggerPrice) return "DOWN";
    return undefined;
}

function historyConfirms(input: Btc5mReverseTouchEdgeInput, leg: Btc5mLeg, sinceMs: number): boolean {
    if (input.params.confirmSeconds <= 0) return true;
    const history = input.history ?? [];
    const relevant = history.filter((sample) => sample.t >= sinceMs && sample.t <= input.timestampMs);
    if (relevant.length < 2 || relevant[0].t > sinceMs + 1_500) return false;
    return relevant.every((sample) => {
        if (!sample.btcPrice || !input.openPrice) return false;
        const margin = (sample.btcPrice / input.openPrice - 1) * 10_000 * (leg === "UP" ? 1 : -1);
        const triggerAsk = leg === "UP" ? sample.downAsk : sample.upAsk;
        return margin >= input.params.minDirectionalBtcMarginBps && triggerAsk <= input.params.triggerPrice;
    });
}

function clearCandidate(state: Btc5mReverseTouchEdgeState): Btc5mReverseTouchEdgeState {
    return state.entered ? state : {};
}
