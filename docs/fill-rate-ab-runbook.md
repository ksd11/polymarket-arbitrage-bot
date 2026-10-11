# 成交率 A/B 对比运行手册（GTC vs FAK）

> 目标：在同一策略、同一时间窗口下，分别用 **GTC 挂单（maker）** 与 **FAK 吃单（taker）** 跑一轮，
> 对比两者的**成交率、全成交率、拒单率、成交延迟**，量化"挂单 vs 吃单"在真实撮合引擎上的差异。

---

## 一、当前状态：账户已充值 $5.11，可以跑真实 A/B

> **更正（2026-10-08）**：本手册初版曾写"钱包为空、实盘跑不了"，**该结论是错的**。
> 错因：只查了 USDC.e 与原生 USDC 两种代币，而 Polymarket **V2 已改用 `pUSD` 作为交易抵押品**
> （`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`，符号 `pUSD`，6 位小数）。
> 查错代币 + 手工拼接 `eth_call` calldata 出错 → 得到了一串假 0。

用项目自己的客户端路径（`npm run balance:show`）复核，结果如下：

| 检查项 | 结果 | 来源 |
|--------|------|------|
| 签名地址（EOA） | `0x8Fb895a4325f596b2259a4aF9e5F4a19C37Aa8Dd` | 由 `.env` 的 `WALLET_PRIVATE_KEY` 推导 |
| 资金地址（funder） | `0x2918746A2EDeC0afE782057dB3cc143bb63989E3` | `.env` 的 `PROXY_WALLET_ADDRESS`（`SIG_TYPE=proxy` → `POLY_1271` 存款钱包模式） |
| **CLOB 抵押品余额** | **5.112595 USDC**（raw `5112595`） | `client.getBalanceAllowance({asset_type: COLLATERAL})`，先 `updateBalanceAllowance` 同步链上 |
| 链上 pUSD 余额 | **5.112595**（raw `5112595`） | ethers `balanceOf(funder)` — 与 CLOB 完全一致 |
| 授权 allowance | 4 个 V2 交易所合约均为 `uint256 max` | 同上（授权已就绪，无需再 approve） |
| 未成交挂单 | **0** | `client.getOpenOrders()` |
| 下单扣款地址 | `0x2918746A2EDeC0afE782057dB3cc143bb63989E3` | `order.maker`（`npm run balance:probe-maker`，只签名不提交） |

**结论**：账户有 **$5.11**，授权已就绪、无挂单占用，**可以直接下单，真实 A/B 可以跑。**
资金量偏小：每笔订单由 `<PREFIX>_ORDER_SHARES` 决定，而 **CLOB 的最小下单量是 5 股**（见下节），
单价 0.5~0.9 → **单笔约 $2.5~$4.5**，所以 $5.11 大约只够**同时持有 1 笔**。

> 注：链上 USDC.e / 原生 USDC 余额确实都是 0 —— 那是**正常的**，V2 交易并不使用这两种代币。

---

## 一·补、最小下单量是 5 股，不是 1（2026-10-08 更正）

> **更正**：本手册初版建议"跑统计样本前把 shares 调到最小档（例如 1）"，**该建议是错的**。

**实测**（`GET /book?token_id=<当前 btc-updown-5m 市场>`）：

```
min_order_size = 5
tick_size      = 0.01
neg_risk       = False
```

即 CLOB 对**订单股数**有 **5 股硬下限**（与 $1 名义金额下限**相互独立**），低于该值会返回
永久性拒单 `Size lower than the minimum: 5`，重试永远不会成功。
BTC 5m 市场的入场价约 0.85，**5 股 ≈ $4.25 已是不可再压缩的单笔最小成本**：

- 把 `*_ORDER_SHARES` 调到 1、2、4 → 订单全部会被跳过/拒绝，**跑不出任何样本**；
- 因此 $5.11 的资金**只能同时持有 1 笔**，无法同时铺两条腿（例如 `dynamic-range` 的双腿需要 10 股 ≈ $8.5，资金不够）。

**代码侧已加固**：`src/btc-5m-latency-scalp.ts` 的下单前置守卫新增**股数下限检查**
（`<PREFIX>_MIN_ORDER_SHARES`，默认 5，常量 `CLOB_MIN_ORDER_SHARES`）：
低于下限的订单会被**明确跳过并记录原因**，而不是把注定被拒的单子发给交易所；
启动时若当前模式的配置股数低于下限，会立刻打印 WARNING。


---

## 二、为"可对比"所做的改动

要让 GTC / FAK 两轮数据**可区分、可度量**，补了两处：

### 1. 记录埋点（`src/btc-5m-latency-scalp.ts`）

事件行新增两列：

| 列 | 含义 |
|----|------|
| `order_type` | 该订单实际下发到 CLOB 的类型（GTC / FOK / GTD / FAK） |
| `fill_latency_ms` | `首次成交时刻 - 挂单时刻`，即成交延迟 |

之前记录里**没有** `order_type`，GTC 与 FAK 两轮数据无法区分，对比无从谈起。

### 2. 成交率分析器（`src/utils/fill-rate-report.ts`）

```bash
npm run report:fill-rate -- <csv...> [--json]
```

按 `order_type`（并可细分到 `order_type × side`）输出：

```
order_type  side  posted  filled  full  fill%  full%  rej  skip  defer  rej%  p50ms  p90ms
GTC         BUY       10       6     4  60.0%  40.0%   1     2      1  7.1%   1700   2900
FAK         BUY       10       8     8  80.0%  80.0%   2     0      0 16.7%    210    330
```

