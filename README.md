# Meridian

**Autonomous AI-driven DLMM liquidity provider for Meteora on Solana.**

Meridian deploys capital into Meteora Dynamic Liquidity Market Maker (DLMM) pools, monitors positions in real time, and exits them based on a deterministic rule engine — bypassing the LLM for time-critical actions. An LLM agent (via OpenRouter or any OpenAI-compatible endpoint) handles pool screening, conviction scoring, and edge-case management decisions that cannot be reduced to simple rules.

---

## Target Users

- Solana traders who want automated, compounding LP positions
- Quant developers building on top of Meteora's DLMM SDK
- DeFi operators running unattended liquidity strategies with risk controls

---

## Table of Contents

1. [Core Strategy](#core-strategy)
2. [Architecture](#architecture)
3. [Tech Stack](#tech-stack)
4. [Setup & Installation](#setup--installation)
5. [Environment Variables](#environment-variables)
6. [Usage](#usage)
7. [CLI Reference](#cli-reference)
8. [Configuration](#configuration)
9. [Key Modules](#key-modules)
10. [Automation Logic](#automation-logic)
11. [Exit Mechanics](#exit-mechanics)
12. [Learning System](#learning-system)
13. [Telegram Integration](#telegram-integration)
14. [Safety & Risk Warning](#safety--risk-warning)
15. [Troubleshooting](#troubleshooting)
16. [Changelog](#changelog)

---

## Core Strategy

### Pool Selection

The SCREENER agent queries the Meteora Pool Discovery API and the OKX smart-money signal feed, then applies hard filters before the LLM ever sees a candidate:

| Filter | Default |
|--------|---------|
| TVL window | $10k – $150k |
| Volume (per timeframe) | ≥ $500 |
| Organic score | ≥ 60 |
| Token holders | ≥ 500 |
| Market cap | $150k – $10M |
| Bin step | 80 – 125 |
| Fee/active-TVL ratio | ≥ 0.05% |
| Min global fees paid | ≥ 30 SOL (bundler/scam filter) |
| Max bot holders | ≤ 30% (Jupiter audit) |
| Max top-10 concentration | ≤ 60% |
| Blocked launchpads | configurable list |
| Cooldown pools/mints | checked before deploy |

Blacklisted tokens (`token-blacklist.json`) and blocked deployers (`deployer-blacklist.json`) are stripped before candidates reach the LLM.

The LLM then scores remaining candidates on narrative quality, smart-wallet presence, and OKX token tags (`dev_sold_all`, `smart_money_buy`, `is_honeypot`, `wash_trading`, etc.) to select one pool for deployment.

### Liquidity Placement

Positions use **volatility-adaptive bin ranges** computed at deploy time:

```
targetDownside = clamp(0.25 + (volatility / 5) × 0.30, max=0.55)
targetUpside   = clamp(0.15 + (volatility / 5) × 0.15, max=0.35)  [spot only]

bins = ceil(|log(1 ± targetPct)| / log(1 + binStep / 10000))
```

- `volatility = 0` → downside coverage ~25% price drop (~35 bins below)
- `volatility = 5` → downside coverage ~55% price drop (~69 bins below)
- `bid_ask` strategy sets `bins_above = 0` (directional, no upside liquidity wasted)
- `spot` strategy places symmetric liquidity above and below

**Strategy selection** (LLM decision, with defaults):

| Signal | Strategy |
|--------|----------|
| `smart_money_buy` tag OR `price_change > 0` with net buyers | `bid_ask` |
| Token age < 48h with strong narrative | `bid_ask` |
| Range-bound volume, no directional signal | `spot` |
| Default when ambiguous | `bid_ask` |

### Position Sizing

Position size scales with wallet balance (compounding formula):

```
deployable   = walletSOL − gasReserve
dynamic      = deployable × positionSizePct
deployAmount = clamp(dynamic, floor=deployAmountSol, ceil=maxDeployAmount)
```

Defaults: `gasReserve=0.2`, `positionSizePct=0.35`, `floor=0.5 SOL`, `ceil=50 SOL`.

Example progression: 0.8 SOL wallet → 0.5 SOL deploy (floor) | 2.0 SOL wallet → 0.63 SOL | 4.0 SOL wallet → 1.33 SOL.

### Management Rules (Deterministic, No LLM)

Every management cycle evaluates each open position against ordered rules:

| Priority | Rule | Condition |
|----------|------|-----------|
| 0 | **Instruction** | Position has a custom instruction — passed to LLM for evaluation |
| 1 | **Hard exit** | Trailing TP or stop-loss confirmed (see [Exit Mechanics](#exit-mechanics)) |
| 2 | **Static TP** | `pnl_pct ≥ takeProfitFeePct` AND trailing TP not yet active |
| 3 | **Pumped OOR** | `active_bin > upper_bin + outOfRangeBinsToClose` |
| 4 | **Upside OOR timeout** | Above range for `outOfRangeWaitMinutes / √volatility` minutes |
| 4b | **Downside OOR timeout** | Below range for `downsideOorWaitMinutes` minutes (default 10m) |
| 5 | **Low yield** | `fee_per_tvl_24h < minFeePerTvl24h` after minimum age |
| — | **Auto-claim** | `unclaimed_fees_usd ≥ minClaimAmount` OR `≥ autoClaimPct%` of position value |
| — | **STAY** | None of the above — hold |

Positions with suspicious PnL (API returning −99% while value is non-zero) are excluded from PnL rules to prevent false stop-loss triggers.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  index.js — Orchestrator                                             │
│  REPL + cron manager + Telegram polling + direct exit handlers       │
│                                                                      │
│  ┌─────────────────┐         ┌──────────────────────────────────┐   │
│  │ Management cron │         │ Screening cron                   │   │
│  │ every N min     │         │ every M min (or triggered after  │   │
│  │ (default 10m)   │         │ management when no positions)    │   │
│  └────────┬────────┘         └─────────────────┬────────────────┘   │
│           │                                    │                     │
│           ▼                                    ▼                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  agent.js — ReAct Loop                                       │   │
│  │  buildSystemPrompt() → LLM → tool_calls → executeTool()      │   │
│  │  → repeat until final answer or maxSteps reached             │   │
│  └──────────────┬───────────────────────────────────────────────┘   │
│                 │ tool calls                                         │
│  ┌──────────────▼───────────────────────────────────────────────┐   │
│  │  tools/executor.js — Tool Dispatcher                         │   │
│  │  Safety checks → toolMap[name]() → post-hooks (swap, notify) │   │
│  └──┬─────────┬──────────┬──────────┬──────────┬───────────────┘   │
│     │         │          │          │          │                     │
│  dlmm.js  screening.js  wallet.js  token.js  study.js               │
│  (on-chain) (API)     (Jupiter)  (Jupiter) (LPAgent)                │
│                                                                      │
│  state.js          pool-memory.js     lessons.js                    │
│  (position registry) (per-pool history) (learning engine)           │
└──────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Market data (Meteora API + OKX)
    → Pool Discovery API (hard filtering)
    → getTopCandidates() (condensed for LLM)
    → LLM scoring + parallel tool calls
        (getTokenHolders, checkSmartWalletsOnPool, getTokenNarrative, getPoolDetail)
    → deploy_position() with safety checks
    → trackPosition() in state.js
    → Telegram deploy notification

Management cycle (cron):
    getMyPositions() → getPositionPnl()
    → deterministic rule engine (JS, no LLM)
    → LLM agent for INSTRUCTION-type positions only
    → close_position() / claim_fees()
    → autoSwapBaseToken() (Jupiter)
    → recordPerformance() → evolveThresholds()
    → Telegram close notification
```

---

## Tech Stack

| Component | Library / Service |
|-----------|-------------------|
| Runtime | Node.js ≥ 18 (ESM) |
| DLMM SDK | `@meteora-ag/dlmm` 1.9.4 |
| Solana RPC | `@solana/web3.js` ^1.95 |
| Token/SPL | `@solana/spl-token` ^0.3.11 |
| LLM client | `openai` ^4.73 (OpenAI-compatible) |
| LLM provider | OpenRouter (default), MiniMax, LM Studio |
| Scheduling | `node-cron` ^3 |
| Swaps | Jupiter V6 API |
| Pool data | Meteora Pool Discovery API, datapi.jup.ag |
| Smart money | OKX advanced-info API |
| LP study | LPAgent API |
| Notifications | Telegram Bot API (long polling) |
| Encoding | `bs58`, `bn.js` |
| JSON repair | `jsonrepair` |

---

## Setup & Installation

### Requirements

- Node.js ≥ 18.0.0
- A funded Solana wallet (private key in base58 or JSON array format)
- A Solana RPC endpoint (Helius recommended)
- An LLM API key (OpenRouter, MiniMax, or any OpenAI-compatible provider)

### Install

```bash
git clone <repo-url> meridian
cd meridian
npm install
```

### Configure

```bash
cp user-config.example.json user-config.json
# Edit user-config.json with your RPC URL, LLM key, and model
```

At minimum, set:
- `rpcUrl` — your Solana RPC endpoint
- `llmApiKey` — your LLM API key
- `llmModel` — model to use (e.g. `minimax/minimax-m2.7`, `openrouter/healer-alpha`)

Alternatively, create a `.env` file with `WALLET_PRIVATE_KEY`, `RPC_URL`, and `OPENROUTER_API_KEY`.

### Interactive Setup (optional)

```bash
npm run setup
```

Walks through wallet and config setup interactively.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WALLET_PRIVATE_KEY` | **Yes** | Base58 or JSON array Solana private key |
| `RPC_URL` | **Yes** | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes* | LLM API key for OpenRouter |
| `LLM_API_KEY` | Yes* | Generic LLM API key (overrides provider-specific keys) |
| `LLM_BASE_URL` | No | Override LLM endpoint (e.g. `http://localhost:1234/v1` for LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `MINIMAX_API_KEY` | No | MiniMax-specific API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token for notifications and commands |
| `TELEGRAM_CHAT_ID` | No | Telegram chat/channel ID to send messages to |
| `TELEGRAM_ALLOWED_USER_IDS` | No | Comma-separated Telegram user IDs allowed to send commands |
| `DRY_RUN` | No | Set to `true` to simulate all actions (no on-chain transactions) |
| `HIVE_MIND_URL` | No | Hive Mind collective intelligence server URL |
| `HIVE_MIND_API_KEY` | No | Hive Mind authentication token |
| `HELIUS_API_KEY` | No | Helius API key for enhanced wallet balance data |

\* One LLM key is required. Priority: `LLM_API_KEY` → `MINIMAX_API_KEY` → `OPENROUTER_API_KEY`.

All variables can alternatively be specified in `user-config.json` (fields: `rpcUrl`, `walletKey`, `llmApiKey`, `llmBaseUrl`, `llmModel`, `minimaxApiKey`, `dryRun`).

---

## Usage

### Run the Bot (Live)

```bash
npm start
# or
node index.js
```

Starts the REPL, management cron, screening cron, and Telegram polling (if configured).

### Dry-Run Mode

```bash
npm run dev
# or
DRY_RUN=true node index.js
```

All on-chain transactions are simulated — deploy, close, claim, and swap calls return mock responses without touching the chain.

### REPL

Once running, the interactive REPL accepts natural-language commands:

```
[manage: 8m 12s | screen: 22m 5s]
> deploy 0.5 SOL into the best trending pool
> close all positions
> show my positions and PnL
> claim fees
> set config maxPositions 5
> what's my balance?
> show performance history
> add a lesson: avoid pools where top 10 holders > 50%
```

The agent detects intent and routes to the appropriate tool subset automatically.

---

## CLI Reference

The `meridian` CLI provides direct tool access for scripting and automation:

```bash
# Commands
meridian balance                              # Wallet balances (JSON)
meridian positions                            # Open DLMM positions (JSON)
meridian pnl <position_address>               # PnL for a specific position
meridian screen [--dry-run] [--silent]        # Run one AI screening cycle
meridian manage [--dry-run] [--silent]        # Run one AI management cycle
meridian deploy \
  --pool <address> \
  --amount <sol> \
  [--strategy bid_ask|spot] \
  [--bins-below 69] \
  [--bins-above 0] \
  [--dry-run]
meridian claim --position <address>
meridian close --position <address>
meridian swap --from <mint> --to <mint> --amount <n>
meridian config get
meridian config set <key> <value>
```

All output is JSON to stdout. Errors are JSON to stderr with exit code 1.

Config data dir: `~/.meridian/` (env file and config loaded from here when installed globally).

---

## Configuration

All keys live in `user-config.json` and take effect immediately via the `update_config` tool — no restart required. Cron intervals restart automatically when schedule keys change.

### Screening Parameters

| Key | Default | Description |
|-----|---------|-------------|
| `minFeeActiveTvlRatio` | `0.05` | Min fee/active-TVL ratio (already in % form — 0.05 = 0.05%) |
| `minTvl` / `maxTvl` | `10000` / `150000` | TVL range (USD) |
| `minVolume` | `500` | Min volume (USD) per timeframe window |
| `minOrganic` | `60` | Min organic score (0–100) |
| `minHolders` | `500` | Min token holder count |
| `minMcap` / `maxMcap` | `150000` / `10000000` | Market cap range (USD) |
| `minBinStep` / `maxBinStep` | `80` / `125` | Allowed DLMM bin step range |
| `timeframe` | `"5m"` | Metric window (`5m`, `15m`, `1h`, `2h`, `4h`, `24h`) |
| `category` | `"trending"` | Pool discovery category |
| `minTokenFeesSol` | `30` | Min global fees paid by the token (SOL) — low = likely bundled launch |
| `maxBundlePct` | `30` | Max bundle holding % (OKX) |
| `maxBotHoldersPct` | `30` | Max bot holder addresses % (Jupiter audit) |
| `maxTop10Pct` | `60` | Max top-10 holder concentration |
| `blockedLaunchpads` | `[]` | Launchpad hostnames to skip (e.g. `["pump.fun"]`) |
| `minTokenAgeHours` | `null` | Min token age in hours (`null` = no limit) |
| `maxTokenAgeHours` | `null` | Max token age in hours (`null` = no limit) |
| `athFilterPct` | `null` | Only deploy if price ≥ X% below ATH (e.g. `-20`) |

### Management Parameters

| Key | Default | Description |
|-----|---------|-------------|
| `deployAmountSol` | `0.5` | Floor for position size (SOL) |
| `maxDeployAmount` | `50` | Ceiling for position size (SOL) |
| `positionSizePct` | `0.35` | Fraction of deployable balance per position |
| `gasReserve` | `0.2` | SOL reserved for gas (never deployed) |
| `maxPositions` | `3` | Max concurrent open positions |
| `minSolToOpen` | `0.55` | Minimum wallet SOL to open a new position |
| `takeProfitFeePct` | `5` | Static take-profit threshold (% PnL) |
| `trailingTakeProfit` | `true` | Enable trailing take-profit |
| `trailingTriggerPct` | `3` | PnL % at which trailing TP activates |
| `trailingDropPct` | `1.5` | Close when PnL drops this % below confirmed peak |
| `stopLossPct` | `-20` | Stop-loss threshold (% PnL) |
| `minAgeBeforeSL` | `15` | Minutes before stop loss can trigger |
| `outOfRangeWaitMinutes` | `30` | Minutes before closing an upside OOR position |
| `downsideOorWaitMinutes` | `10` | Minutes before closing a downside OOR position |
| `outOfRangeBinsToClose` | `10` | Bins above upper bin to trigger immediate close |
| `autoClaimPct` | `5` | Auto-claim when unclaimed fees ≥ X% of position value |
| `minClaimAmount` | `5` | Absolute unclaimed fee threshold (USD) |
| `minFeePerTvl24h` | `7` | Min fee yield % per TVL per 24h before low-yield exit |
| `minAgeBeforeYieldCheck` | `60` | Minutes before low-yield exit rule can trigger |
| `solMode` | `false` | Report PnL and balances in SOL instead of USD |

### Schedule Parameters

| Key | Default | Description |
|-----|---------|-------------|
| `managementIntervalMin` | `10` | Management cron interval (minutes) |
| `screeningIntervalMin` | `30` | Screening cron interval (minutes) |
| `healthCheckIntervalMin` | `60` | Health-check cron interval (minutes) |

The agent auto-adjusts `managementIntervalMin` after each deploy based on pool volatility:
- `volatility ≥ 5` → 3 minutes
- `volatility 2–5` → 5 minutes
- `volatility < 2` → 10 minutes

### LLM Parameters

| Key | Default | Description |
|-----|---------|-------------|
| `managementModel` | provider default | Model for MANAGER role |
| `screeningModel` | provider default | Model for SCREENER role |
| `generalModel` | provider default | Model for GENERAL/REPL role |
| `temperature` | `0.373` | LLM sampling temperature |
| `maxTokens` | `4096` | Max output tokens per LLM call (minimum 2048 for reliable tool use) |
| `maxSteps` | `20` | Max ReAct loop iterations per agent invocation |

---

## Key Modules

### `index.js` — Orchestrator

- Starts and manages `node-cron` jobs for management, screening, and briefing cycles
- Hosts the interactive REPL with live countdown display (`[manage: 8m 12s | screen: 22m 5s]`)
- Runs the Telegram bot polling loop and command router
- Contains all **direct (non-LLM) exit handlers**: trailing TP, stop loss, and Telegram `/close` command
- Implements a 15-second reconfirmation delay for trailing TP and stop-loss exits to filter transient API noise
- Guards against concurrent cycles with `_managementBusy` / `_screeningBusy` mutex flags

### `agent.js` — ReAct Loop

Implements the core reasoning loop:
1. Build system prompt with live wallet state, open positions, learned lessons, and performance summary
2. Send to LLM with role-filtered tool list
3. Execute tool calls in parallel
4. Feed results back into the message thread
5. Repeat until the model returns a final text answer or `maxSteps` is exhausted

Key safety guards:
- `ONCE_PER_SESSION`: `deploy_position`, `swap_token`, `close_position` can only fire once per agent invocation
- `NO_RETRY_TOOLS`: `deploy_position` is locked after the first attempt regardless of outcome
- Malformed tool call JSON is auto-repaired via `jsonrepair` before being pushed to message history
- Models rejecting `tool_choice: "required"` fall back to `"auto"` automatically
- Models rejecting the `system` role have instructions embedded in the user message instead

### `tools/dlmm.js` — Meteora DLMM Wrapper

- `deployPosition()` — creates DLMM position with volatility-computed bin range, chosen strategy, and SOL/token amounts; reads `baseFactor` from pool params to compute actual base fee
- `closePosition()` — withdraws all liquidity and collects fees; triggers `recordPerformance()`
- `claimFees()` — collects accumulated swap fees without closing the position
- `getMyPositions()` — all open positions with PnL, range status, and OOR duration
- `getPositionPnl()` — detailed PnL breakdown for one position
- `getActiveBin()` — current active bin ID and price for a pool

Implementation notes:
- Pool objects are cached for 5 minutes to reduce RPC overhead
- DLMM SDK is lazy-loaded (dynamic `import()`) to avoid ESM/CJS incompatibilities at startup
- Dry-run mode returns a complete mock response without touching the RPC

### `tools/executor.js` — Tool Dispatcher

Routes LLM tool calls to implementations and enforces pre-conditions.

**Deploy safety checks (hard-blocked, not LLM-overridable):**
- `bin_step` within `[minBinStep, maxBinStep]`
- Position count below `maxPositions` (force-fresh scan, bypasses cache)
- No duplicate pool address or duplicate base token already in portfolio
- SOL balance covers `amount_y + gasReserve` (skipped for token-X-only deploys)
- Pool and base-mint cooldown checks from `pool-memory.js`

**Post-close hooks (always fire on successful close):**
- Auto-swap base token → SOL via Jupiter if USD value ≥ $0.10
- Send Telegram close notification with full enriched data
- Call `recordPerformance()` for the learning system

### `prompt.js` — System Prompt Builder

Constructs role-specific prompts injected at the start of each agent invocation:

- **SCREENER**: Candidate evaluation rubric, hard filters, strategy selection matrix, deploy rules, lessons
- **MANAGER**: Position management rules, yield-health checks, bias-to-hold guidance, gas-efficiency rules, lessons
- **GENERAL**: Full tool access, parallel-fetch rules, override-by-user-instruction rule, anti-hallucination constraints

All prompts include: live portfolio state, open positions, current config, and injected lessons.

### `state.js` — Position Registry

Persists position metadata to `state.json` (atomic write via temp file + rename):
- Deployment parameters: strategy, bin range, amounts, volatility, fee/TVL ratio, organic score
- OOR tracking: first-OOR timestamp and cumulative duration
- Trailing TP state: `trailing_active`, `peak_pnl_pct`, `confirmed_trailing_exit_until`
- Stop-loss state: pending confirmation queue
- Per-position instructions (for conditional exits set via REPL or Telegram `/set`)

### `lessons.js` — Learning Engine

Records closed-position performance and evolves screening thresholds:

- `recordPerformance()` — called after every close; calculates PnL %, range efficiency (`minutes_in_range / minutes_held`), enriches with Meteora API data; sanity-filters absurd records (−90%+ PnL without stop-loss reason)
- `getLessonsForPrompt({ agentType })` — formats top lessons (pinned first, then by recency) for system prompt injection
- `evolveThresholds()` — adjusts `minFeeActiveTvlRatio`, `minHolders`, `minMcap`, `minTvl` toward winner-profile medians; requires ≥ 5 closed positions; max change per step: 20%

**Known limitation**: `evolveThresholds()` internally references `maxVolatility` and `minFeeTvlRatio` keys that do not exist in `config.js` — those two evolution paths are currently no-ops.

### `signal-weights.js` — Darwinian Signal Weighting

Tracks which screening signals actually predict profitable positions and adjusts their weights accordingly:

- Tracked signals: `organic_score`, `fee_tvl_ratio`, `volume`, `mcap`, `holder_count`, `smart_wallets_present`, `narrative_quality`, `study_win_rate`, `hive_consensus`, `volatility`
- Winners boost signal weights by `darwinBoost` (default ×1.05); losers decay by `darwinDecay` (default ×0.95)
- Weights clamped to `[darwinFloor, darwinCeiling]` = `[0.3, 2.5]`
- Recalculated every `darwinRecalcEvery` closed positions (default every 5)
- Injected into the system prompt so the LLM can weight higher-scoring signals more heavily

### `pool-memory.js` — Per-Pool History

Tracks deploy history, snapshots, and cooldowns per pool address (`pool-memory.json`):
- Cooldown system: pools/mints that triggered OOR closes `oorCooldownTriggerCount` times enter an `oorCooldownHours`-long cooldown
- Per-pool snapshots used as recall context in SCREENER decisions
- `recallForPool()` returns a summary that is prepended to the management task goal

### `smart-wallets.js` — KOL/Alpha Wallet Tracker

Maintains a curated list of "smart wallets" (KOL/alpha traders). `checkSmartWalletsOnPool()` checks whether any tracked wallets hold the token — a strong bullish signal that can override weak narrative scores and is the only valid override for an OKX rugpull flag.

### `hive-mind.js` — Collective Intelligence (Optional)

When `HIVE_MIND_URL` and `HIVE_MIND_API_KEY` are set, syncs lessons and deploy decisions to a shared server and queries for consensus patterns across multiple agent instances. Not required for single-instance operation.

---

## Automation Logic

### Cron Schedule

| Job | Default Interval | Notes |
|-----|-----------------|-------|
| Management cycle | Every 10 min | Tightens to 3–5 min after volatile deploy |
| Screening cycle | Every 30 min | Also triggered immediately when no positions open |
| Morning briefing | Daily at 01:00 UTC | Missed briefings sent on startup |
| PnL health check | Every 60 min | Separate lightweight check |

### Mutual Exclusion

- `_managementBusy` and `_screeningBusy` flags prevent overlapping cron invocations
- `_screeningLastTriggered` prevents management from triggering screening more than once per 5 minutes
- `ONCE_PER_SESSION` blocks duplicate deploys/closes within a single agent session
- `deploy_position` safety check uses `force: true` on `getMyPositions()` to bypass position cache

---

## Exit Mechanics

### Static Take-Profit

Fires when `pnl_pct ≥ takeProfitFeePct` (default 5%) **and** trailing TP has not yet activated. Once trailing TP activates, static TP is suppressed — trailing handles all exits from that point forward.

### Trailing Take-Profit

1. PnL reaches `trailingTriggerPct` (default 3%) → `trailing_active = true`, peak PnL recorded
2. Each management tick: a peak reconfirmation timer (15s, tolerance 0.85×) validates the peak before locking it
3. If PnL drops `trailingDropPct` (default 1.5%) below the confirmed peak → drop queued for confirmation
4. A 15-second reconfirmation re-fetches live PnL with 0.3% tolerance before executing
5. On confirmation: `closePosition()` called **directly** (bypasses LLM), fallback to `runManagementCycle()` on failure
6. Exit window lock (`confirmed_trailing_exit_until`) prevents duplicate close attempts for 120 seconds

### Stop Loss

Triggered at `stopLossPct` (default −20%) with the same 15-second reconfirmation flow and 0.5% tolerance. Position must be older than `minAgeBeforeSL` (default 15 min) to prevent stop-loss on fresh deploys during initial price discovery.

### Out-of-Range Exits

- **Upside OOR timeout**: Active bin above `upper_bin` for `outOfRangeWaitMinutes / √volatility` minutes (dynamic — high-volatility positions exit faster)
- **Far above range**: `active_bin > upper_bin + outOfRangeBinsToClose` → immediate close (no wait)
- **Downside OOR timeout**: Active bin below `lower_bin` for `downsideOorWaitMinutes` minutes (default 10 min; faster because downside recovery on meme tokens is rare)

### Post-Close Auto-Swap

After every close (LLM-triggered or direct), the base token is automatically swapped back to SOL via Jupiter if USD value ≥ $0.10. Dust below $0.10 is skipped to avoid wasting gas.

---

## Learning System

```
Position closed
    → recordPerformance() stores: PnL %, range efficiency, close reason,
      strategy, bin step, volatility, token metrics, Meteora API enrichment
    → evolveThresholds() (if ≥ 5 positions):
        compare winners vs losers across screening dimensions
        nudge thresholds toward winner-profile medians (max 20% per step)
        persist to user-config.json + hot-reload into memory
    → signal-weights.js: boost/decay Darwinian signal weights
    → next agent prompt includes updated lessons and weights
```

Manual lessons can be added via the REPL (`add a lesson: ...`) or pinned for permanent priority. The LLM can self-add lessons during a session via the `add_lesson` tool.

---

## Telegram Integration

### Notifications (Outbound)

| Event | Contents |
|-------|----------|
| Position deployed | Pool name, strategy, bin range, amount, volatility |
| Position closed | Reason, PnL USD/%, fees earned, range efficiency, age, deposited/withdrawn USD |
| Token swapped | From/to symbols, amount, estimated value |
| Out of range | Pool name, direction, minutes OOR (debounced — no spam) |
| Morning briefing | Daily HTML summary of portfolio, PnL, and market snapshot |

### Commands (Inbound)

| Command | Action |
|---------|--------|
| `/positions` | List open positions with visual progress bar `[████████░░] 40%` |
| `/close <n>` | Close position by list index (direct bypass of LLM) |
| `/set <n> <note>` | Set a conditional instruction on a position |
| `/bootstrap <wallet>` | Import LP history from an existing wallet address |
| Any other text | Routed to the GENERAL agent for natural-language handling |

**Security**: Commands are only processed from `TELEGRAM_CHAT_ID`. In group chats, `TELEGRAM_ALLOWED_USER_IDS` must be set — without it, all group commands are rejected. Auto-registration of unknown chat IDs is disabled by default.

---

## Safety & Risk Warning

> **This software interacts with live funds on Solana mainnet. Use at your own risk.**

- **Impermanent Loss**: DLMM positions are exposed to IL when the token price moves outside the deployed bin range. The bot does not hedge IL exposure.
- **Smart Contract Risk**: Meteora DLMM contracts have not been independently audited for this integration. Bugs in the SDK or on-chain program could result in loss of funds.
- **Market Volatility**: Meme tokens can lose 90%+ of value within minutes. The stop-loss mechanism has a 15-second confirmation delay — during extreme volatility this may not be fast enough to prevent significant losses.
- **RPC Failure**: If `RPC_URL` becomes unavailable, the bot cannot fetch position state and management/exit rules will not fire.
- **LLM Hallucination**: The `ONCE_PER_SESSION` lock and anti-hallucination prompt instructions reduce but cannot eliminate the risk of the LLM claiming an action succeeded without actually executing it. All critical exits (trailing TP, stop loss, OOR timeouts) bypass the LLM entirely.
- **API Rate Limits**: OpenRouter and Jupiter rate limits can delay tool execution. The agent retries with exponential backoff and switches to a fallback model on 502/503/529 errors.
- **Capital Risk**: Start with `DRY_RUN=true` and small amounts. The compounding position-size formula increases capital at risk as the wallet grows.
- **Key Security**: Never commit `.env` or `user-config.json` with a real private key to version control. Use restricted-permission RPC endpoints where possible.

---

## Troubleshooting

### Bot doesn't deploy despite finding candidates

- Check `maxPositions` — if already at the limit, screening is blocked at the executor level
- Check `minSolToOpen` — wallet may have insufficient SOL after the gas reserve
- Check `blockedLaunchpads` and `token-blacklist.json` for overly broad filters
- Review logs (`logs/YYYY-MM-DD.log`) — search for `[blacklist]`, `[executor]`, `[screener]` prefixes

### Positions not closing on stop loss or trailing TP

- Verify `DRY_RUN` is not set to `true`
- Check for `[state_warn]` log entries — peak/drop confirmation failures typically indicate RPC issues
- Ensure position age exceeds `minAgeBeforeSL` (default 15 min) for stop loss
- `pnlSanityMaxDiffPct` (default 5%) may be filtering bad API ticks — look for `Suspect PnL` log entries

### LLM returning empty or incomplete responses

- Increase `maxTokens` — free models often cap at 1024 tokens, causing truncated/empty responses. Minimum recommended: 2048
- Switch to a different model via `managementModel` / `screeningModel` in `user-config.json`
- Check for 429 rate-limit log entries — the agent waits up to `Retry-After` seconds but very long waits can stall cycles

### Transaction failures

- Verify SOL balance covers `amount_y + gasReserve` (default 0.2 SOL)
- High network congestion: switch to a premium RPC endpoint (Helius, Triton)
- Anchor/CJS compatibility issues: run `node scripts/patch-anchor.js`

### Telegram commands not responding

- Confirm `TELEGRAM_CHAT_ID` matches the chat you're sending from (check bot logs for the actual incoming chat ID)
- For group chats: set `TELEGRAM_ALLOWED_USER_IDS` — commands from groups without explicit allowed users are silently dropped
- Verify `TELEGRAM_BOT_TOKEN` is valid and the bot is a member of the target chat

### `evolveThresholds` not updating screening config

- Requires ≥ 5 closed positions in `lessons.json`
- Note: `maxVolatility` and `minFeeTvlRatio` evolution paths are known no-ops — those config keys don't exist

---

## Changelog

Recent notable changes (from git history):

| Commit | Change |
|--------|--------|
| `f3528e8` | Downside OOR rule (Rule 4b), dynamic OOR timeout scaled by `√volatility`, auto-claim % threshold, reversal detection improvements |
| `3831828` | Fix auto-swap after direct closes (trailing TP, stop loss, `/close`); ensure `notifyClose` always fires |
| `70a6432` | Volatility-adaptive range calculation (continuous formula); Telegram message deduplication fix |
| `596df14` | MiniMax provider support; `notifyClose` enriched with range efficiency, age, deposited/withdrawn USD |
| `84155dd` | Fix overly aggressive low-yield exit; fix `evolveThresholds` bugs; improve `spot` strategy preference logic |
| `7dc302e` | `check_pool_eligibility` tool — returns per-criterion screening verdict without deploying |
| `05db130` | Adaptive strategy selection from token signals; deterministic volatility-based price range calculation |
| `cd917de` | Stop-loss reliability: 15s reconfirmation, LLM bypass, `minAgeBeforeSL` guard |
| `21bd8ac` | Trailing TP reliability; clarified interaction with static TP (trailing suppresses static once active) |
