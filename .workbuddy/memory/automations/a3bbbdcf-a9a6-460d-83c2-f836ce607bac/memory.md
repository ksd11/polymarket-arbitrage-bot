# 盯盘自动化记忆（BTC 5m final-30-managed）

自动化 id: a3bbbdcf-a9a6-460d-83c2-f836ce607bac

> 任务已切换：2026-10-10 19:39 起，本自动化职责由「实盘运行器盯盘」改为「**校准采集器盯盘**」（BTC 5m 定价校准阶段，数据源校准）。
> 采集器 = `tsx src/collect/btc-5m-history.ts`（启动脚本 `bash scripts/collect-run.sh`），输出 `data/btc5m-calib.csv`。
> ⚠️ 绝不再启停实盘运行器 `src/btc-5m-latency-scalp.ts`（已于 2026-10-10 18:53 因护栏停止，是否恢复由用户决定）。

## 校准采集器判读要点（新任务）
- 进程判据：`pgrep -f "tsx src/collect/btc-5m-history.ts"`；实进程 = `node .../tsx/dist/loader... src/collect/btc-5m-history.ts`，外有 `node .bin/tsx` 与 `npm exec` 父进程（均会命中 pgrep，正常）。
- 采集器输出 `data/btc5m-calib.csv`，采样 1 Hz（COLLECT_SAMPLE_MS=1000），duration=0（长期跑）；stdout 落 `/tmp/collect-calib.out`，启动标记行 `=== collect-run launch <时间> ===`。
- 冷启动 ≈90s：launch 行到首条 "Wrote sample" 约 60–95s，期间文件不增长属正常，勿误判。
- 关键：`open_price_chainlink/open_price_rest` **只有**在窗口起点 ±5s 内真采到才写；中途启动的窗口 open 留空（设计如此）。故新起的采集器需跨过一个窗口边界后，open 列才有值。
- basis_bps 定义 = (btc_price_rest / btc_price_chainlink − 1) × 1e4。已知 Chainlink 相对 Binance（rest）约 **−9bps** ⇒ 该式应得 **≈ +9bps**（正号与「cl 偏低」同义，勿看成矛盾）。
- 表头列序（0-based）：…18 btc_source / 19 btc_price_rest / 20 open_price_rest / 21 btc_price_chainlink / 22 open_price_chainlink；注意 1-based 剪取易错一格。
- 判据：文件 mtime 距今 >10min 无新行 或 进程消失 → 异常，用 `bash scripts/collect-run.sh` 后台重启（脚本自带"已在跑则拒绝"）。
- 正常时三行以内简报；实盘运行器若被发现运行，只如实汇报、不干预。

## 运行约定 / 判读要点（供后续复用）
- 进程判据：`pgrep -f "tsx src/btc-5m-latency-scalp"`；实进程为 `node .../node_modules/.bin/tsx src/btc-5m-latency-scalp.ts`，外有 `npm exec` 父进程。
  - 注意：其它 bash/监控命令若命令行里含该关键字也会被 pgrep 命中（排除非 node/npm 的匹配）。
- 记录文件：`REC=$(cat /tmp/live-margin.rec)`，CSV 位于 `data/`。
- 启动慢属正常：`live-run.sh` 启动后从 banner 到 `wallet address`/`Credential created` 可能耗时约 2 分钟（网络/凭证派生延迟），期间无 tick 输出，**不是卡死**，不要据此误判或重启。
- 设计内安全行为：启动晚于 5m 窗口起点 → 该窗口抓不到 ±5s 开盘价（`Open: --`，日志 WARNING "Waiting for Chainlink BTC tick ... this cycle will not trade"）→ 该窗口不交易。
- 停止条件：USDC < $4.85 或连亏 2 笔 → 不重启。
- 已知路径：`order_rejected` 正文含 "no orders found to match"（FAK 未穿价被 kill），同窗连续 ≥3 次才算异常。
- 无成交无异常时：最多两行简报（进程存活、累计行数、当前窗口 BTC margin 与剩余秒数）。

## 历史执行
### 2026-10-09 23:58（首次运行）
- 进程：运行中（tsx PID 20719）。23:58:16 的重启是**用户手动**发起（见 2026-10-09.md）。
- REC = data/live-margin-cl-20261009-235816.csv；检查时全为 decision 行（54 行），无事件行。
- 成交：无。今晚所有 live-margin CSV 均无 order_trade_fill/order_fill/settlement；resolution 行 pnl 全 0（无持仓）。
- 异常：无 order_rejected（今晚 0 次）；无停止信号。早前 224347 有 1 笔 order_posted(DOWN BUY 0.96×5 FAK=$4.80)→12s 后 cancelled（filled_size=0，entry-age 超时正常取消）。
- 余额 $11.095323 ≥ 4.85，未触发停止。
- 结论：正常运行，无成交属正常（信号约 3 笔/天）。

### 2026-10-10 00:58
- 进程：运行中（tsx 实进程 PID 70624，约 00:50:53 启动，为应用 maxEntryPrice 0.96 的重启，见当日日志）。
- REC = data/live-margin-cl-20261010-005021.csv；586 数据行 = 585 decision + 1 resolution（pnl=0，无持仓）。
- 成交：无；order_posted/rejected/skipped/trade_fill/fill/cancelled 全部 0。
- 配置：banner 确认 `max=0.96`（新配置，非 0.97）。余额 $11.095323 ≥ 4.85，无停止信号。
- 新观察（**非新引入**，旧 max=0.97 运行时同样存在）：当窗口内 ask 触及价格带上沿（0.96/0.97）时，final-30-high 的 "blocked:" 分支会置 `state.cancelled=true`，该 5m 窗口剩余时间统一记 `final-30-high already entered` 并不再入场。旧 CSV 亦有（001026:644 行 / 235816:194 行）。影响：max=0.96 下触界更频繁，或压缩信号频率 → 列入观察项，本次未见因此漏掉的有效信号。

