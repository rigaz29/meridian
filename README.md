# Meridian

Autonomous DLMM liquidity provider for Meteora on Solana.

---

## Features

* AI-driven pool screening with OKX smart money signals and organic score filtering
* ReAct agent loop (SCREENER / MANAGER / GENERAL roles) via any OpenAI-compatible LLM
* Deterministic exit rules (stop loss, trailing TP, static TP) that bypass the LLM
* Out-of-range detection with separate wait times for upside vs downside OOR
* Auto-claim fees when unclaimed balance exceeds configurable threshold
* Auto-swap base token back to SOL after position close
* Trailing take-profit with peak/drop confirmation (15s recheck before executing)
* Lessons engine: records closed-position PnL, derives lessons, auto-evolves screening thresholds
* Pool memory: per-pool deploy history and snapshots
* Smart wallet (KOL/alpha) tracker
* Telegram bot: deploy/close/OOR notifications + `/positions`, `/close`, `/set` commands
* Daily briefing via Telegram
* Dry-run mode (no on-chain writes)
* Interactive REPL + cron orchestration in a single process

---

## Requirements

* Node.js >= 18
* Solana wallet with SOL
* RPC endpoint (e.g. Helius, Quicknode, public)
* OpenRouter API key (or any OpenAI-compatible endpoint)
* Telegram bot token + chat ID (optional, for notifications)
* Helius API key (optional, for enhanced balance data)

---

## Installation

```bash
git clone <repo-url>
cd meridian-yunus
npm install
```

Run the interactive setup wizard (creates `.env` and `user-config.json`):

```bash
npm run setup
```

Or configure manually — see sections below.

---

## Environment Variables (.env)

```env
WALLET_PRIVATE_KEY=        # Base58 or JSON array private key
RPC_URL=                   # Solana RPC endpoint
OPENROUTER_API_KEY=        # LLM API key (OpenRouter or compatible)
TELEGRAM_BOT_TOKEN=        # Optional — Telegram notifications
TELEGRAM_CHAT_ID=          # Optional — Telegram chat target
LLM_BASE_URL=              # Optional — override for local LLM (e.g. LM Studio)
LLM_MODEL=                 # Optional — override default model
DRY_RUN=true               # Optional — skip all on-chain transactions
HIVE_MIND_URL=             # Optional — collective intelligence server
HIVE_MIND_API_KEY=         # Optional — hive mind auth token
HELIUS_API_KEY=            # Optional — enhanced wallet balance data
```

Alternatively, set `rpcUrl`, `walletKey`, `llmModel`, `llmBaseUrl`, `llmApiKey` directly in `user-config.json`.

---

## Run

```bash
# Live mode
node index.js

# Dry run (no on-chain transactions)
npm run dev
```

---

## How It Works

1. **Startup**: fetches top pool candidates, displays them in the REPL
2. **Screening cron** (default: every 30 min): SCREENER agent scores pools, deploys if eligible
3. **Management cron** (default: every 10 min): MANAGER agent checks PnL, OOR status, fee accrual
4. **Deterministic exits**: stop loss, trailing TP, and static TP fire directly without LLM involvement
5. **Post-close**: auto-swaps base token to SOL, records performance, evolves thresholds

---

## Strategy (DLMM)

**Entry logic:**
* Pool must pass all screening filters (TVL, volume, organic score, holder count, mcap, bin step, fee/TVL ratio, bundler %, bot holder %)
* No duplicate pool or duplicate base token in existing positions
* Max 3 concurrent positions (configurable)
* Position size scales with wallet balance: `clamp(deployable × 35%, floor=0.5 SOL, ceil=50 SOL)`

**Range / bin logic:**
* Strategy: `bid_ask` (default)
* `bins_below = round(35 + (volatility / 5) × 34)`, clamped to [35, 69]
* `targetDownsidePct = 0.35` (covers 35% price drop below active bin)
* `targetUpsidePct = 0.20` (covers 20% price rise above active bin)

**Rebalance trigger:**
* Not clearly defined in code — OOR detection triggers exit, not rebalance

**Exit logic:**
* **Stop loss**: PnL ≤ -20% (15s confirmation, min 15 min position age)
* **Static TP**: unclaimed fees ≥ 5% of position value
* **Trailing TP**: activates at ≥ 3% PnL, closes when PnL drops 1.5% from confirmed peak (15s confirmation)
* **OOR upside**: close after 30 min out of range
* **OOR downside**: close after 10 min out of range
* Once trailing TP is active, static TP is suppressed

---

## Project Structure

```
index.js              Entry: REPL + cron + Telegram polling
agent.js              ReAct agent loop (LLM → tool call → repeat)
config.js             Runtime config from user-config.json + .env
prompt.js             System prompts per agent role
state.js              Position registry (state.json)
lessons.js            Performance recording + threshold evolution
pool-memory.js        Per-pool deploy history (pool-memory.json)
strategy-library.js   Saved LP strategies
briefing.js           Daily Telegram briefing
telegram.js           Telegram bot: polling + notifications
hive-mind.js          Optional collective intelligence sync
smart-wallets.js      KOL/alpha wallet tracker
token-blacklist.js    Permanent token blacklist
logger.js             Daily-rotating logs + audit trail

tools/
  definitions.js      Tool schemas (OpenAI format)
  executor.js         Tool dispatch + safety checks
  dlmm.js             Meteora DLMM SDK wrapper
  screening.js        Pool discovery + scoring
  wallet.js           SOL/token balances + Jupiter swap
  token.js            Token info, holders, bundler detection
  study.js            Top LPer study via LPAgent API
```

---

## Important Files

* `user-config.json` — all runtime config (created by `npm run setup`)
* `.env` — secrets (wallet key, RPC, API keys)
* `state.json` — open position registry (auto-created)
* `lessons.json` — closed-position performance + derived lessons (auto-created)
* `pool-memory.json` — per-pool deploy history (auto-created)

---

## REPL Commands

```
1 / 2 / 3 ...   Deploy into pool by list number
auto            Agent picks and deploys automatically
go              Start cron without deploying
/status         Refresh wallet + positions
/candidates     Refresh top pool list
/briefing       Show last 24h briefing
/learn          Study top LPers from best current pool
/learn <addr>   Study top LPers from a specific pool
/thresholds     Show current screening thresholds + win rate
/evolve         Manually trigger threshold evolution
/bootstrap      Import last 10 closed positions from Meteora API
/stop           Shut down
```

## Telegram Commands

```
/positions      List open positions with PnL
/close <n>      Close position by list index
/set <n> <note> Attach a note to a position
```

---

## Troubleshooting

* **RPC error** → check `RPC_URL`, try a paid endpoint
* **Empty LLM responses** → model `maxOutputTokens` too low; free models may cap at 512 — minimum is 2048
* **502/503 from LLM** → automatic fallback to `stepfun/step-3.5-flash:free`; check OpenRouter status
* **Position not deploying** → check SOL balance (`gasReserve` = 0.2 SOL required), `maxPositions` limit, duplicate token check
* **Tx fails on-chain** → check RPC health, wallet SOL balance for fees

---

## Notes

* This bot deploys real SOL into on-chain liquidity positions. You can lose money.
* Use `DRY_RUN=true` to test without executing transactions.
* Threshold evolution (`/evolve`) auto-adjusts screening config based on closed position history — results depend on data quality.
* Hive mind sync is optional and not required for normal operation.
