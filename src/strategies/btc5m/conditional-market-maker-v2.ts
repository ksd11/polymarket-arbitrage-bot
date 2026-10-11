import { buildBtc5mMarketMakerQuotes, Btc5mMarketMakerInput } from "./market-maker";
import { Btc5mLeg, Btc5mStrategyDecision, Btc5mStrategyQuote, clamp } from "./types";

/**
 * conditional-market-maker-v2 (cmm-v2) —— 早期低价腿买入策略
 *
 * 数据驱动结论（基于 47 万样本的全量统计，见回测分析）：
 *   Polymarket BTC 5min 市场近似有效定价，纯做市（对称双边报价）实测 ROI -6.3%。
 *   核心亏损来自：做市买入的平价腿（>=0.50）被系统性高估，到期归零拖累整体。
 *
 * 真正稳健的 alpha：
 *   1. 低价腿（ask <= maxBidPrice，约 0.45）在"早期"（seconds_left 较大）买入
 *      有正期望，尤其是 DOWN 腿（赌跌）结构性更强（BTC 5min 存在跌快涨慢的不对称）。
 *   2. 末段（seconds_left 小）的低价腿是"已经快归零的腿"，必须规避。
 *   3. 高价腿（ask >= 0.55）系统性负期望，一律不买。
 *
 * 因此本策略从"做市"改为"早期低价腿择时买入 + 持有到到期"：
 *   - 只有当某条腿的 ask 落在 [minBidPrice, maxBidPrice] 区间时才买入。
 *   - 只买早期（seconds_left >= minSecondsLeftToBuy）。
 *   - 默认只买 DOWN 腿（buyLegsOnly="DOWN"）：样本外验证（7/24 留出集）显示
 *     DOWN 低价腿有稳健正期望（跌快涨慢不对称），而 UP 低价腿拖累整体表现。
 *   - 方向动量过滤默认关闭（directionMinMomentumBps=999）：对 DOWN 腿而言，
 *     逆势抄底恰恰是 alpha 来源，过滤反而伤害收益。
 *   - 持有到到期（赢则返 1，输则归零），不做中途对冲。
 *
 * 回测结果：
 *   3 天数据（btc5m-history-3days.csv，859 cycle）：
 *     默认配置（DOWN + maxBid=0.55）：ROI +2.68%，cycle win rate 51.18%。
 *   30 天数据（btc5m-history-30days-5s.csv，9546 cycle，2026-09-05 补充）：
 *     默认配置：ROI +0.07%，win rate 47.55% —— **alpha 基本消失，接近零**。
 *     按周分解：+3.38% / -1.12% / -2.96% / -0.29% / +1.99%，波动剧烈、无稳健性。
 *   对比 cmm 做市 baseline：ROI -6.44%，win rate 27%。
 *
 * 诚实结论：Polymarket BTC 5min 市场定价高度有效。DOWN 低价腿**系统性优于
 * UP 低价腿**（方向性结论在 30 天大样本上依然成立，DOWN +0.07% vs UP -2.40%），
 * 但 DOWN 腿本身没有稳健的正 alpha，30 天累计接近零。3 天的 +2.68% 是小样本
 * 过拟合，不可据此实盘。
 *
 * 与 cmm 的关系：复用了 cmm 的参数结构（history / conditionalParams），
 * 但入口函数完全重写为低价腿 taker 买入逻辑，不再调用做市报价。
 */

export type Btc5mConditionalMarketMakerSample = {
    timestampMs: number;
    btcPrice: number;
};

export type Btc5mConditionalMarketMakerParams = {
    lookbackSeconds: number;
    accelerationLookbackSeconds: number;
    maxRangeBps: number;
    maxTrendBps: number;
    maxTrendEfficiency: number;
    trendEfficiencyMinMomentumBps: number;
    maxAccelerationBps: number;
    directionMinMomentumBps: number;
    favoredPriceImprove: number;
    unfavoredPriceOffset: number;
    favoredSizeMultiplier: number;
    unfavoredSizeMultiplier: number;
    maxNetInventoryShares: number;
    minOrderUsdc: number;
    minOrderShares: number;
    minSellProfit: number;
    forceFlattenSecondsBeforeEnd: number;
    maxUnpairedSeconds: number;
    pairOrderMaxAgeSeconds: number;
    // v2 新增：低价腿买入区间 + 早期时间门槛。
    minBidPrice: number;
    maxBidPrice: number;
    minSecondsLeftToBuy: number;
    // v2 新增：只买哪条腿（"BOTH" | "UP" | "DOWN"）。数据表明 DOWN 腿结构性更强。
    buyLegsOnly?: "BOTH" | "UP" | "DOWN";
};