### 2026-10-10 03:04
- 进程：存活（tsx PID 18420 / npm 父 17853，STARTED 01:23:20，elapsed≈1h41m）。无重启、无崩溃。
- REC = data/live-margin-cl-20261010-012320.csv；5914 行 = 5895 decision + 19 resolution（pnl 全 0）。**0 订单事件、0 成交、无停止信号。**
- 配置确认：banner 含 `max=0.96` + `entryVel=0bps/10s` + `entryAccel=0bps2/5s` → 门控生效。门控拦截计数=0；`no orders found to match`=0。余额 $11.095323。
- 当前窗口 BTC Δ +7.18bps / Left≈19s；Up ask1.0 Down ask0.01（已知触界 cancelled 分支）。
- 结论：正常等待，无成交无异常。

### 2026-10-10 02:03
- 进程：运行中（tsx 实进程 PID 18420，`npm exec` 父进程 17853，约 01:23 起）。**本次 01:23:21 重启是用户按计划部署"多因子入场门控"（entryVel/entryAccel）的主动重启**，非崩溃（见当日 2026-10-10.md，日志有 `live-run launch … 01:23:21` 标记）。
- REC = data/live-margin-cl-20261010-012320.csv；2236 decision + 7 resolution（resolution 全部 pnl=0，无持仓）。**无任何 order_posted/rejected/skipped/trade_fill/fill/cancelled/settlement 事件；今日 3 个 live CSV 事件行均为 0。**
- 配置确认（关键）：本次启动 banner 含 `max=0.96` + `entryVel=0bps/10s` + `entryAccel=0bps2/5s` → **新门控配置已生效**（上一轮 00:51 的 max=0.96 无门控）。
- 门控拦截：日志中 "entry velocity/acceleration" 计数 = **0**（尚未触发，符合"低 margin 夜晚本就少入场"）。
- 余额 $11.095323 ≥ 4.85；无停止信号（无"余额不足/连亏"）。state_cancelled=true 547 行 = 旧的 "already entered" 分支（已知，非新）。
- 结论：正常运行，无成交无异常（预期 ≈7 笔/天，夜间 margin≥10bps 罕见，属正常等待）。

### 2026-10-10 04:05
- 进程：存活（tsx PID 18420 / npm 父 17853，ELAPSED 02:41:57）。无重启、无崩溃。
- REC = data/live-margin-cl-20261010-012320.csv；9554 数据行 = 9523 decision + 31 resolution（pnl 全 0）。
- 成交/订单事件：0（无 order_posted/rejected/skipped/trade_fill/fill/cancelled/settlement）。无停止信号；余额 $11.095323。
- 配置：banner `max=0.96` + `entryVel=0bps/10s` + `entryAccel=0bps2/5s`，门控生效；门控拦截计数=0，`no orders found to match`=0。
- 当前窗口 BTC Δ +1.56bps / Left≈252s（<10bps 门槛，正常不入场）。
- 结论：正常等待，无成交无异常。注意：自 2026-10-09 运行至今约 29h 零信号，接近"2~3 天无信号视为异常"观察阈值，下轮留意。

### 2026-10-10 05:06
- 进程：存活（tsx PID 18420 / npm 父 17853，ELAPSED 03:42:50）。无重启、无崩溃。
- REC = data/live-margin-cl-20261010-012320.csv；13194 记录 = 13152 decision + 42 resolution（pnl 全 0）。0 订单事件、0 成交、无停止信号。
- 配置：banner `max=0.96` + `entryVel=0bps/10s` + `entryAccel=0bps2/5s`，门控生效；门控拦截=0；`no orders found to match`=0。余额 $11.095323。
- 当前窗口 BTC Δ +0.28bps / Left≈181s。
- 结论：正常等待。实盘累计 ≈34h 零信号，逼近"2~3 天无信号"阈值，下轮留意数据源/过滤器。

### 2026-10-10 08:11
- 进程：存活（tsx PID 18420 / npm 父 17853，01:23 起，elapsed≈6h48m，ppid 未变）。无重启、无崩溃。
- REC = data/live-margin-cl-20261010-012320.csv；24185 行 = 24105 decision + 79 resolution（pnl 全 0）。0 订单事件、0 成交、无停止信号；余额 $11.095323 ≥ 4.85。
- 配置 banner（17:25Z=01:25 本地）含 `max=0.96` + `entryVel=0bps/10s` + `entryAccel=0bps2/5s`；门控拦截=0；`no orders found to match`=0。
- 当前窗口 btc-updown-5m-1791590700：Δ -0.77bps / Left≈192.5s（<10bps 门槛，不入场正常）。
- 结论：正常等待，无成交无异常。门控版零信号 ≈6h48m，实盘序列累计 ≈8h20m，远低于 2~3 天阈值。

### 2026-10-10 09:17
- 进程：存活（tsx PID 18420 / npm 父 17853，01:23 起，ELAPSED 07:53:54 ≈7h54m，ppid 未变）。无重启、无崩溃。
- REC = data/live-margin-cl-20261010-012320.csv；28126 行 = 28033 decision + 93 resolution（pnl 全 0）。0 订单事件、0 成交、无停止信号；余额 $11.095323 ≥ 4.85。
- 配置 banner（17:25Z=01:25 本地）含 `max=0.96` + `entryVel=0bps/10s` + `entryAccel=0bps2/5s`；门控拦截=0；`no orders found to match`=0。
- 当前窗口 BTC Δ -2.33bps / Left≈135s（<10bps 门槛，不入场正常）。
- 结论：正常等待，无成交无异常。门控版零信号 ≈7h54m，实盘序列累计 ≈9h25m，远低于 2~3 天阈值。

### 2026-10-10 07:10
- 进程：存活（tsx PID 18420 / npm 父 17853，01:23 起，elapsed≈5h46m）。无重启。
- REC = data/live-margin-cl-20261010-012320.csv；20530 行 = 20462 decision + 67 resolution（pnl 全 0）。0 订单事件、0 成交、无停止信号；余额 $11.095323。
- 配置 banner（17:25Z=01:25 本地）含 `max=0.96` + `entryVel=0bps/10s` + `entryAccel=0bps2/5s`；门控拦截=0；`no orders found to match`=0。
- 当前窗口 btc-updown-5m-1791587400：Δ -0.07bps / Left≈271s，Up 0.53 / Down 0.48（远低于 10bps 门槛，不入场正常）。
- **更正**：实盘序列最早 CSV=20261009-235227（23:52 本地），零信号累计≈7h18m；此前"29h/34h/35h"为误算。远低于 2~3 天异常阈值。
- 结论：正常等待，无成交无异常。