口径说明：
- `filled` = 至少部分成交的订单数；`full` = 完全成交的订单数（`filled_size >= size`）。
- `fill%` / `full%` 以 `posted` 为分母；`rej%` 以 `posted+rej+skip+defer` 为分母。
- 成交延迟取每笔订单首次成交的 `fill_latency_ms`。

### 3. 一键 A/B 运行器（`src/utils/fill-ab.ts` → `npm run btc5m:fill-ab`）

串联"GTC 一轮 → FAK 一轮 → 出报告"，**默认 dry-run**，只有显式 `CONFIRM_LIVE=yes` 才真下单。
（放在 `src/` 而非 `scripts/`，因为本仓库 `.gitignore` 忽略了 `scripts`。）

---

## 三、怎么跑

### 前置：确认账户资金与授权（已就绪，无需充值）

```bash
# 只读：打印 CLOB 余额 + 链上交叉核验 + 挂单数
npm run balance:show

# 只读：确认下单将从哪个地址扣款（只签名，不提交）
npm run balance:probe-maker
```

当前已确认：余额 5.112595（CLOB 与链上一致）、allowance 全部 max、0 挂单 → 可直接下单。
`.env` 里 `SKIP_ALLOWANCE_APPROVE=true` 成立，因为授权已经就绪。

### 方式 A：一键运行器

```bash
# 1) 先 dry-run 验证链路（不花钱）
MODE=final-30-managed CYCLES=2 npm run btc5m:fill-ab

# 2) 真实 A/B（真金白银，会警告并留 5 秒中止窗口）
CONFIRM_LIVE=yes MODE=final-30-managed CYCLES=4 npm run btc5m:fill-ab
```

产物：`data/fill-ab/gtc-<stamp>.csv`、`data/fill-ab/fak-<stamp>.csv` 及对应 `.log`，末尾自动打印对比报告。

### 方式 B：手动分两轮

```bash
# GTC 轮（挂单）
BTC5M_SCALP_MODE=final-30-managed \
  FINAL_30_MANAGED_DRY_RUN=false FINAL_30_MANAGED_ORDER_TYPE=GTC \
  FINAL_30_MANAGED_RECORD_FILE=data/fill-ab/gtc.csv \
  npx tsx src/btc-5m-latency-scalp.ts

# FAK 轮（吃单）——同样的策略与参数，只换 ORDER_TYPE
BTC5M_SCALP_MODE=final-30-managed \
  FINAL_30_MANAGED_DRY_RUN=false FINAL_30_MANAGED_ORDER_TYPE=FAK \
  FINAL_30_MANAGED_RECORD_FILE=data/fill-ab/fak.csv \
  npx tsx src/btc-5m-latency-scalp.ts

# 对比
npm run report:fill-rate -- data/fill-ab/gtc.csv data/fill-ab/fak.csv
```

建议**两条腿尽量覆盖相邻的时间窗**（例如都在 UTC 白天/夜间同一时段），否则市场状态差异会污染结论。

---

## 四、关于样本量：为什么"一轮"通常不够

- 5 分钟一个周期，`final-30-*` 只在周期**最后 30 秒**触发，通常**每周期 0~2 笔**。
- 要得到统计上有意义的成交率，粗略需要 **≥30~50 笔/腿**，即 **约 20~40 个周期（2~4 小时）**。
- 因此"一轮"若指一个周期，只能验证**链路通不通**；真正的对比需要**多周期长跑**。

### 何时能做"更快"的对比

`FAK/FOK` 是**立即成交否则取消**，成交与否在**下单响应里就确定了**（毫秒级反馈），
不像 GTC 需要靠后续轮询确认。因此 FAK 腿的数据密度更高、可更快收敛；
GTC 腿受"挂上后是否被吃"影响，需要更长时间积累。

---

## 五、风险与注意事项

- **策略目前是负期望**：`docs/backtest-fee-fill-fix.md` 已用 30 天回测证明，
  在真实手续费 + 真实成交口径下，`cmm-v2` -3.54%、`final-30-managed` -4.71%、`final-30-high` -22.66%。
  **这一轮 A/B 的目的是测量成交率，不是盈利，预期会亏损。**
- 用**最小可交易规模**把成本压到最低 —— 但最小规模是 **5 股**（`<PREFIX>_ORDER_SHARES=5`），
  **不能再往下调**；调低只会让订单被守卫跳过。$5.11 只够 1 笔在途，样本要靠**多次周转**（每周期 1 笔）累积。
- `SKIP_ALLOWANCE_APPROVE=true` 仅在授权已就绪时成立；若新地址，先跑授权。
- 长跑请让进程**稳定驻留**（`nohup`/`tmux`），并保留 `.log` 以便复现拒单原因
  （本次已修复错误正文丢失问题，拒单会打印真实原因而非裸 `400`）。

---

## 六、验证记录（本次已做）

| 项 | 结果 |
|----|------|
| `tsc --noEmit` | 通过（0 error） |
| 分析器逻辑 | 合成 CSV 验证：GTC 60%/1700ms、FAK 80%/210ms，符合 maker/taker 特征 |
| 埋点写入 | 真实 dry-run 采集到 `order_type=GTC`、`fill_latency_ms=101` |
| CLOB 连通性 | `clob.polymarket.com/markets`、`/time` → 200（经本机代理 `127.0.0.1:7890`） |
| 最小下单量 | `GET /book` 实测 `min_order_size=5`（BTC 5m 市场）；历史日志亦见 `CLOB minimum order size: UP=5, DOWN=5` |
| 股数守卫 | 单测 10/10 通过；dry-run 实跑：`shares=1` 时启动即 WARNING "below the CLOB minimum of 5 shares" |
| A/B 脚本 | dry-run 两腿串联 + 自动报告，机制验证通过 |
