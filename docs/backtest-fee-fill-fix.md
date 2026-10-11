# 回测口径修正：手续费 + 成交假设（P0）

> 日期：2026-10-08
> 改动文件：`src/backtest/btc-5m-backtest.ts`
> 数据源：`data/btc5m-history-30days-5s.csv`（8/2~9/4，9546 cycle）

## 一、问题回顾

原回测存在两处与实盘脱节的口径：

| # | 问题 | 原实现 | 实盘真实情况 |
|---|------|--------|--------------|
| 1 | **手续费未计入** | `pnl = payout - cost`，fee 只 console 打印估算 | 每笔吃单都要收费 |
| 2 | **成交假设不显式** | `final-30-high` 按快照 ask **立即成交**（taker） | 执行器用 `OrderType.GTC` 挂 resting 限价单（`btc-5m-latency-scalp.ts:681`），常被拒（400）或挂着不成交 |

## 二、改动内容

1. **费用模型**（新增 `--fee-rate` / `--no-fees`，默认 `0.07`）
   - 复用仓库既有的 `polymarketFeeEquivalent(shares, price, rate) = shares × rate × price × (1 - price)`，保证回测与 `maker-range` 口径一致。
   - 吃单买入、吃单卖出各计一次；**到期结算（redeem）不计费**（链上免费）。
   - `Trade` 新增 `fee` 字段；`netPnL = payout − cost − fee`；`cycleTradeTotals`、`printSummary`、回撤/连亏统计、trade CSV 全部改为净口径，并同时输出 **grossPnL / netPnL / netROI**。

2. **成交假设显式化**（新增 `--fill-mode taker|maker`，默认 `taker`）
   - `taker`：维持原行为（快照 ask 立即成交）。
   - `maker`：挂限价，**只有后续快照 ask 触达挂单价才成交**——与实盘 GTC 挂单语义一致。
   - 首期已接入 `final-30-high`（即实盘亏损被记录的那条路径）。

3. 新增 `BACKTEST_TAKER_FEE_RATE` / `BACKTEST_FILL_MODE` 环境变量；`--help` 已补文档。

> 说明：默认仍为 `taker` + `0.07`，即"最优成交假设 + 真实费用"，属于**乐观上界**；`--fill-mode maker` 给出**保守下界**。两者之差就是成交假设的不确定性。

## 三、30 天实测结果（9546 cycle）

### 3.1 cmm-v2（conditional-market-maker-v2）

| 口径 | 胜率 | fees | grossPnL | netPnL | netROI | maxDrawdown |
|------|------|------|----------|--------|--------|-------------|
| 无费用（旧结论） | 47.55% | 0 | +13.95 | +13.95 | **+0.07%** | 241.00 |
| 含费用 0.07 | 47.55% | 749.20 | +13.95 | **-735.25** | **-3.54%** | 800.31 |

**旧结论 +0.07% 的"alpha"在真实手续费下是 -3.54%（-$735）。**

### 3.2 final-30-high（实盘 400 拒单的那条策略）

| 口径 | entries | 胜率 | fees | grossPnL | netPnL | netROI |
|------|---------|------|------|----------|--------|--------|
| taker（乐观） | 672 | 87.95% | 10.07 | +2.33 | -7.74 | **-0.66%** |
| maker（贴近实盘） | **242** | **68.60%** | 3.64 | -92.54 | -96.18 | **-22.66%** |

**关键**：改挂单口径后，成交数从 672 掉到 242（-64%），胜率从 87.95% 掉到 68.60%。这正是实盘 218 次 400 拒单的量化翻译——**能成交的恰恰是逆向选择最差的一批**。

### 3.3 final-30-managed（实盘真实亏损策略）

| 口径 | entries | 胜率 | fees | grossPnL | netPnL | netROI |
|------|---------|------|------|----------|--------|--------|
| 含费用 0.07 | 193 | 82.38% | 8.01 | -31.92 | **-39.93** | **-4.71%** |

与实盘记录（4 天真实成交 113 笔、净亏 -$37.92）高度吻合。此前回测显示的"薄利"是假象。

## 四、结论

1. **手续费是决定性变量**：所有薄利策略（cmm-v2 +0.07%、final-30-high +0.20% gross）在真实费用下全部翻负。
2. **成交假设与手续费同等重要**：final-30-high 从 -0.66% 恶化到 -22.66%，说明"回测按 ask 立即成交"严重高估了可得性。
3. **项目原有结论需按新口径重跑**：`docs/cmm-v2-backtest-report.md`、`docs/final-30-managed-live-backtest-analysis.md` 中的 ROI 均为毛口径，应视为**上界**。
4. 方向性结论不变（DOWN 腿优于 UP、市场近似有效），但绝对水平整体下移。

## 五、用法

```bash
# 乐观上界（默认）：taker 成交 + 0.07 手续费
npm run backtest:btc5m -- --strategy conditional-market-maker-v2 --csv data/btc5m-history-30days-5s.csv

# 保守下界：maker 挂单成交 + 手续费
npm run backtest:btc5m -- --strategy final-30-high --fill-mode maker --csv data/btc5m-history-30days-5s.csv

# 自定义费率 / 关闭费用（复现旧结论）
npm run backtest:btc5m -- --strategy conditional-market-maker-v2 --csv data/btc5m-history-30days-5s.csv --fee-rate 0.02
npm run backtest:btc5m -- --strategy conditional-market-maker-v2 --csv data/btc5m-history-30days-5s.csv --no-fees
```

## 六、遗留（下一步）

- `--fill-mode maker` 目前仅覆盖 `final-30-high`；`final-30-hedged/managed`、`latency-scalp`、`trend-pullback` 等仍为各自既定口径，需逐一接入。
- 真实费率应以 Polymarket 当前 crypto 市场 taker 费率为准（现按仓库既有约定取 0.07），建议按官方文档校准。
- 400 拒单应上升到执行层修复：入口改吃单（FOK/IOC）或下单前用最新盘口重新取价。