### 2026-10-10 06:08
- 进程：存活（tsx PID 18420 / npm 父 17853，01:23 起，elapsed ≈4h45m）。无重启、无崩溃。
- REC = data/live-margin-cl-20261010-012320.csv；16829 行 = 16773 decision + 55 resolution（pnl 全 0）。0 订单事件、0 成交、无停止信号。
- 配置 banner `max=0.96` + `entryVel=0bps/10s` + `entryAccel=0bps2/5s`；门控拦截=0；`no orders found to match`=0。余额 $11.095323。
- 当前窗口 btc-updown-5m-1791583500：BTC Δ +6.66bps / Left≈102s，Up ask 0.99/Down ask 0.02（<10bps 门槛，不入场正常）。
- 结论：正常等待。累计 ≈35h 零信号，仍低于"2~3 天"异常阈值，下轮继续留意。
- 提示：`grep -hE "order_*..."` 会命中每个 CSV 的表头行（含 event_role 等字段名）→ 统计事件数时须用 `NR>1` 或 `awk -F, '$1!="row_type"'`，勿把表头误计为事件。

### 2026-10-10 10:27
- 进程：存活（tsx 18420 / npm 17853，01:23 起，ELAPSED 09:03:31≈9h04m）。无重启。
- REC = data/live-margin-cl-20261010-012320.csv；32266 数据行 = 32160 decision + 106 resolution（pnl 全 0）。0 订单事件、0 成交、无停止信号；余额 $11.095323。
- 配置 banner（17:25Z=01:25 本地）含 max=0.96 + entryVel=0bps/10s + entryAccel=0bps2/5s；门控拦截=0；`no orders found to match`=0。今日 5 个 live CSV 事件行全 0。
- 当前窗口 Δ +0.63bps / Left≈152s，Up 0.54/Down 0.47。
- 结论：正常等待，无成交无异常。门控版零信号 ≈9h04m，实盘序列累计≈10h35m，远低于阈值。

### 2026-10-10 11:28
- 进程：存活（tsx 18420 / npm 17853，01:23 起，ELAPSED 10:04:39≈10h05m）。无重启、无崩溃；日志出 tick 正常。
- REC = data/live-margin-cl-20261010-012320.csv；35906 行 = 35787 decision + 119 resolution（pnl 全 0）。0 订单事件、0 成交、无停止信号；余额 $11.095323。
- 配置 banner（17:25Z=01:25 本地）含 max=0.96 + entryVel=0bps/10s + entryAccel=0bps2/5s；门控拦截=0；`no orders found to match`=0。
- 当前窗口 Δ +0.27bps / Left≈75s，Up 0.95 / Down 0.06。
- 结论：正常等待，无成交无异常。门控版零信号 ≈10h05m，实盘序列累计≈11h0m，远低于"2 个完整白天无信号"阈值。

### 2026-10-10 12:30（★ SAMPLING MODE 切换后首次核对）
- **配置已切换为数据采集模式（确认）**：12:13:13 重启（live-run launch 标记行 45616），banner `2026-10-10T04:14:38Z` = `max=0.96, BTC margin day=3bps/night=3bps, entryVel=off, entryAccel=off, dryRun=false`。→ margin 10→3bps、vel/acc 门控已关闭，**非旧配置**。进程：tsx 31808/31810（npm 父 31229），非用户手动、是本次采样部署。
- REC = data/live-margin-cl-20261010-121313.csv；899 行 = 895 decision + 3 resolution（pnl 全 0）。
- **0 订单事件**（order_posted/rejected/skipped/trade_fill/fill/cancelled/settlement 全 0）；0 `no orders found to match`。余额 $11.095323，无停止信号。
- 门控拦截：11× `below 3.00bps`（新 3bps 门槛，正常）+ 1× `ask 1.00 above max 0.96`（已知取消分支）。
- 采样时长 ≈16 分钟，远未到"连续 4h 零订单"异常阈值。当前窗口 1791606600：Δ -0.18bps / Left≈293.5s。
- 判读要点更新：SAMPLING MODE 下 banner 特征为 `margin day=3bps/night=3bps` + `entryVel=off/entryAccel=off`；出现 `10bps` 或 `entryVel=0bps/10s` 即为旧配置，需告警。预期每 1-2h 至少 1 次触发；累计下单尝试 ≥15 笔 → 建议复盘暂停。

### 2026-10-10 13:30（SAMPLING MODE 第 2 次核对）
- 进程：存活（tsx 31808 / npm 父 31229，ELAPSED 01:17:07，即 12:13 采样部署起）。无重启、无崩溃，tick 正常（05:30:35Z=13:30 本地）。
- REC = data/live-margin-cl-20261010-121313.csv；≈4535 数据行 = ≈4520 decision + 15 resolution（pnl 全 0）。**0 订单事件、0 成交、无停止信号。**
- 配置 banner（04:14:38Z）确认 SAMPLING MODE：`max=0.96, shares=5, BTC margin day=3bps/night=3bps, entryVel=off, entryAccel=off, dryRun=false`。**非旧配置。**
- 门控（正常）：CSV decision_reason 中 `below 3.00bps` 累计 103 条（12:00/13:00 两时段）+ `already entered` 1378 + `outside entry window` 2706。日志 stdout 不含 block 文案，**统计门控须查 CSV 的 decision_reason，勿 grep 日志**（更正 12:30 记录的“11× below 3bps 在日志”）。`no orders found to match`=0。
- 非采样噪声：日志有 1 次 WebSocket 断连（04:43 "1013 slow consumer"）+ 数条 Chainlink stale，均自愈，不影响运行。
- 余额 $11.095323 ≥ 4.85。当前窗口 Δ +0.73bps / Left≈264s（<3bps，门控拦截属正常）。
- 结论：正常等待，无成交无异常。采样时长 ≈1h17m（12:13→13:30），远未到“连续 4h 零订单”异常阈值（约 16:13 起才需告警）。

