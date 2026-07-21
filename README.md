
# Polymarket Arbitrage Trading Bot

Trading bot for Polymarket's "Up or Down" markets. It runs on 15-minute windows (Bitcoin, Ethereum, Solana, XRP) and uses a price prediction algorithm to place limit orders when it thinks it's got an edge. No Redis, no MongoDB — everything's stored in JSON files and plain text logs.

<p align="center">
  <img src="docs/poly-claw.png" alt="POLYCLAW project banner featuring logos for Polymarket, Base, Claude, Privy, and Clanker." width="700" />
</p>
## How it works

The core idea: the bot predicts whether the UP token price will move up or down, and only trades when it's confident enough (usually 50%+). When that happens, it slaps down a limit buy order at the best ask price (plus a small buffer so it actually fills).

Earnings come from getting predictions right — buying the winning side before the crowd — and holding through to resolution. You can lock in profits anytime by selling on Polymarket, or let the bot auto-redeem winning positions after markets resolve (there's a separate `auto-redeem.ts` script for that).

The predictor looks at price history, momentum, volatility, and trends. It adapts over time and tracks accuracy at each 15-minute boundary. If it's wrong a lot, it'll back off.

Example of a typical run:
- Predicts UP with 65% confidence
- Places limit buy: 5 shares @ 0.53
- Market resolves UP → correct

## What you get

- **Multi-market** — Run `btc`, `eth`, `sol`, `xrp` (or any combo) at once. Each market has its own predictor.
- **15-minute cycles** — Switches automatically at 0m, 15m, 30m, 45m. No babysitting.
- **Live prices** — WebSocket feeds, debounced so it's not spamming on every tick.
- **Accuracy tracking** — Summaries after each quarter-hour: how many predictions, correct vs wrong, costs, accuracy %.
- **Risk controls** — Max buy counts per side, minimum balance checks, market pausing when you hit limits.
- **Lightweight** — State in `src/data/copytrade-state.json`, logs to files. That's it.
- **Auto redeem** — Separate script to cash out winning positions after resolution.
- **Auto approve** — Sets up USDC allowance to Polymarket on startup.
- **Credentials** — Give it your `WALLET_PRIVATE_KEY` and it derives the CLOB API key. No manual key setup.

## Screenshots

Polymarket UI — market view, positions, selling:

![Polymarket UI](docs/polymarket-ui.png)

Bot console — buys, WebSocket updates:

![Bot console](docs/bot-console.png)

Auto redeem flow:

![Auto redeem](docs/auto-redeem-console.png)

## How to Install

```bash
git clone https://github.com/sysnexus1/polymarket-arbitrage-bot.git
cd polymarket-arbitrage-bot
npm install
npm run dev
```

## Environment variables

Stick these in a `.env` file. Here's what matters:

**Market selection**
- `COPYTRADE_MARKETS` — Comma list: `btc`, `eth`, `sol`, `xrp` or mix like `btc,eth,sol`. Default: `btc`.

**Trading**
- `COPYTRADE_SHARES` — Shares per order (e.g. `5`)
- `COPYTRADE_PRICE_BUFFER` — Cents to add above best ask so orders fill (e.g. `0.01`). Default: `0`
- `COPYTRADE_TICK_SIZE` — Usually `0.01`
- `COPYTRADE_MAX_BUY_COUNTS_PER_SIDE` — Cap buys per side per market. `0` = no limit
- `COPYTRADE_FIRE_AND_FORGET` — Skip waiting for order confirm (faster). Default: `true`

**Credentials (required)**
- `WALLET_PRIVATE_KEY` — Your wallet's private key. The bot uses it to derive the Polymarket API key — you don't need to create one in their UI. Get it from MetaMask (Account details → Export). Don't share it.
- `SIG_TYPE` — `eoa` (default), `proxy`, or `gnosis` for Safe
- `PROXY_WALLET_ADDRESS` — If using proxy/Safe, the contract address

You don't set `POLY_API_KEY`, `POLY_PASSPHRASE`, etc. — the bot handles that.

**Bot behavior**
- `BOT_MIN_USDC_BALANCE` — Won't start below this (default: `1`)
- `BOT_MIN_RUN_BALANCE_USDC` — Stops if balance drops below (default: `50`)
- `COPYTRADE_WAIT_FOR_NEXT_MARKET_START` — Wait for next 15m boundary before trading. Default: `false`

**Optional**
- `CLOB_API_URL` — Leave default: `https://clob.polymarket.com`
- `CHAIN_ID` — 137 for Polygon
- `DEBUG` — Verbose logs
- `LOG_FILE_PATH`, `LOG_DIR`, `LOG_FILE_PREFIX` — Where logs go

Full list is in `.env.example`. For BTC 5m scripts, config is split into:
- `BTC5M_*` — common live settings shared by all BTC 5m strategies, such as market, interval, tick size, cancel timing, and BTC price refresh.
- `EDGE_*`, `HYBRID_*`, `RANGE_ARB_*`, `MM_*` — strategy-specific settings. Strategy-prefixed common vars still work as overrides, e.g. `EDGE_INTERVAL_MINUTES` overrides `BTC5M_INTERVAL_MINUTES` only for `btc5m:edge`.
- `BACKTEST_*`, `COLLECT_*` — research-only settings for local backtests and history collection.

## Switching markets

Supported: `btc`, `eth`, `sol`, `xrp`. Just change `COPYTRADE_MARKETS` in `.env` and restart. The bot builds the 15-minute market slugs itself — you don't need token IDs or market URLs.

## Setup & run

After [install](#install), from the project root:

```bash
npm start
```

First run:
1. Copy `.env.example` to `.env`
2. Add your `WALLET_PRIVATE_KEY`
3. Set `COPYTRADE_MARKETS` (e.g. `btc` or `btc,eth,sol`)
4. Tweak `COPYTRADE_SHARES` and other params
5. Run it — it'll create credentials, approve USDC, and start trading

Auto-redeem:
```bash
npm run redeem:holdings
# or
ts-node src/auto-redeem.ts
ts-node src/auto-redeem.ts --api    # fetch from API
ts-node src/auto-redeem.ts --dry-run
```

BTC 5m market maker:
```bash
npm run btc5m:market-maker
```

The market-maker strategy is a dynamic version of the fixed-price `btc5m:range-arb` idea. It continuously quotes both UP and DOWN bids around a fair price, only keeps the paired bid cost below `1 - MM_MIN_LOCKED_EDGE`, and skews quotes away from whichever side has too much inventory.

Useful `.env` knobs:
- `MM_DRY_RUN` — Default `true`; set to `false` only when you are ready to post real orders.
- `MM_QUOTE_SHARES` — Shares per quote. Default `5`.
- `MM_MAX_USDC_PER_LEG` — Max USDC to spend buying UP or DOWN in each 5m round. Default `0` means unlimited.
- `MM_QUOTE_SPREAD` — Total width around fair value. Default `0.06`, so bids are roughly 3 cents below fair.
- `MM_MIN_LOCKED_EDGE` — Minimum theoretical edge when both BUY legs fill. Default `0.02`.
- `MM_INVENTORY_SKEW_PER_SHARE` — Price skew per excess share. Default `0.002`.
- `MM_MAX_INVENTORY_SHARES` — Stops adding paired bids once inventory reaches this cap. Default `30`.
- `MM_ENABLE_SELL_EXCESS` — Places SELL quotes for excess one-sided inventory. Default `true`.
- `BTC5M_INTERVAL_MINUTES`, `BTC5M_MARKET`, `BTC5M_TICK_SIZE`, `BTC5M_NEG_RISK` — Shared BTC 5m defaults; `MM_*` overrides are still supported if needed.

BTC 5m edge backtest:
```bash
npm run backtest:btc5m -- --strategy edge --csv data/btc5m-history.csv
```

BTC 5m edge live/dry-run:
```bash
npm run btc5m:edge
```

The live edge bot writes decision/order rows to `EDGE_RECORD_FILE` when `EDGE_RECORD_ENABLED=true` (default `data/btc5m-edge-live.csv`). Keep this file together with collector history so future parameter sweeps can compare real signals, posted orders, fills, and market outcomes.

BTC 5m managed-edge live/dry-run:
```bash
npm run btc5m:managed-edge
```

`managed-edge` extends `edge` with position management: it only opens during a configured time window, blocks cheap late-cycle buys, sells partial size on take-profit, exits on stop-loss, and can force-exit near expiry. Its knobs are grouped under `MANAGED_EDGE_*` in `.env.example`.

`adaptive-edge` is an experimental backtest-only strategy. Its undervalue filter scores each candidate with market-implied probability mispricing (`ask / (upAsk + downAsk)`), direct `fair - ask`, recent ask percentile, BTC/contract momentum divergence, panic-discount bonus, required-sigma penalty, and late-entry penalty. Tune these with `ADAPTIVE_EDGE_*` in `.env.example`.

`trend-pullback` is a strong-trend pullback strategy. When the first UP or DOWN ask reaches `TREND_PULLBACK_TRIGGER_PRICE`, it keeps a BUY limit at `TREND_PULLBACK_ENTRY_PRICE`. Each cycle follows only the first triggered leg.

Optional guards under `TREND_PULLBACK_*` can require the trigger to persist, expire a stale pending order, and cancel after an adverse BTC move from the trigger point.
The default `TREND_PULLBACK_MAX_BTC_REVERSAL_BPS=8` cancels the pending limit if BTC moves eight basis points against the triggered direction.

```bash
npm run backtest:btc5m -- --strategy btc5m:trend-pullback --csv data/btc5m-history.csv
```

Run live-market dry-run first:

```bash
TREND_PULLBACK_DRY_RUN=true npm run btc5m:trend-pullback
```

Dry-run records a simulated fill only when a later ask reaches the posted limit. Market snapshots, strategy state, decisions, and order events are appended to `TREND_PULLBACK_RECORD_FILE`. After reviewing the CSV, set `TREND_PULLBACK_DRY_RUN=false` in `.env` to post real GTC orders.

`--strategy` and `--csv` are required. Supported strategy names:
- `edge` or `btc5m:edge` — Standalone BTC fair-probability mispricing strategy; requires `btc_price` and `open_price`.
- `managed-edge` or `btc5m:managed-edge` — Edge strategy with entry windows, cheap-late-buy filter, take-profit, stop-loss, and force-exit logic.
- `adaptive-edge` or `btc5m:adaptive-edge` — Backtest-only regime strategy that switches between trending edge, oscillating scalp, and panic-discount entries.
- `trend-pullback` or `btc5m:trend-pullback` — Backtests a strong-trend trigger followed by a lower persistent BUY limit; `npm run btc5m:trend-pullback` runs it live or in dry-run mode.
- `range-arb` or `btc5m:range-arb` — Backtests the fixed-price `RANGE_ARB_PRICE_X` / `RANGE_ARB_USDC_PER_LEG` strategy.
- `market-maker` or `btc5m:market-maker` — Backtests the current bid-quoting market-maker logic using `MM_` parameters.
- `hybrid` or `btc5m:hybrid` — Backtests the regime-switching edge/range-arb strategy.

Polymarket-only CSVs with `winning_outcome` can be used by `range-arb` and `market-maker`.

Collect BTC 5m history:
```bash
npm run collect:btc5m-history -- --duration-minutes 120 --out-dir data
```

This writes live samples to `data/btc5m-history.csv` by default. It is Polymarket-only unless `COLLECT_BTC_PRICE_ENABLED=true`; each row includes Polymarket UP/DOWN bid/ask/mid, token IDs, market slug, resolution winner when available, and optional BTC/open prices. Set `--duration-minutes 0` to run continuously.

If external BTC price collection is enabled and one source is blocked, the collector automatically tries the next source from `COLLECT_BTC_PRICE_URLS` / `--btc-price-urls`. Separate multiple URLs with `|`.

Expected CSV columns:
```csv
row_type,timestamp,btc_price,open_price,up_ask,down_ask,winning_outcome
sample,2026-07-11T00:00:05.000Z,,,0.51,0.50,
resolution,2026-07-11T00:05:02.000Z,,,0.99,0.01,Up
```

Optional columns:
- `slug` — Market/cycle id. If omitted, the backtester groups rows by 5-minute timestamp.
- `open_price` — BTC price at cycle open. If omitted, the first row in each cycle is used.

Backtest knobs:
- `BACKTEST_STRATEGY` — Strategy name. Supported: `edge`, `btc5m:edge`, `range-arb`, `market-maker`, `btc5m:range-arb`, `btc5m:market-maker`.
- `BACKTEST_MIN_EDGE` — Minimum `fairProbability - askPrice` needed to buy. Default `0.03`.
- `BACKTEST_EDGE_MIN_MOVE_BPS` — Minimum BTC move from cycle open, in basis points, before edge can trade. Default `0`.
- `BACKTEST_EDGE_MIN_ELAPSED_SECONDS` — Minimum seconds after cycle start before edge can trade. Default `0`.
- `BACKTEST_ORDER_USDC` — USDC per simulated buy. Default `5`.
- `BACKTEST_MAX_USDC_PER_LEG` — Max UP or DOWN spend per cycle. Default `10`.
- `BACKTEST_VOL_PER_INTERVAL` — Assumed BTC volatility over one 5m interval. Default `0.0015`.

## Files

- `src/data/copytrade-state.json` — Bot state (prices, condition IDs, market info)
- `src/data/credential.json` — API credential (created from your key)
- `logs/` — Log files
- Holdings are tracked in `src/utils/holdings.ts` (in memory, used for redeem)

---

**TL;DR** — Bot predicts UP/DOWN, places limit orders when confident, tracks accuracy. Lock profit by selling on Polymarket or running the auto-redeem script. Change markets by editing `COPYTRADE_MARKETS` and restarting.