export type Btc5mConditionalMarketMakerInput = Btc5mMarketMakerInput & {
    timestampMs: number;
    btcPrice?: number;
    history: Btc5mConditionalMarketMakerSample[];
    conditionalParams: Btc5mConditionalMarketMakerParams;
};

export type Btc5mConditionalMarketMetrics = {
    momentumBps: number;
    accelerationBps: number;
    rangeBps: number;
    trendEfficiency: number;
    favoredLeg?: Btc5mLeg;
};

export function buildBtc5mConditionalMarketMakerV2Quotes(input: Btc5mConditionalMarketMakerInput): Btc5mStrategyDecision & { metrics?: Btc5mConditionalMarketMetrics } {
    const metrics = calculateConditionalMarketMetrics(input.timestampMs, input.btcPrice, input.history, input.conditionalParams);
    const quotes: Btc5mStrategyQuote[] = [];

    // 早期门槛：末段不买（低价腿临近到期多为"已输腿"）。
    if (input.secondsLeft < input.conditionalParams.minSecondsLeftToBuy) {
        return { quotes, reason: "v2 skip: too close to settlement", metrics };
    }

    // 方向动量过滤：明确加速/超强趋势时规避（避免接飞刀）。
    if (metrics && Math.abs(metrics.accelerationBps) >= input.conditionalParams.maxAccelerationBps) {
        return { quotes, reason: `v2 skip: rapid BTC move ${metrics.accelerationBps.toFixed(2)}bps`, metrics };
    }
    if (metrics && Math.abs(metrics.momentumBps) > input.conditionalParams.maxTrendBps) {
        return { quotes, reason: `v2 skip: BTC trend too strong ${metrics.momentumBps.toFixed(2)}bps`, metrics };
    }

    const params = input.params;
    const netInventory = input.state.qUp - input.state.qDown;
    const maxNet = input.conditionalParams.maxNetInventoryShares;

    // UP 腿：低价买入（顺势优先）。
    if (input.conditionalParams.buyLegsOnly !== "DOWN") {
        maybeBuyCheapLeg(quotes, input, "UP", metrics?.favoredLeg, netInventory, maxNet);
    }
    // DOWN 腿：低价买入。
    if (input.conditionalParams.buyLegsOnly !== "UP") {
        maybeBuyCheapLeg(quotes, input, "DOWN", metrics?.favoredLeg, netInventory, maxNet);
    }

    // 保护性卖出：已有持仓且已进入末段时平仓（复用做市的 sell-excess 语义的简化版）。
    const sellQuotes = buildProtectedSells(input);
    quotes.push(...sellQuotes);

    return {
        quotes,
        reason: quotes.length ? `v2 cheap-leg buy ${quotes.filter((q) => q.side === "BUY").length} leg(s)` : "v2 no cheap leg",
        metrics,
    };
}

/**
 * 低价腿买入：当 ask 落在 [minBidPrice, maxBidPrice] 区间、且净持仓未超限时，
 * taker 买入该腿。方向动量明确时，顺趋势腿加量、逆趋势腿减量/跳过。
 */
function maybeBuyCheapLeg(
    quotes: Btc5mStrategyQuote[],
    input: Btc5mConditionalMarketMakerInput,
    leg: Btc5mLeg,
    favoredLeg: Btc5mLeg | undefined,
    netInventory: number,
    maxNet: number,
): void {
    const { conditionalParams: cp, params } = input;
    const ask = leg === "UP" ? input.up?.bestAsk : input.down?.bestAsk;
    if (ask === undefined || ask === null) return;
    if (!(ask >= cp.minBidPrice && ask <= cp.maxBidPrice)) return;

    // 净持仓方向约束：同向持仓已达上限则不再加。
    const sameDirectionInventory = leg === "UP" ? netInventory : -netInventory;
    if (sameDirectionInventory >= maxNet) return;

    // 方向性：动量明确时，逆趋势的低价腿直接跳过（接飞刀风险）。
    if (favoredLeg !== undefined && leg !== favoredLeg) return;

    const inventoryCapacity = Math.max(0, maxNet - sameDirectionInventory);
    const budget = params.maxUsdcPerLeg > 0
        ? Math.max(0, params.maxUsdcPerLeg - (leg === "UP" ? input.state.buyCostUp : input.state.buyCostDown))
        : Number.POSITIVE_INFINITY;
    if (budget <= 0) return;

    const size = Math.min(params.quoteShares, inventoryCapacity, budget / ask);
    if (size + 1e-9 < cp.minOrderShares || ask * size + 1e-9 < cp.minOrderUsdc) return;

    quotes.push({
        key: `${leg}:BUY`,
        leg,
        side: "BUY",
        tokenId: leg === "UP" ? input.upTokenId : input.downTokenId,
        price: ask,
        size,
        fair: 1 - ask, // 名义 fair（低价腿的隐含赢面），仅用于记录 edge 展示。
        edge: (1 - ask) - ask,
        note: "v2 cheap-leg buy",
    });
}