### 2026-10-10 14:31（SAMPLING MODE 第 3 次核对 —— ★ 首笔实盘成交，盈利）
- 进程：存活（tsx 31808 / npm 31229，12:13 采样部署起，ELAPSED 02:18:13）。无重启。
- REC = data/live-margin-cl-20261010-121313.csv；≈8171 数据行 = 8146 decision + 28 resolution + 1 order_posted + 1 order_trade_fill。
- **首笔订单事件（详细）**：slug btc-updown-5m-1791612000，14:03:21.85Z order_posted `DOWN BUY entry` 限价 0.97 / $4.85 / FAK / order_id 0x5def66…；14:03:22.39Z order_trade_fill 成交价 **0.95**（价格带内按 ask 成交，无负滑点）、5.105260 股、notional $4.849997、source=trades-api、fill_latency≈1947ms；14:07:02Z settlement winning=**DOWN → pnl +$0.255263**（payout 5.105260 − cost 4.849997）。
- 采样模式触发间隔：12:13→14:03 ≈1h50m，符合“每 1-2h 至少 1 次”预期，非 4h 零事件异常。
- 累计 order_posted=1 / 成交=1（未达 ≥15 采样目标）；无连亏、无停止信号（settlement pnl +0.255 > −2.5，余额 ≈11.1 ≥ 4.85）。
- 配置 banner（04:14:38Z）确认 SAMPLING MODE：`max=0.96, shares=5, BTC margin day=3bps/night=3bps, entryVel=off, entryAccel=off, dryRun=false`。门控 `below 3.00bps` 等属正常；`no orders found to match`=0。
- 判读要点更新：首笔 FAK 成交按 ask 价（价格带下沿）成交，说明穿价缓冲有效、无误拒；采样模式下需继续累计至 ≥15 笔再复盘成交率。

### 2026-10-10 15:33（SAMPLING MODE 第 4 次核对 —— ★ 第 2 笔成交，盈利）
- 进程：存活（tsx 31808 / npm 31229，12:13 采样部署起，ELAPSED≈3h20m）。无重启、无崩溃，tick 正常（07:33:41Z）。
- REC = data/live-margin-cl-20261010-121313.csv；11834 行 = 11811 decision + 40 resolution + 2 order_posted + 2 order_trade_fill。
- **新增第 2 笔（详细）**：slug btc-updown-5m-1791614700，14:48:16.93Z order_posted DOWN BUY 限价 0.97 / 5 股 / $4.85 / FAK / oid 0xd32993f1；14:48:17.47Z order_trade_fill 成交价 **0.97**（=限价，缓冲吃满；价格带下沿 0.95 → 多付 $0.02/股）、5.000000 股、notional $4.850000、source=trades-api、fill_latency **1493ms**；14:52:02Z settlement winning=**DOWN** → **pnl +$0.15**。
- 累计：order_posted=2 / 成交=2 / settlement 累计 pnl **+$0.405263**；无 rejected/cancelled/skipped；`no orders found to match`=0；`below 3.00bps`=233（正常）；余额 $11.095323。
- 无停止条件（无连亏；pnl 为正；余额 ≥4.85）；2 < 15 未达采样目标。
- 采样间隔 14:03→14:48 ≈45min（远低于 4h 阈值）。当前窗口 1791617400：Δ +0.22bps / Left≈78s。
- 配置 banner（04:14:38Z）仍为采样模式 `max=0.96 + margin 3bps + entryVel=off/entryAccel=off + dryRun=false`。
- 新判读：两笔成交价分别落在价格带两端（0.95 / 0.97），FAK 成交价随 taker 对手盘浮动；记录可供成交率+滑点分布复盘。
- 注意：`grep "10bps"` 会命中 tick 行里的 `+0.10bps` 之类，判定旧配置须只看 banner 行。

### 2026-10-10 16:34（SAMPLING MODE 第 5 次核对 —— ★★ 首次亏损，触发停止条件）
- 进程：存活（tsx 31808 / npm 31229，12:13 起，ELAPSED 04:21）。无重启、无崩溃，tick 正常（08:35Z）。**进程仍在运行 —— 本停止条件不会让 bot 自停，需人工介入。**
- REC = data/live-margin-cl-20261010-121313.csv；15496 数据行 = 15448 decision + 52 resolution + 5 order_posted + 5 order_trade_fill。无 rejected/cancelled/skipped；`no orders found to match`=0。
- 配置 banner（04:14:38Z）确认 SAMPLING MODE：`max=0.96, shares=5, margin 3bps, entryVel=off, entryAccel=off, dryRun=false`。**非旧配置。**
- **订单事件 5 笔（较上轮 +3，全为 posted→filled）**：
  1. 06:03Z DOWN @0.95 / 5.105260 股 / $4.849997 / lat 1947ms → DOWN 胜 +$0.255
  2. 06:48Z DOWN @0.97 / 5.000000 股 / $4.85 / lat 1493ms → DOWN 胜 +$0.15
  3. 07:43Z UP @0.96 / 5.052075 股 / $4.849992 / lat 1357ms → UP 胜 +$0.202
  4. 07:48Z UP @0.96 / 5.052075 股 / $4.849992 / lat 1491ms → UP 胜 +$0.202
  5. **08:23Z DOWN @0.96 / 5.052075 股 / $4.849992 / lat 2599ms → UP 胜，DOWN 亏 −$4.849992**（slug 1791620400）
- **累计 settlement pnl = −$4.040563**（4 胜 +$0.809 / 1 亏 −$4.85）。
- **⚠️ 达到停止条件：settlement 累计 pnl −$4.04 < −$2.5。** 本轮**未重启**（无崩溃，且进程仍运行）；按 playbook「停止条件」分支仅汇报、不动作（停止条件的设计作用是 gate 自动重启，非令 bot 自停）。已强烈建议人工停。
- 其余停止条件未触发：连亏仅 1 笔（前有胜），余额估算 ≈$7.05（=启动 11.0953 − 4.04）≥ $4.85。
- 采样目标：下单尝试 5 < 15，未达。门控正常（`outside entry window` 9237 / `already entered` 4013 / `waiting for probability` 1375 / `below 3.00bps` 若干）。交易间隔 45min~5min，远低于 4h 阈值。
- **策略风险量化（重要）**：买 0.96 的 favorite，5 股 → 赢 +$0.20 / 亏 −$4.85，**1 次亏损 ≈ 吞掉 24 次盈利**；本次单笔 −$4.85 ≈「单笔期望成本 −$0.06」的 80 倍，属尾部风险兑现。强烈建议暂停并复盘赔率结构。

