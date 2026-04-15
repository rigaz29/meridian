# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hive-mind.js        Optional collective intelligence server sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlersPct | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| autoCompound | management | false |
| autoCompoundFeePct | management | 0.02 |
| bearMode | management | false |
| outOfRangeWaitMinutes | management | 30 |
| downsideOorWaitMinutes | management | 5 |
| autoClaimPct | management | 5 |
| minAgeBeforeSL | management | 7 |
| priceDropSLPct | management | -15 |
| pnlVelocitySLPct | management | 5 |
| pnlVelocityWindowSec | management | 90 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |

**`computeDeployAmount(walletSol, openPositionsValueSol=0)`** — scales position size with wallet balance. Two modes:
- `autoCompound=false` (default): `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)` where `deployable = walletSol - gasReserve`
- `autoCompound=true`: `clamp(deployable × positionSizePct, floor=0, ceil=maxDeployAmount)` where `deployable = (walletSol + openPositionsValueSol) × (1 - autoCompoundFeePct)` — scales with **total portfolio** (free SOL + locked positions), not just free wallet. `deployAmountSol` is ignored. Executor safety check still caps actual deploy to available free SOL.

---

## Bear Mode (bearMode)

Protects against SOL depreciation during bear markets by keeping profits in USDC instead of SOL.

**When `bearMode: true`:**
- After `close_position`: base token → SOL (existing), then excess SOL → USDC (keep `gasReserve` in SOL)
- After `claim_fees`: same sweep — excess SOL → USDC
- Before `deploy_position`: if SOL < needed, auto-swap USDC → SOL (just enough to cover deploy + gasReserve, with 2% slippage buffer)
- Screening pre-check: accepts SOL+USDC combined value instead of requiring raw SOL balance

**Minimum sweep threshold:** 0.05 SOL — micro-amounts are not swapped to avoid unnecessary tx fees.

**Interaction with `autoSwapAfterClaim`:** bear mode sweep runs regardless of `autoSwapAfterClaim`. When both are on, flow is: base token → SOL → sweep excess SOL → USDC.

---

## Trailing TP vs Static TP

Two exit mechanisms coexist in `index.js`:

| Mechanism | Config Key | Default | Fires when... |
|-----------|-----------|---------|---------------|
| Static TP | `takeProfitFeePct` | 5% | PnL rises to X% |
| Trailing TP | `trailingTriggerPct` / `trailingDropPct` | 3% / 1.5% | PnL drops Y% from confirmed peak |

**Rule**: Once `trailing_active = true` (peak PnL ≥ `trailingTriggerPct`), **static TP is suppressed** — Rule 2 in management cycle checks `!tracked?.trailing_active` before firing. Trailing handles all exits from that point.

**Interaction examples:**

```
trailingTriggerPct=3%, trailingDropPct=1.5%, takeProfitFeePct=15%

Token pump cepat:  0% → 3% (trailing aktif) → 8% → 6.5% (drop 1.5%) → EXIT via trailing
Token pump lambat: 0% → 2% → 2% → OOR → keluar via Rule 4 (trailing tidak pernah aktif)
Token pump parabolic: 0% → 3% → 15% EXIT via static TP ceiling (sebelum sempat drop)
```

**Rekomendasi config:**
- Token volatile/meme: set `takeProfitFeePct` tinggi (12–20%) sebagai emergency ceiling, andalkan trailing
- Token stabil/fee-heavy: set `trailingTakeProfit: false`, andalkan static TP saja
- Jangan set `takeProfitFeePct` < `trailingTriggerPct` — static TP akan fire sebelum trailing sempat aktif

**Trailing TP execution flow** (bypass LLM):
```
Drop dikonfirmasi → closePosition() langsung (tidak lewat LLM)
                  → gagal? fallback ke runManagementCycle()
```
Confirmed exit window: 120s (state.js `confirmed_trailing_exit_until`).
Drop confirmation tolerance: 0.3% (index.js `TRAILING_DROP_CONFIRM_TOLERANCE_PCT`).

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
3. **Close**: `close_position` → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Safety Checks (executor.js)

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- If `amount_x > 0`: strip `amount_y` and `amount_sol` (tokenX-only deploy — no SOL needed)
- SOL balance must cover `amount_y + gasReserve` (skipped for tokenX-only)
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

---

## bins_below Calculation (SCREENER)

Auto-calculated in `tools/dlmm.js` based on actual pool `bin_step` and `volatility`. LLM never passes bins values.

```
targetDownside = min(0.50, 0.32 + (vol/5) * 0.09)
bins_below = min(cap, calcBinsFromTarget(binStep, targetDownside))
```

Caps per bin_step (based on historical performance sweet spots):
- `binStep >= 125` → cap 35 bins (~31–35% downside)
- `binStep >= 100` → cap 50 bins (~34–39% downside)
- `binStep < 100`  → cap 50 bins (~33–35% downside)

Result by bin_step:
- bs=80:  always capped at 50 bins (~33% downside)
- bs=100: 42 bins at vol=1 → 50 bins at vol=4+ (~34–39% downside)
- bs=125: 34 bins at vol=1 → 35 bins at vol=2+ (~31–35% downside)

`bins_above`: only non-zero if `amount_x > 0` (token X deployed), otherwise uses `binsAboveBuffer`.
- With token X: `spot`/`curve` → `targetUpside = min(0.35, 0.15 + (vol/5) * 0.15)`
- SOL-only deploy or `bid_ask` → `binsAboveBuffer` (default 0). These are **empty buffer bins** — no liquidity placed there (no token X), but they extend `maxBinId` upward so OOR above trigger is delayed. Based on 211-position backtest: avg price pump causing OOR above is 14.1%, so setting `binsAboveBuffer=10–15` covers most cases for bs=100.

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (2nd attempt), then retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`
- **Known issue**: `evolveThresholds()` references `maxVolatility` and `minFeeTvlRatio` but config.js uses `minFeeActiveTvlRatio` and has no `maxVolatility` key — the evolution of these keys is a no-op

---

## Hive Mind (hive-mind.js)

Optional feature. Enabled by setting `HIVE_MIND_URL` and `HIVE_MIND_API_KEY` in `.env`.
Syncs lessons/deploys to a shared server, queries consensus patterns.
Not required for normal operation.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

---

## Known Issues / Tech Debt

- `get_wallet_positions` tool (dlmm.js) is in definitions.js but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.
