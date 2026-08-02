export type Btc5mConditionalReboundFeatures = {
    ask: number;
    askPercentile: number;
    fairEdge: number;
    contractMomentum: number;
    btcMomentumAlignedBps: number;
    secondsLeftRatio: number;
    spread: number;
    recentRange: number;
};

export type Btc5mConditionalReboundTrainingSample = {
    features: Btc5mConditionalReboundFeatures;
    label: 0 | 1;
};

export type Btc5mConditionalReboundModel = {
    weights: number[];
    means: number[];
    scales: number[];
};

export function trainBtc5mConditionalReboundModel(samples: Btc5mConditionalReboundTrainingSample[]): Btc5mConditionalReboundModel {
    if (samples.length < 20) throw new Error("conditional-rebound requires at least 20 training samples");
    const vectors = samples.map((sample) => featureVector(sample.features));
    const width = vectors[0].length;
    const means = Array.from({ length: width }, (_, index) => vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length);
    const scales = Array.from({ length: width }, (_, index) => {
        const variance = vectors.reduce((sum, vector) => sum + (vector[index] - means[index]) ** 2, 0) / vectors.length;
        return Math.max(1e-6, Math.sqrt(variance));
    });
    const normalized = vectors.map((vector) => [1, ...vector.map((value, index) => (value - means[index]) / scales[index])]);
    const weights = Array(normalized[0].length).fill(0);
    const learningRate = 0.08;
    const l2 = 0.002;
    for (let iteration = 0; iteration < 200; iteration++) {
        const gradient = Array(weights.length).fill(0);
        for (let row = 0; row < normalized.length; row++) {
            const probability = sigmoid(dot(weights, normalized[row]));
            const error = probability - samples[row].label;
            for (let column = 0; column < weights.length; column++) gradient[column] += error * normalized[row][column];
        }
        for (let column = 0; column < weights.length; column++) {
            const regularization = column === 0 ? 0 : l2 * weights[column];
            weights[column] -= learningRate * (gradient[column] / normalized.length + regularization);
        }
    }
    return { weights, means, scales };
}

export function predictBtc5mConditionalRebound(model: Btc5mConditionalReboundModel, features: Btc5mConditionalReboundFeatures): number {
    const vector = featureVector(features);
    const normalized = [1, ...vector.map((value, index) => (value - model.means[index]) / model.scales[index])];
    return sigmoid(dot(model.weights, normalized));
}

function featureVector(features: Btc5mConditionalReboundFeatures): number[] {
    return [
        features.ask,
        features.askPercentile,
        features.fairEdge,
        features.contractMomentum,
        features.btcMomentumAlignedBps / 10,
        features.secondsLeftRatio,
        features.spread,
        features.recentRange,
    ];
}

function dot(left: number[], right: number[]): number {
    return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function sigmoid(value: number): number {
    if (value >= 0) return 1 / (1 + Math.exp(-value));
    const exp = Math.exp(value);
    return exp / (1 + exp);
}