### 2026-10-10 17:37（SAMPLING MODE 第 6 次核对 —— ★ 停止条件持续，无新订单）
- 进程：存活（tsx 31808 / npm 父 31229，12:13 采样部署起，ELAPSED≈5h24m）。无重启、无崩溃，tick 正常（09:37:06Z）。
- REC = data/live-margin-cl-20261010-121313.csv；19181 行 = 19106 decision + 64 resolution + 5 order_posted + 5 order_trade_fill。**较上轮（16:34）无新订单事件、无新成交**；最后订单事件停在 08:23:02.738Z（16:23 本地），已 ≈1h14m 无新订单（<4h 阈值）。
- 累计 settlement pnl = **−$4.040563**（5 笔：4 胜 +$0.809 / 1 亏 −$4.85）。
- **⚠️ 停止条件持续满足：settlement 累计 pnl −$4.04 < −$2.5。** 未重启（无崩溃）；按 playbook 仅汇报、不动作，建议人工停。
- 其余停止条件未触发：连亏 1 笔（前 4 胜）；余额估算 ≈$7.055（=11.0953−4.0406）≥ $4.85。
- 采样目标：下单尝试 5 < 15 未达。门控 `no orders found to match`=0；无 rejected/cancelled/skipped。
- 配置 banner（04:14:38Z）确认 SAMPLING MODE：`max=0.96, shares=5, margin day=3bps/night=3bps, entryVel=off, entryAccel=off, dryRun=false`。**非旧配置。**
- 当前窗口 Δ +3.68bps / Left≈174s。

### 2026-10-10 18:38（SAMPLING MODE 第 7 次核对 —— ★ 停止条件持续，仍无新订单）
- 进程：存活（tsx PID 31808 / npm 父 31229，12:13 采样部署起，ELAPSED 06:24:25≈6h24m）。无重启、无崩溃，tick 正常（10:38:23Z）。
- REC = data/live-margin-cl-20261010-121313.csv；22832 行 = 22831 数据行（22744 decision + 77 resolution + 5 order_posted + 5 order_trade_fill）。**较上轮（17:37）无新订单事件**；最后订单事件仍停在 08:23:02.738Z（16:23 本地），已 ≈2h15m 无新订单（< 4h 阈值，未达异常）。
- 累计 settlement pnl = **−$4.040563**（5 笔：4 胜 +$0.809 / 1 亏 −$4.85，明细见 16:34 记录）。
- **⚠️ 停止条件持续满足：settlement 累计 pnl −$4.04 < −$2.5。** 未重启（无崩溃）；按 playbook 仅汇报、不动作，强烈建议人工停。
- 其余停止条件未触发：连亏 1 笔（前 4 胜）；余额估算 ≈$7.055（=11.0953−4.0406）≥ $4.85（未低于门槛）。
- 采样目标：order_posted=5 < 15 未达。门控 `no orders found to match`=0；无 rejected/cancelled/skipped。
- 配置 banner（04:14:38Z）确认 SAMPLING MODE：`max=0.96, shares=5, margin day=3bps/night=3bps, entryVel=off, entryAccel=off, dryRun=false`。**非旧配置。**
- 噪声：WebSocket 多次 1013 slow consumer / 1006 断连（08:46/09:37/09:42/10:06/10:36/10:38Z），均自愈，tick 未中断；1 次 Chainlink stale。不影响运行。
- 当前窗口 btc-updown-5m-1791628500：Δ +0.45bps / Left≈96s，Up 0.73 / Down 0.28。

### 2026-10-10 22:40（★ 任务再切回：实盘 095-tp099 盯盘 —— 进程已死）
- 任务再次切换（本轮 query 指定盯 **实盘运行器 095-tp099**，非校准采集器）。启动脚本 = `scripts/strat-095-tp099.sh live`（TP099=0 BUF099=0 DRY_RUN=false；exec npx tsx … >> /tmp/live-095tp099.out）。
- **进程：已死**（`ps aux|grep btc-5m-latency-scalp` = 空）。/tmp/live-095tp099.out 最后写 22:20:01，末行 `Cycle ready: btc-updown-5m-1791642000`，**无 ERROR/FATAL/shutdown/SIG**，无 node crash report → 外部停止（用户 22:20 手动停，见 2026-10-10.md）；非崩溃。
- REC=data/live-095tp099-20261010-213504.csv（21:35:04 启动）：2506 decision / **7 order_posted / 5 order_rejected / 7 order_trade_fill / 7 resolution**。
- 汇总：成交 7 笔；settlement 累计 pnl **+$1.496374**（6 胜 0 亏）；fill_latency 中位 **2016ms**；滑点 0/0/0/−2¢/0/−1¢/0（无不利滑点）。余额 **$12.971526**（启动 11.340922→+1.63）、OPEN ORDERS 0。
- 停止条件：**仅"进程已死"命中**（pnl/连亏/余额均未触发）→ 只汇报、不重启，建议由用户决定。
- 异常：结算检测 22:12:03Z 后停摆（最后 resolved=1791641100），1791641400/1791641700 无 settlement 行。

