export type Btc5mPreviousCycleSnapshot = {
    timestampMs: number;
    secondsLeft: number;
    upMid: number;
};

export type Btc5mTrendRangeRegimeParams = {
    bandLower: number;
    bandUpper: number;
    minBandRatio: number;
    minCrossCount: number;
    minPriceRange: number;
    centerBuffer: number;
    minChoppiness: number;
    ignoreFinalSeconds: number;
    minSamples: number;
};

export type Btc5mTrendRangeRegimeMetrics = {
    oscillating: boolean;
    sampleCount: number;
    bandRatio: number;
    crossCount: number;
    priceRange: number;
    choppiness: number;
    minimum: number;
    maximum: number;
};

export function classifyPreviousCycleRegime(
    snapshots: Btc5mPreviousCycleSnapshot[],
    params: Btc5mTrendRangeRegimeParams,
): Btc5mTrendRangeRegimeMetrics {
    const eligible = snapshots
        .filter((snapshot) => snapshot.secondsLeft >= params.ignoreFinalSeconds && Number.isFinite(snapshot.upMid))
        .sort((left, right) => left.timestampMs - right.timestampMs);
    if (eligible.length < params.minSamples) {
        return { oscillating: false, sampleCount: eligible.length, bandRatio: 0, crossCount: 0, priceRange: 0, choppiness: 0, minimum: 0, maximum: 0 };
    }

    const values = eligible.map((snapshot) => snapshot.upMid);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const bandSamples = values.filter((value) => value >= params.bandLower && value <= params.bandUpper).length;
    let crossCount = 0;
    let pathLength = 0;
    let side: -1 | 0 | 1 = 0;
    for (let index = 0; index < values.length; index++) {
        const nextSide = values[index] <= 0.5 - params.centerBuffer
            ? -1
            : values[index] >= 0.5 + params.centerBuffer ? 1 : side;
        if (side !== 0 && nextSide !== side) crossCount++;
        side = nextSide;
        if (index > 0) pathLength += Math.abs(values[index] - values[index - 1]);
    }
    const bandRatio = bandSamples / values.length;
    const priceRange = maximum - minimum;
    const netMove = Math.abs(values[values.length - 1] - values[0]);
    const choppiness = pathLength / Math.max(netMove, 0.01);
    return {
        oscillating: bandRatio >= params.minBandRatio
            && crossCount >= params.minCrossCount
            && priceRange >= params.minPriceRange
            && choppiness >= params.minChoppiness,
        sampleCount: values.length,
        bandRatio,
        crossCount,
        priceRange,
        choppiness,
        minimum,
        maximum,
    };
}
