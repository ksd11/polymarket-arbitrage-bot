# 执行层拒单修复报告（HTTP 400）

> 范围：`src/btc-5m-latency-scalp.ts`（全部 `BTC5M_SCALP_MODE` 共享执行器）+ 新增 `src/utils/order-guards.ts`
> 日期：2026-10-08

## 一、结论先行

实盘日志里那 218 次 `Failed to post ...: 400`，**不是"价格被抢"**，而是三类缺陷叠加：

| # | 缺陷 | 后果 |
|---|------|------|
| 🔴 1 | **错误正文被丢弃** | 客户端未传 `throwOnError`，SDK 不抛错；我方兜底只取 `status`，日志里永远只有裸 `400`，无法定位 |
| 🔴 2 | **SELL 与 CTF 余额入账竞态** | 买单成交后 ~300ms 内立刻挂 SELL，条件代币余额尚未记入，被判 `not enough balance` → 400 |
| 🟡 3 | **失败无退避、无分类** | 每次失败固定 1s 重试，瞬时错误与永久错误一视同仁，形成 300ms 级 400 风暴 |

**修复后**：错误正文可见 → 竞态被预检拦下（转为延后重试）→ 瞬时/永久错误分流并指数退避。

## 二、证据

数据源：`20260730/undervalued-final-managed-live-20260802-164206.csv`（7095 行，2 次拒单）。

### 2.1 拒单记录

```
risk-exit   UP  SELL  px=0.450000  size=5.000000  status=FAILED  error=400
risk-exit   UP  SELL  px=0.440000  size=5.000000  status=FAILED  error=400
```

### 2.2 精确时序（决定性证据）

```
09:18:25.874  order_posted              entry UP  BUY @0.59
09:18:26.406  order_fill_during_cancel  entry UP  MATCHED filled=5.0   ← 买入刚成交
09:18:26.729  order_rejected            risk-exit UP SELL @0.45  400   ← 323ms 后立刻卖
09:18:27.190  order_trade_correction    entry UP  BUY @0.56 MATCHED
09:18:30.234  order_posted              risk-exit UP SELL @0.46  ✅    ← 3.5s 后重试即成功
```

第二次完全同型：`09:26:06.480` 买入成交 → `09:26:06.823` 卖出 400 → `09:26:09.093` 重试成功。

**两次拒单都发生在 BUY 成交后 300~350ms，3.5s 后重试即通过。** 且当时 USDC 余额 $38.42、allowance 拉满——与资金无关，是**条件代币（CTF）余额入账延迟**。

### 2.3 错误正文为何丢失

```js
// @polymarket/clob-client-v2 dist/client.js:872
throwIfError(result) {
  if (this.throwOnError && result && "error" in result)
    throw new ApiError(result.error, result.status, result);
  return result;                  // ← throwOnError 默认 falsy，不抛
}
```

`src/providers/clobclient.ts` 构造 `ClobClient` 时**未传 `throwOnError`** → SDK 直接返回原始响应。随后执行器旧代码：

```ts
if (!orderId || response?.success === false)
    throw new Error(String(response?.errorMsg ?? response?.status ?? "..."));  // errorMsg 为空 → 只取到 "400"
```

真正的 `response.error`（例如 `not enough balance / allowance`）**在此处被丢弃**。

## 三、修复内容

### 3.1 新增 `src/utils/order-guards.ts`（纯函数，可单测）

| 导出 | 作用 |
|------|------|
| `extractErrorDetail` / `formatOrderError` | 从 Error / `ApiError.data` / axios `response.data` / 原始响应中提取正文，保留真实原因 |
| `classifyOrderError` | 归类为 `insufficient_balance` / `invalid_price` / `invalid_size` / `market_closed` / `rate_limited` / `network` / `unknown`，并给出 `retryable` |
| `normalizeOrderPrice(price, tickSize)` | 对齐 tick 网格；越界（`<tick` 或 `>1-tick`）返回 `null` |
| `normalizeOrderSize(size, step)` | 按步长**向下**取整，保证数量合法且只会变小 |
| `parseOrderType` / `isTakerOrderType` | 解析 `*_ORDER_TYPE`（GTC/GTD/FAK/FOK） |

### 3.2 `placeOrder` 重写（执行层）

```
1. 价格守卫   归一化到 tick 网格，越界 → order_skipped（不发请求）
2. 数量守卫   按 shareStep 向下取整
3. 名义守卫   price×size < minOrderNotional → order_skipped
4. 卖出预检   SELL 且非 dry-run：查询 CONDITIONAL 余额
              · 不足 → order_deferred（等待结算，750ms 起递增延后），不记为拒单、不取消策略
              · 余额查询失败 → 回退到"交给交易所判断"，不阻塞
5. 下单       保留完整响应正文，失败时把 `error` 一并抛出
6. 错误处理   瞬时错误 → 指数退避（base×2^n，封顶 maxOrderBackoffMs）
              永久错误 → 30s 冷启动，不重试
7. 成功       清空该 `role:side:leg` 的失败/延后计数
```