### 2026-10-10 19:39（校准采集器首检）
- 进程：采集器存活（tsx 实进程 59112 / node .bin 59106 / npm 父 58369），launch 标记 19:34:21，**已在运行，本轮未重启**。
- 数据：`data/btc5m-calib.csv` 在增长（mtime=现在）。251 数据行（全 sample 行）/ 1 个窗口（btc-updown-5m-1791632100）；`open_price_chainlink` 非空 = **0 行**（本窗口在冷启动后才开盘，符合设计，下个窗口起应有值）。
- 基差（n=251）：mean **+9.27bps** / median **+9.25** / p10 +9.18 / p90 +9.31 → 与已知「Chainlink 相对 Binance −9bps」方向/量级一致。
- 量级比：仅 1 窗口可算，ratio **1.005**（cl_move 6.67bps / rest_move 6.64bps）——样本不足，阈值是否重标定待多窗口累积。
- 实盘运行器 `src/btc-5m-latency-scalp.ts`：**未运行**（符合 18:53 护栏停止），未干预。
- 结论：采集器正常、数据在增长。

### 2026-10-11 11:11（★ 任务再切：实盘 B0+绝对止损0.50 盯盘 —— 运行中，首小时 6 成交全胜）
- 任务再次切换：本轮盯 **实盘运行器 B0 基线 + 绝对止损 0.50、share 制**（启动 `MAXP=0.96 BUF=0.01 BUYSHARES=true STOP=0.50 DRY_RUN=false bash scripts/strat-b0.sh live`）。
- 进程：存活（tsx PID 28507 + 实进程 28512，10:45:09 起，elapsed≈26min）。**无重启/崩溃**。10:41:11 曾启动一次，10:45:09 被重启（guard 两段 start）。
- REC=`data/live-b0-20261011-104509.csv`（1542 行 = 1525 decision + 6 order_posted + 6 order_trade_fill + 4 resolution）。**0 order_rejected / 0 cancelled**；`no orders found to match`=0。
- 护栏 `/tmp/guard-live.log`：`guard start 10:45:23 rec=…104509 maxFills=40 maxLoss=$6.0 maxConsec=3`；**无 `STOP=` 行 → 未杀进程**。
- 配置横幅：`max=0.96, shares=5, BTC margin day=0bps/night=0bps, entryMaxAge=12s, takeProfitDelta=0, stopLossDelta=0, stopLossPrice=0.5, btcReversal=-999bps/0s, entryVel=off, entryAccel=off, dryRun=false` → 绝对止损 0.50 生效、无止盈、纯 share 制（名义 5 股 ≈ $4.80 spend，实际股数=spend/fillPrice）。
- **止损：0 次**（`grep "stop loss"`=0；6 笔 fill 的 event_role 全 = entry）。decision_reason 出现 `final-30-managed holding tp=off stop=0.50`（持仓中未破止损）。
- 成交（6 笔，全 DOWN BUY）：价 0.96×1 / 0.95×3 / 0.93×2；**无 <0.50 崩盘成交**。fill_latency：1742/1747/2069/2241/2703/2853 → **中位 2155ms**。
- 结算 4 笔全胜（win=DOWN）：+0.20/+0.2526/+0.3613/+0.2526 = **累计 +$1.0666**；亏损 0 笔（平均亏损 N/A）。另有 2 个窗口（1791687900/1791688200）持仓未结。
- 余额 **$7.278942** ≥ $4.85；**OPEN ORDERS 0**。启动余额 11.099699（10:45）。注：余额降幅（−3.82）> 本 REC 已实现 pnl（+1.07），差额≈持仓占用 + 旧实例遗留仓位结算。
- **停止条件：一条未触发**（pnl/连亏/成交数/余额/进程）。
- 判读要点/风险：① 成交速率 ≈14 笔/h → 按此节奏 `maxFills=40` 约 **2.7h**（≈13:30 本地）触顶，留意；② 胜率 4/4=100%（样本极小）、止损率 0/6=0%（基线 7.4%）——量级正常不异常；③ 1 次 WS `1013 slow consumer` ERROR（02:45:36Z）自愈；④ 护栏 pnl/fills 滞后 ~1min。⑤ 列号复核：$33=event_role, $36=price, $38=event_cost, $39=event_notional, $44=filled_size, $46=latency, $48=winning, $49=entry_cost, $51=payout, $52=pnl。

### 2026-10-11 12:12（B0+止损0.50 第 2 次核对 —— 运行正常，16 成交全胜，无止损）
- 进程：存活（tsx 28507 / 28512，10:45:09 起，elapsed 1h27m）。无重启/崩溃。护栏无 `STOP=`（未杀）。
- REC=`data/live-b0-20261011-104509.csv`：5150 decision + 16 order_posted + 16 order_trade_fill + 1 order_rejected + 16 resolution。护栏最新 `fills=16 pnl=4.0079 consec=0`。
- **止损 0 次**：`grep "stop loss"`=0；16 笔 fill 的 event_role **全=entry**，无非 entry 卖出。止损率 0/16=0%（基线 7.4%）。
- 成交价：0.96×1 / 0.95×12 / 0.94×1 / 0.93×2；**无 <0.50**；股数 5.0~5.161285（share 制，名义≈$4.80）。latency 中位 **2026ms**（1692–2853）。
- 结算 16 行 = **15 胜 0 负 + 1 空仓(pnl0)**；累计 **pnl +$4.007905**；亏损笔 0。
- 余额 **$15.078125**；OPEN ORDERS 0。（较 11:11 的 $7.279 大幅上升 +$7.80，>本轮 pnl，疑锁定抵押释放/外部资金，非停止条件，建议留意。）
- **停止条件全部未触发**（pnl/连亏/成交数/余额/进程）。1 次 FAK 拒单 `taker_no_match`（12:01:43 本地）+ 9 次 WS 1006/1013 断连，均自愈。
- 提醒：成交 ≈11 笔/h → `maxFills=40` 约 **14:2x 本地触顶**，届时可能被护栏停。
- 报告文件：`live-b0-monitor-20261011-1212.md`。