/**
 * 保护性卖出：持仓进入末段（secondsLeft <= forceFlattenSecondsBeforeEnd）时，
 * 以 bestBid 卖出剩余持仓，避免持有到到期全额归零。
 */
function buildProtectedSells(input: Btc5mConditionalMarketMakerInput): Btc5mStrategyQuote[] {
    const { conditionalParams: cp } = input;
    if (input.secondsLeft > cp.forceFlattenSecondsBeforeEnd) return [];
    const quotes: Btc5mStrategyQuote[] = [];
    for (const leg of ["UP", "DOWN"] as Btc5mLeg[]) {
        const shares = leg === "UP" ? input.state.qUp : input.state.qDown;
        if (shares <= 0) continue;
        const bid = leg === "UP" ? input.up?.bestBid : input.down?.bestBid;
        if (bid === undefined || bid === null || bid <= 0) continue;
        quotes.push({
            key: `${leg}:SELL`,
            leg,
            side: "SELL",
            tokenId: leg === "UP" ? input.upTokenId : input.downTokenId,
            price: bid,
            size: shares,
            note: "v2 flatten before settlement",
        });
    }
    return quotes;
}

export function calculateConditionalMarketMetrics(
    timestampMs: number,
    btcPrice: number | undefined,
    history: Btc5mConditionalMarketMakerSample[],
    params: Btc5mConditionalMarketMakerParams,
): Btc5mConditionalMarketMetrics | undefined {
    if (!btcPrice || btcPrice <= 0) return undefined;
    const startMs = timestampMs - params.lookbackSeconds * 1000;
    const samples = history.filter((sample) => sample.timestampMs >= startMs && sample.timestampMs <= timestampMs && sample.btcPrice > 0);
    if (samples.length < 3 || samples[0].timestampMs > startMs + 2000) return undefined;
    const first = samples[0].btcPrice;
    const momentumBps = (btcPrice / first - 1) * 10_000;
    const accelerationStartMs = timestampMs - params.accelerationLookbackSeconds * 1000;
    const accelerationSample = closestAtOrBefore(samples, accelerationStartMs) ?? samples[0];
    const accelerationBps = (btcPrice / accelerationSample.btcPrice - 1) * 10_000;
    const prices = samples.map((sample) => sample.btcPrice).concat(btcPrice);
    const rangeBps = (Math.max(...prices) / Math.min(...prices) - 1) * 10_000;
    let pathBps = 0;
    for (let index = 1; index < samples.length; index++) {
        pathBps += Math.abs((samples[index].btcPrice / samples[index - 1].btcPrice - 1) * 10_000);
    }
    const trendEfficiency = pathBps > 0 ? Math.min(1, Math.abs(momentumBps) / pathBps) : 0;
    const favoredLeg = Math.abs(momentumBps) >= params.directionMinMomentumBps ? (momentumBps > 0 ? "UP" : "DOWN") : undefined;
    return { momentumBps, accelerationBps, rangeBps, trendEfficiency, favoredLeg };
}

function closestAtOrBefore(samples: Btc5mConditionalMarketMakerSample[], timestampMs: number): Btc5mConditionalMarketMakerSample | undefined {
    let match: Btc5mConditionalMarketMakerSample | undefined;
    for (const sample of samples) {
        if (sample.timestampMs > timestampMs) break;
        match = sample;
    }
    return match;
}

// 保留导出以兼容可能的引用，但 v2 不再使用做市报价。
export { buildBtc5mMarketMakerQuotes };
export { clamp };