**卖出预检实现**（`sellableShares`）：先读 `getBalanceAllowance(CONDITIONAL, token_id)`，减去挂单中未成交的 SELL；若为 0，调用 `updateBalanceAllowance` 强制 CLOB 与链上重新同步后再读一次。命中缓存 TTL 250ms。

**行为差异**：只有**永久**拒单才把 `final-30-*` 的 `state.cancelled` 置位（旧代码任何拒单都直接退役策略，导致一个瞬时 400 就把整轮机会作废）。

### 3.3 吃单开关

旧代码硬编码 `OrderType.GTC`。现支持 `*_ORDER_TYPE`：

- `GTC`/`GTD` → `createAndPostOrder`（挂单，原行为，默认）
- `FAK`/`FOK` → `createAndPostMarketOrder`（吃单；BUY 传 USDC 金额、SELL 传份额）

这是"改 taker 而不是干等成交"的低成本落点，无需改代码即可 A/B。

## 四、新增环境变量（各模式自带前缀）

以 `DYNAMIC_RANGE_FINAL_MANAGED_` 为例（`LATENCY_SCALP_` / `FINAL_30_HIGH_` / `UNDERVALUED_FINAL_MANAGED_` / `DEEP_REBOUND_` 等同理）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `*_ORDER_TYPE` | `GTC` | `GTC`/`GTD`/`FAK`/`FOK` |
| `*_MIN_ORDER_NOTIONAL` | `1` | 低于交易所最小名义金额直接跳过；`0` 关闭 |
| `*_SHARE_STEP` | `0.01` | 数量取整步长；`0` 关闭 |
| `*_SETTLE_RETRY_MS` | `750` | 等余额结算的首次延后 |
| `*_MAX_ORDER_BACKOFF_MS` | `8000` | 退避封顶 |
| `*_MAX_ORDER_FAILURE_STREAK` | `5` | 连续延后/失败告警阈值 |
| `*_CONDITIONAL_BALANCE_TTL_MS` | `250` | 余额缓存 TTL |

## 五、验证

```bash
npx tsc --noEmit -p tsconfig.json        # 通过
npm run test:order-guards                # 9/9 通过（价格/数量/名义/错误分类/订单类型）
npm run test:order-reconciliation        # 2/2 通过（无回归）
DRY RUN 启动冒烟                          # 配置加载与执行器初始化正常
```

单测覆盖：`normalizeOrderPrice(0.865,"0.01")→0.87`、`normalizeOrderPrice(0.999,"0.01")→null`、
`normalizeOrderSize(2.1057,0.01)→2.1`、`classifyOrderError("not enough balance")→insufficient_balance/retryable`、
`classifyOrderError("invalid price (0.865)")→invalid_price/不重试` 等。

测试文件不可直接 import 执行器——该文件顶层即调用 `main()`；这也是守卫被抽到独立模块的原因。

## 六、遗留与建议

| 级别 | 事项 |
|------|------|
| 🟡 | **`dynamic-hedge` 的 400 仍未定因**。它是 `opposite-buy`（买对手腿），不是余额问题；当时错误正文已被丢弃，无法回溯。本次修复后**下一次复现会直接打印真实原因**，届时可精准处理。已加的"数量按 0.01 向下取整"是其中一个假设（`shareStep` 默认 0.0001 会产生 4 位小数数量）。 |
| 🟡 | **`minOrderNotional=1` 与 `shareStep=0.01` 是交易所契约的假设值**，请按 Polymarket 官方 crypto 市场规则校准一次。若误伤正常下单，把 `*_MIN_ORDER_NOTIONAL=0` / `*_SHARE_STEP=0` 关掉即可。 |
| 🟡 | `src/utils/balance.ts` 的 `getAvailableBalance` 存在**单位不一致**：`balance` 是 6 位小数的原始整数，而挂单 `original_size` 是"份额"，两者直接相减。（本次未复用该函数，另写了精确版本；但该函数是死代码且仍有隐患。） |
| 🟢 | `--fill-mode maker` 目前只覆盖 `final-30-high`，与本次吃单开关无关，可后续补齐。 |
| 🟢 | 建议把 `validateSellOrderBalance`/`validateBuyOrderBalance`（`src/utils/balance.ts`）要么接入、要么删除——目前是零调用的死代码。 |