### 2026-10-11 13:14（B0+止损0.50 第 3 次核对 —— 正常，28 成交全胜、零止损）
- 进程：存活（tsx 28507 / 28512，10:45:09 起，ELAPSED 02:29:48）。无重启/崩溃。护栏无 `STOP=`（未杀）。
- REC=`data/live-b0-20261011-104509.csv`：8810 decision + 28 order_posted + 28 order_trade_fill + 1 order_rejected + 28 resolution。护栏最新 `13:13:43 fills=28 pnl=7.1677 consec=0`。
- **止损 0 次**：`grep "stop loss"`（out/REC）均=0；28 笔 fill 的 event_role 全=entry，无非 entry 卖出。止损率 0/28=0%（基线 7.4%）。
- 成交价：0.93×6 / 0.94×3 / 0.95×17 / 0.96×2；**无 <0.50 崩盘成交**（min 0.93）；股数 5.0~5.161291。latency 中位 **1983ms**（1667–2853）。腿分布 DOWN 15 / UP 13。
- 结算 28 行 = **26 胜 0 负 + 2 空仓(pnl0)**；累计 **pnl +$7.167669**；亏损笔 0，平均亏损 N/A。胜率 26/26=100%（含空仓口径 92.86%）——高于基线 92.38%，非异常。
- 余额 **$13.205635**；OPEN ORDERS 0。（较 12:12 $15.078 回落，属在场仓位锁定抵押所致的可用快照波动，非亏损。）
- **停止条件全部未触发**（pnl/连亏/成交数/余额/进程）。1 次 FAK 拒单 `taker_no_match`（04:01:43Z）+ 13 次 WS 1006/1013 断连，均自愈。
- 报告文件：`live-b0-monitor-20261011-1314.md`。
- 提醒：`maxFills=40` 临近（现 28，约 11 笔/h → 约 14:18 本地触顶，届时护栏可能自动停）。

### 2026-10-11 14:18（B0+止损0.50 第 4 次核对 —— ★ 首次止损触发，已被 0.89 有利成交化解）
- 进程：存活（tsx 28507 / 28512，10:45:09 起，uptime 03:33:12）。无重启/崩溃。护栏无 `STOP=`。
- REC=`data/live-b0-20261011-104509.csv`：12540 decision + 39 order_posted + 38 order_trade_fill + 5 order_rejected + 41 resolution（另 order_cancelled/fill_during_cancel/trade_correction 各 1，均属同一次止损）。护栏 `14:17:57 fills=38 pnl=9.7038 consec=0`。
- **★ 止损 1 次**（首次）：slug `1791697800`，13:54 本地。BTC 仅 +0.83bps 微摆 → DOWN 报价瞬崩到 ask 0.01–0.04 → `bid≤0.50` 命中（btcReversal=-999 旁路 BTC 确认、确认 0s）。risk-exit SELL 先两次 `taker_no_match` 被拒（限价 0.12/0.02），第 3 次限价 0.37 却因 4s 内市场回升，**FAK 按更优价 0.89 成交** → 损失仅 **−$0.2063**（远优于预期 −$2.3/−$4.8）。该窗 `winning=DOWN`，若持有反 +$0.361 → **误杀，净代价 ≈−$0.57**；BTC margin <1bp 属噪音窗。止损率 1/38=2.6%（基线 7.4%）。
- **列号更正（重要）**：止损卖出**不写进 `order_trade_fill`**（那 38 行 event_role 全=entry）。卖出被记为 `order_posted(role=risk-exit)` + `order_fill_during_cancel` + `order_trade_correction`（后者 `$36` 才是真实成交价 0.89）。**仅按"order_trade_fill 中 event_role≠entry"统计止损会漏计**，须同时看上述三类行 / `grep "stop loss"`($REC)。
- **`grep "stop loss"` 只在 $REC 命中（5 行 decision_reason），stdout `/tmp/live-b0.out` = 0**。
- 成交：38 笔全 entry；价 0.95×24 / 0.93×7 / 0.94×5 / 0.96×2（**无 <0.50**）；股数 5.0–5.161291；latency 中位 **1978ms**；腿 DOWN 22/UP 16。
- 结算 41 行 = **36 胜 / 1 亏 / 4 零**；累计 **pnl +$9.703832**；平均亏损 −$0.206310；胜率 36/37=97.3%（>基线 92.38%）。
- 余额 **$20.323773**，OPEN ORDERS 0（=启动 11.0997+9.70 ✓）。**此前 12:12 $15.08 / 13:14 $13.21 的跳变确认是持仓锁定抵押所致，非异常，已消解。**
- ⚠️ **成交 38/40 逼近停止条件（任务阈值≥40 & 护栏 maxFills=40）**，约 20–30min 内护栏会自动停。**停止条件无一命中**（pnl/连亏/余额/进程均 OK）。
- 数据缺口：slug `1791690900` 有成交但**无 resolution 行**（漏结算 1 处）。
- 噪声：WS 1006/1013 累计 228 条，自愈。
- 报告文件：`live-b0-monitor-20261011-1416.md`。
- 建议：实盘样本够后单列统计"止损后该腿最终是否获胜"（误杀率），以评估 0.50 绝对止损在噪音窗的代价。

### 2026-10-11 15:19（B0+止损0.50 第 5 次核对 —— ★ 上一实例被护栏停(40笔)，新实例无护栏，止损率飙至 25%）
- **进程：存活但是新实例**。tsx PID 87277 / 子 87313，启动 **14:37:34**，elapsed≈42min。**上一实例 PID 28507 已于 14:24 被护栏杀死**。
- **护栏 `/tmp/guard-live.log` 末尾命中停止条件**：`14:24:14 STOP=TRADE_CAP fills=40 pnl=9.9565 consec=0` → `14:24:16 runner killed`。**即「成交≥40 笔」停止条件在上实例已命中**，护栏随后退出（当前 `pgrep guard` = 无）→ **当前实例无守护，不会自动停**。
- REC=`data/live-b0-20261011-143734.csv`（2521 行）：2477 decision + 11 order_skipped + 10 order_posted(8 entry+2 risk-exit) + 8 resolution + 8 order_trade_fill(全 entry) + 2 order_trade_correction + 2 order_fill_during_cancel + 2 order_cancelled + **0 order_rejected**。
- **★ 止损 2 次 / 成交 8 笔 = 25%**（基线 7.4%，**明显偏高**）：
  1. `1791702600` 15:14 触发，DOWN 卖 5.05，**实际成交价 0.86**（限价 0.41，回升成交）→ settled **−$0.4544**；该窗 winning=DOWN → **误杀**（持有本应+0.25）。
  2. `1791702900` 15:19 触发（本轮检查时正在发生），DOWN 卖 5.05，**实际成交价 0.10**（限价 0.03）→ **未结算**，估 **≈−$4.29**（跳空）。
