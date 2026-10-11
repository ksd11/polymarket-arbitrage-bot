# B0 + 绝对止损 0.50 —— 实现与实盘记录

> 用户要求：在 0.50 处止损，然后实盘验证。
> 实盘启动：2026-10-11 10:01:34（记录 `data/live-b0-20261011-100134.csv`）
> 复现：`STOP=0.50 bash scripts/strat-b0.sh backtest` / `MAXP=0.96 BUF=0.01 BUYSHARES=true STOP=0.50 DRY_RUN=false bash scripts/strat-b0.sh live`

---

## 1. 为什么要新增"绝对止损价"参数

`final-30-managed` 原本只有**相对入场价**的止损（`src/strategies/btc5m/final-30-managed.ts:114`）：

```ts
stopLossPrice = entryPrice - stopLossDelta
contractStop  = stopLossDelta > 0 && bid <= stopLossPrice
```

这对"0.50 止损"是**不成立**的：入场价 0.95 时 `0.95 − 0.45 = 0.50` ✓，但**崩盘成交**（0.55 入场）时 `0.55 − 0.45 = 0.10`——止损形同虚设，而这恰恰是最需要保护的场景。

**新增绝对价位参数** `stopLossPrice`（env `FINAL_30_MANAGED_STOP_LOSS_PRICE`，0 = 关闭）：

```ts
const absoluteStopPrice = input.params.stopLossPrice ?? 0;
const stopLossPrice = absoluteStopPrice > 0
    ? absoluteStopPrice
    : input.position.entryPrice - input.params.stopLossDelta;
const stopEnabled = absoluteStopPrice > 0 || input.params.stopLossDelta > 0;
const contractStop = stopEnabled && bid <= stopLossPrice;
```

改动文件：`src/strategies/btc5m/final-30-managed.ts`（类型 + 逻辑）、`src/btc-5m-latency-scalp.ts`（配置 / 校验 / 启动横幅）、`src/backtest/btc-5m-backtest.ts`（配置 / 校验 / 参数打印 / 回测接线）。`npx tsc --noEmit` = 0 错误。

**触发条件**（本次实盘）：`bid ≤ 0.50` → 立即以 `bid` 卖出 5 股（taker）。
`stopLossDelta=0`（相对止损关闭）、`stopMinBtcReversalBps=0`（不要求 BTC 反转确认）、`stopConfirmSeconds=0`（不等待）。

---

## 2. 引擎回测（仓库自带回测器，30 天文件，4,201 笔）

> ⚠️ 回测用严格买价 0.95（`strat-b0.sh` 的 `MAXP` 默认值），实盘用 0.96+0.01 缓冲。下表是**同一口径下止损 vs 不止损**的对照。

| 配置 | 止损次数 | 胜率 | 毛PnL | 手续费 | **净PnL** | ROI | **最大回撤** |
|---|---|---|---|---|---|---|---|
| **无止损** | 0 | **94.86%** | −$29.75 | $69.84 | **−$99.59** | −0.50% | **$136.42** |
| 止损 0.40 | 271（6.5%） | 93.29% | +$2.48 | $87.28 | −$84.81 | −0.43% | $118.65 |
| **止损 0.50** | **312（7.4%）** | **92.38%** | +$0.98 | $92.95 | **−$91.97** | −0.46% | **$101.35** |
| 止损 0.60 | 358（8.5%） | 91.36% | +$10.06 | $97.81 | −$87.75 | −0.44% | **$96.59** |

**怎么读：**

1. **回撤确实降了 26%**（$136.42 → $101.35）。这是这次改动**最确定的好处**——正是你要的"收益形状"改善。
2. **毛 PnL 大幅改善**（−$29.75 → +$0.98，+$30.7），因为大亏被砍掉了。
3. **但出场手续费涨了 $23.1**（$69.84 → $92.95，每笔止损都要付一次）。所以**净额只改善 $7.6**。
4. **胜率下降 2.48pp**（94.86% → 92.38%）。7.4% 被止损的仓位里，**大部分本来会赢**（路径校准：价格跌到 0.50 时真实胜率仍有 **54.2%**）。
5. ⚠️ **最差单笔仍可能接近全损**：止损挡不住**跳空**。价格可以从 0.55 直接跳到 0.01，中间没有可挂出卖单的价位。独立模拟（44.9 天，`scripts/b0_payoff_reshaper.py`）显示：**全部 11 个止损位的最差单笔恒为 −96.3c/股**。

---

## 3. 实盘配置

```
MAXP=0.96 BUF=0.01 BUYSHARES=true STOP=0.50 DRY_RUN=false bash scripts/strat-b0.sh live
```

启动横幅（已核对）：

```
Starting final-30-managed: ask>=0.95 in final 300s, max=0.96, shares=5,
  takeProfitDelta=0, stopLossDelta=0, stopLossPrice=0.5, btcReversal=0bps/0s,
  entryVel=off, entryAccel=off, dryRun=false
Taker BUY sizing: shares (limit endpoint + FAK; loss = size x fill)
USDC gate passed: available=15.156218 >= 4.8
```

护栏：`bash scripts/guard-live.sh "$REC" 40 6.0 3`（成交 40 笔 / 累计 −$6.0 / 连亏 3 笔 → 自动停）。

**相对昨夜那一轮，唯一变化就是加了 `STOP=0.50`**，其余（0.96+0.01 缓冲、5 股、无 bps/时间过滤、无速度门控）完全一致——便于 A/B 对比。

### 停止 / 恢复

```bash
pkill -f 'btc-5m-[l]atency-scalp'    # 停（护栏会自行退出）
STOP=0 ... bash scripts/strat-b0.sh live   # 想关掉止损就 STOP=0（回到昨夜口径）
```

---

## 4. 期望与注意

**相对昨夜（无止损）基线**，本次应观察到：

| 指标 | 预期 |
|---|---|
| 止损触发率 | ≈ **7–8%** 的成交笔数 |
| 胜率 | 从 ~95% 降到 ≈ **92%** |
| 单笔亏损 | 止损单 ≈ **−$2.3**（5 × 0.46）；**跳空单仍可能 −$4.8** |
| 回撤 | 明显变小 |
| 净额 | 大概率**略好**，但改善很小（被出场费吃掉大半） |

**要盯的两件事**：
1. **止损触发率若远高于 10%** ⇒ 说明这段行情波动远大于历史，回测基线不适用。
2. **跳空单（亏损接近 −$4.8 却仍有 stop loss 记录）的数量** ⇒ 这是止损挡不住的尾部，直接检验"能不能避免 0.95×share 的损失"这个诉求。

**如实说明**：这次改动**改善的是回撤与收益形状，不是期望**。数学上出场价是鞅（`E[出场价] = 入场价`），任何出场规则都无法创造期望；能创造的期望只在入场侧。