- `grep "stop loss" /tmp/live-b0.out`=**0**；$REC=11（仅 decision_reason）。`order_trade_fill` 中 role≠entry=**0** → **止损卖出仍不写入 order_trade_fill**，记在 order_posted(risk-exit)+fill_during_cancel+**trade_correction($36=真实价)**。此判读要点已二次确认。
- 成交 8 笔（DOWN4/UP4）；价 0.95×7 + 0.96×1（**无<0.50**）；股数 5.0–5.0526；latency 中位 **2096.5ms**（1582–3697）。
- 结算 8 行 = 6 胜 + 1 空仓 + 1 亏；**累计 pnl +$1.008786**；平均亏损 −$0.4544。胜率实现 85.7%（<基线92.38%），但**标的腿命中 7/7=100%（两次止损皆误杀赢腿）**。
- 余额 **$17.301292**，OPEN ORDERS 0（较 14:18 的 $20.32 降≈$3，即 1791702900 pending 止损）。**停止条件（当前实例）全部未命中**（含 pending 后 pnl≈−$3.28，接近 −$6 未破）。
- 报告文件：**`live-b0-monitor-20261011-1519.md`**。
- 判读要点新增：护栏 counter 为**按实例重置**；新实例由用户手动启、**不带 guard** → 盯盘时须显式检查 `pgrep guard`，无 guard 时"自动停"保护失效，需人工盯停止条件。

### 2026-10-11 16:22（B0+止损0.50 第 6 次核对 —— ★ 新实例 SHARES=10、零止损全胜、无护栏）
- **进程：存活但为 15:36:39 新实例**（tsx PID 59708 / 子 59713，ELAPSED 46m）。上一实例 14:37:34 已停（REC 最后写 15:30，无 ERROR/崩溃行，停因未确认，疑为用户改股数重启）。
- REC=`data/live-b0-20261011-153639.csv`（2742 行）：2717 decision + 8 order_posted + 8 order_trade_fill + 9 resolution。**0 rejected / 0 cancelled。**
- **★ 配置变更（重要）：本实例 banner = `SHARES=10`**（launch 行 `… MAXP=0.96 BUF=0.01 SHARES=10`；strategy banner `shares=10`）。任务口径为 5 股 → 单笔风险翻倍。5 股跳空止损 ≈−$4.3，10 股则 ≈−$9.6，**单笔即击穿 −$6 累计亏损线**。已提示确认是否有意。
- **★ 无护栏**：`pgrep guard` 无命中（仅 DLP iOALog guard，无关）。guard-live.log 末行 = 14:24:14 `STOP=TRADE_CAP fills=40` → `runner killed`。本实例不带 guard，自动停失效，须人工盯。
- **止损 0 次**（`grep "stop loss"` out/REC 均=0；8 笔 fill role 全=entry）。止损率 0/8=0%；持仓 holding tp=off stop=0.50 共 774 decision 行（未触发）。
- 成交 8 笔：价 0.92×2 / 0.94×2 / 0.95×4（**无<0.50**）；股数 10.08–10.43；latency 中位 **2296.5ms**（1816–2775）；腿 DOWN3/UP5。
- 结算 9 行 = **8 胜 + 1 空仓**；**累计 pnl +$4.914963**；0 亏损。胜率 8/8=100%（>基线92.38%）。
- 余额 **$22.344421**，OPEN ORDERS 0。**停止条件全部未命中**（pnl/连亏/成交数/余额/进程）。
- 今日 b0 合计：成交≈103 笔、止损触发 3 次（104509×1 + 143734×2 + 当前×0）≈2.9%（<10% 基线 7.4%）。
- **判读要点更正**：`order_trade_correction` **不等于止损**（002255 的 6 条 correction 实为 entry 价格校正）；判定止损须用 `order_posted` role=`risk-exit` 或 `grep "stop loss"`。
- 上一实例 14:37:34 最终结算：10 fills / 2 止损 / **pnl −$3.031**（含跳空止损 1791702900 = −$4.292）。
- 报告文件：`live-b0-monitor-20261011-1622.md`。

### 2026-10-11 17:25（B0+止损0.50 第 7 次核对 —— 同一实例续跑、零止损全胜、无护栏）
- 进程：存活，**仍为 15:36:39 实例**（tsx 59708 / 子 59713，ELAPSED≈1h49m）。无重启/崩溃，tick 正常（09:25Z）。
- REC=`data/live-b0-20261011-153639.csv`（6445 行）：6390 decision + 16 order_posted + 1 order_rejected + 16 order_trade_fill + 21 resolution。无 skipped/cancelled。
- **止损 0 次**（`grep "stop loss"` out/REC 均=0；16 笔 fill role 全=entry；无 risk-exit 行）。止损率 0/16=0%。
- 成交 16 笔：价 0.92×2/0.93×1/0.94×4/0.95×9（**无<0.50**）；股数 10.0–10.434775；latency 中位 **2208.5ms**（1653–3514）；腿 UP10/DOWN6。
- 结算 21 行 = **15 胜 / 0 亏 / 6 空仓**；**累计 pnl +$8.776625**；0 亏损。1 笔（slug 1791710655601，17:24）待结。
- 余额 **$16.310453**、OPEN ORDERS 0。**停止条件一条未命中**（pnl/连亏/成交数/余额/进程）。
- ⚠️ **配置偏差持续：本实例 banner `SHARES=10`**（任务口径 5 股）→ 单跳空止损≈−$9.6，单笔即破 −$6 线。
- ⚠️ **无护栏**（pgrep guard 仅 DLP）；guard-live.log 末行仍为 14:24:14 `STOP=TRADE_CAP fills=40` → 本实例自动停失效。
- **今日 b0 全体**：fills 111 / 止损窗口 4 / pnl +$13.90；止损率 ≈3.6%（<10%）。100134 那次止损失败（risk-exit 被 skip ×5）→ 全额亏 −$4.80。
- 报告文件：`live-b0-monitor-20261011-1725.md`。
