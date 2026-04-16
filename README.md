# Meridian

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

Meridian runs continuous screening and management cycles, deploying capital into high-quality Meteora DLMM pools and closing positions based on live PnL, yield, and range data. It learns from every position it closes.

---

## What it does

- **Screens pools** — scans Meteora DLMM pools against configurable thresholds (fee/TVL ratio, organic score, holder count, mcap, bin step) and surfaces high-quality opportunities
- **Manages positions** — monitors, claims fees, and closes LP positions autonomously; decides to STAY, CLOSE, or REDEPLOY based on live data
- **Learns from performance** — saves structured lessons from every closed position and injects them into subsequent agent cycles
- **Darwinian signal weighting** — tracks which screening signals actually predict profitable positions and boosts/decays their weight automatically over time
- **Discord signals** — optional Discord listener watches LP Army channels for Solana token calls and queues them for screening
- **Telegram chat** — full agent chat via Telegram, plus cycle reports and OOR alerts
- **Claude Code integration** — run AI-powered screening and management directly from your terminal using Claude Code slash commands

---

## How it works

Meridian runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts. Two specialized agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Screening Agent** | Every 30 min | Pool screening — finds and deploys into the best candidate |
| **Management Agent** | Every 10 min | Position management — evaluates each open position and acts |

**Data sources:**
- `@meteora-ag/dlmm` SDK — on-chain position data, active bin, deploy/close transactions
- Meteora DLMM PnL API — position yield, fee accrual, PnL
- OKX OnchainOS — smart money signals, token risk scoring
- Pool screening API — fee/TVL ratios, volume, organic scores, holder counts
- Jupiter API — token audit, mcap, launchpad, price stats

Agents are powered via **OpenRouter** and can be swapped for any compatible model.

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key (or any OpenAI-compatible endpoint)
- Solana wallet (base58 private key)
- Solana RPC endpoint ([Helius](https://helius.xyz) recommended)
- Telegram bot token (optional)
- [Claude Code](https://claude.ai/code) CLI (optional, for terminal slash commands)

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/yunus-0x/meridian
cd meridian
npm install
```

### 2. Run the setup wizard

```bash
npm run setup
```

The wizard walks you through creating `.env` (API keys, wallet, RPC, Telegram) and `user-config.json` (risk preset, deploy size, thresholds, models). Takes about 2 minutes.

**Or set up manually:**

Create `.env`:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-...
HELIUS_API_KEY=your_helius_key                  # for wallet balance lookups
TELEGRAM_BOT_TOKEN=123456:ABC...                # optional — for notifications + chat
TELEGRAM_CHAT_ID=                               # required to receive Telegram commands
TELEGRAM_ALLOWED_USER_IDS=                      # comma-separated user IDs allowed to control the bot
DRY_RUN=true                                    # set false for live trading
```

> Never put your private key or API keys in `user-config.json` — use `.env` only. Both files are gitignored.

> Telegram auto-registration is **disabled** for security. You must set `TELEGRAM_CHAT_ID` explicitly. For group chats, also set `TELEGRAM_ALLOWED_USER_IDS` or inbound commands will be ignored.

Copy config and edit as needed:

```bash
cp user-config.example.json user-config.json
```

See [Config reference](#config-reference) below.

### 3. Run

```bash
npm run dev    # dry run — no on-chain transactions
npm start      # live mode
```

On startup Meridian fetches your wallet balance, open positions, and top pool candidates, then begins autonomous cycles immediately.

---

## Running modes

### Autonomous agent

```bash
npm start
```

Starts the full autonomous agent with cron-based screening + management cycles and an interactive REPL. The prompt shows a live countdown to the next cycle:

```
[manage: 8m 12s | screen: 24m 3s]
>
```

REPL commands:

| Command | Description |
|---|---|
| `1 / 2 / 3 ...` | Deploy into pool by list number |
| `auto` | Agent picks and deploys automatically |
| `go` | Start cron without deploying |
| `/status` | Wallet balance and open positions |
| `/candidates` | Re-screen and display top pool candidates |
| `/thresholds` | Current screening thresholds and performance stats |
| `/briefing` | Show last 24h briefing |
| `/bootstrap` | Import last 10 closed positions from Meteora API and learn from them |
| `/stop` | Graceful shutdown |
| `<anything>` | Free-form chat — ask the agent anything, request actions, analyze pools |

---

### Claude Code terminal (recommended)

Install [Claude Code](https://claude.ai/code) and use it from inside the meridian directory. Claude Code has built-in agents and slash commands that use the `meridian` CLI under the hood.

```bash
cd meridian
claude
```

#### Slash commands

| Command | What it does |
|---|---|
| `/screen` | Full AI screening cycle — checks Discord queue, reads config, fetches candidates, runs deep research, and deploys if a winner is found |
| `/manage` | Full AI management cycle — checks all positions, evaluates PnL, claims fees, closes OOR/losing positions |
| `/balance` | Check wallet SOL and token balances |
| `/positions` | List all open DLMM positions with range status |
| `/candidates` | Fetch and enrich top pool candidates (pool metrics + token audit + smart money) |
| `/pool-ohlcv` | Fetch price/volume history for a pool |
| `/pool-compare` | Compare all Meteora DLMM pools for a token pair by APR, fee/TVL ratio, and volume |

#### Claude Code agents

Two specialized sub-agents run inside Claude Code:

**`screener`** — pool screening specialist. Invoke when you want to evaluate candidates, analyse token risk, or deploy a position. Has access to OKX smart money signals, full token audit pipeline, and all strategy logic.

**`manager`** — position management specialist. Invoke when reviewing open positions, assessing PnL, claiming fees, or closing positions.

To trigger an agent directly, just describe what you want:
```
> screen for new pools and deploy if you find something good
> review all my positions and close anything out of range
> what do you think of the SOL/BONK pool?
```

#### Loop mode

Run screening or management on a timer inside Claude Code:

```
/loop 30m /screen     # screen every 30 minutes
/loop 10m /manage     # manage every 10 minutes
```

---

### CLI (direct tool invocation)

The `meridian` CLI gives you direct access to every tool with JSON output — useful for scripting, debugging, or piping into other tools.

```bash
npm install -g .   # install globally (once)
meridian <command> [flags]
```

Or run without installing:

```bash
node cli.js <command> [flags]
```

**Positions & PnL**

```bash
meridian positions
meridian pnl <position_address>
meridian wallet-positions --wallet <addr>
```

**Screening**

```bash
meridian candidates --limit 5
meridian pool-detail --pool <addr> [--timeframe 5m]
meridian active-bin --pool <addr>
meridian search-pools --query <name_or_symbol>
```

**Token research**

```bash
meridian token-info --query <mint_or_symbol>
meridian token-holders --mint <addr> [--limit 20]
meridian token-narrative --mint <addr>
```

**Deploy & manage**

```bash
meridian deploy --pool <addr> --amount <sol> [--bins-below 69] [--bins-above 0] [--strategy bid_ask|spot|curve] [--dry-run]
meridian claim --position <addr>
meridian close --position <addr> [--skip-swap] [--dry-run]
meridian swap --from <mint> --to <mint> --amount <n> [--dry-run]
meridian add-liquidity --position <addr> --pool <addr> [--amount-x <n>] [--amount-y <n>] [--strategy spot]
meridian withdraw-liquidity --position <addr> --pool <addr> [--bps 10000]
```

**Agent cycles**

```bash
meridian screen [--dry-run] [--silent]   # one AI screening cycle
meridian manage [--dry-run] [--silent]   # one AI management cycle
meridian start [--dry-run]               # start autonomous agent with cron jobs
```

**Config**

```bash
meridian config get
meridian config set <key> <value>
```

**Learning & memory**

```bash
meridian lessons
meridian lessons add "your lesson text"
meridian performance [--limit 200]
meridian pool-memory --pool <addr>
```

**Blacklist**

```bash
meridian blacklist list
meridian blacklist add --mint <addr> --reason "reason"
```

**Discord signals**

```bash
meridian discord-signals
meridian discord-signals clear
```

**Balance**

```bash
meridian balance
```

**Flags**

| Flag | Effect |
|---|---|
| `--dry-run` | Skip all on-chain transactions |
| `--silent` | Suppress Telegram notifications for this run |

---

## Discord listener

The Discord listener watches configured channels (e.g. LP Army) for Solana token calls and queues them as signals for the screener agent.

### Setup

```bash
cd discord-listener
npm install
```

Add to your root `.env`:

```env
DISCORD_USER_TOKEN=your_discord_account_token   # from browser DevTools → Network
DISCORD_GUILD_ID=the_server_id
DISCORD_CHANNEL_IDS=channel1,channel2            # comma-separated
DISCORD_MIN_FEES_SOL=5                           # minimum pool fees to pass pre-check
```

> This uses a selfbot (personal account automation, not a bot token). Use responsibly.

### Run

```bash
cd discord-listener
npm start
```

Or run it in a separate terminal alongside the main agent. Signals are written to `discord-signals.json` and picked up automatically by `/screen` and `node cli.js screen`.

### Signal pipeline

Each incoming token address passes through a pre-check pipeline before being queued:
1. **Dedup** — ignores addresses seen in the last 10 minutes
2. **Blacklist** — rejects blacklisted token mints
3. **Pool resolution** — resolves the address to a Meteora DLMM pool (tries direct pool address first, then DexScreener lookup by mint)
4. **Rug check** — checks deployer against `deployer-blacklist.json`
5. **Fees check** — rejects pools below `DISCORD_MIN_FEES_SOL`

Signals that pass all checks are queued with status `pending`. The screener picks up pending signals and processes them as priority candidates before running the normal screening cycle.

If a Discord signal fails deep research screening, its mint is automatically added to the blacklist to prevent re-processing.

### Deployer blacklist

Add known rug/farm deployer wallet addresses to `deployer-blacklist.json`:

```json
{
  "_note": "Known farm/rug deployers — add addresses to auto-reject their pools",
  "addresses": [
    "WaLLeTaDDressHere"
  ]
}
```

---

## Telegram

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add to `.env`:

```env
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<your chat id>
TELEGRAM_ALLOWED_USER_IDS=<comma-separated Telegram user IDs allowed to control the bot>
```

Security notes:
- If `TELEGRAM_CHAT_ID` is not set, inbound Telegram control is ignored entirely
- If the target chat is a group/supergroup and `TELEGRAM_ALLOWED_USER_IDS` is empty, inbound control is ignored
- Notifications still go to the configured chat, but command/control is restricted to allowed user IDs

### Notifications

Meridian sends notifications automatically for:
- Management cycle reports (reasoning + decisions)
- Screening cycle reports (what it found, whether it deployed)
- OOR alerts when a position leaves range past `outOfRangeWaitMinutes`
- Deploy: pair, amount, position address, tx hash
- Close: pair and PnL
- **Filtered pools** — any pool dropped during screening (launchpad rules, bot-holder limit, indicator filter) is notified with the reason:
  - Screening filters (launchpad / bots): one batched message per cycle listing all filtered names + reasons
  - Indicator hard filter (ATR/VWAP): immediate per-pool message when a deploy is blocked at execution time

### Telegram commands

| Command | Action |
|---|---|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set a note on a position |

You can also chat freely via Telegram using the same interface as the REPL.

---

## Config reference

All fields are optional — defaults shown. Edit `user-config.json`.

### Screening

| Field | Default | Description |
|---|---|---|
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio |
| `minTvl` | `10000` | Minimum pool TVL (USD) |
| `maxTvl` | `150000` | Maximum pool TVL (USD) |
| `minVolume` | `500` | Minimum pool volume |
| `minOrganic` | `60` | Minimum organic score (0–100) |
| `minHolders` | `500` | Minimum token holder count |
| `minMcap` | `150000` | Minimum market cap (USD) |
| `maxMcap` | `10000000` | Maximum market cap (USD) |
| `minBinStep` | `80` | Minimum bin step |
| `maxBinStep` | `125` | Maximum bin step |
| `timeframe` | `5m` | Candle timeframe for screening |
| `category` | `trending` | Pool category (`top`, `new`, `trending`) |
| `minTokenFeesSol` | `30` | Minimum all-time fees in SOL |
| `maxBundlePct` | `30` | Maximum bundler % in top 100 holders |
| `maxBotHoldersPct` | `30` | Maximum bot holder address % (Jupiter audit) |
| `maxTop10Pct` | `60` | Maximum top-10 holder concentration |
| `blockedLaunchpads` | `[]` | Launchpad names to never deploy into |
| `minTokenAgeHours` | `null` | Minimum token age in hours (null = no filter) |
| `maxTokenAgeHours` | `null` | Maximum token age in hours (null = no filter) |
| `athFilterPct` | `null` | Only deploy if price is ≥ X% below ATH (e.g. `-20`) |
| `maxPriceChangePct` | `null` | Skip pools where `price_change_pct` exceeds this value in the current timeframe (e.g. `8` = skip if price is up >8%). Prevents entering at pump peaks when using `bins_above=0`. `null` = disabled. |

### Management

| Field | Default | Description |
|---|---|---|
| `deployAmountSol` | `0.5` | Base SOL per new position — floor in fixed mode, ignored when `autoCompound=true` |
| `positionSizePct` | `0.35` | Fraction of deployable portfolio per position |
| `maxDeployAmount` | `50` | Maximum SOL cap per position |
| `gasReserve` | `0.2` | Minimum SOL to keep for gas (fixed mode only) |
| `minSolToOpen` | `0.55` | Minimum wallet SOL before opening new position |
| `maxPositions` | `3` | Maximum concurrent open positions |
| `autoCompound` | `false` | Portfolio-aware sizing — deploy amount scales with total portfolio (free SOL + locked positions). `deployAmountSol` floor is ignored. |
| `autoCompoundFeePct` | `0.02` | Reserve X% of total portfolio for tx fees in autoCompound mode |
| `bearMode` | `false` | Swap excess SOL → USDC after close/claim; auto-swap back before deploy. Protects against SOL depreciation. |
| `outOfRangeWaitMinutes` | `30` | Minutes OOR (upside) before closing |
| `downsideOorWaitMinutes` | `5` | Minutes OOR (downside) before closing — fast exit, recovery from below range is rare |
| `oorCooldownTriggerCount` | `3` | SL closes within 48h before token-level cooldown triggers |
| `oorCooldownHours` | `4` | Pool cooldown duration (hours) after a stop-loss close — prevents immediate re-entry into a crashing pool |
| `mintCooldownHours` | `24` | Token cooldown duration (hours) when the same token hits SL ≥ `oorCooldownTriggerCount` times within 48h — blocks all pools for that token |
| `stopLossPct` | `-20` | Close if PnL drops below this % (with 15s confirmation to filter data glitches) |
| `velocitySLEnabled` | `true` | Enable or disable velocity stop-loss entirely |
| `pnlVelocitySLPct` | `3` | Close if PnL drops X% within the velocity window — catches freefalls before hitting `stopLossPct` |
| `pnlVelocityWindowSec` | `90` | Rolling window in seconds for velocity SL measurement |
| `minAgeBeforeSL` | `7` | Minutes before any stop loss can trigger |
| `takeProfitFeePct` | `5` | Close when unclaimed fees reach X% of position value |
| `trailingTakeProfit` | `true` | Enable trailing take-profit |
| `trailingTriggerPct` | `3` | Activate trailing at X% PnL |
| `trailingDropPct` | `1.5` | Close when PnL drops X% from confirmed peak |
| `autoClaimPct` | `5` | Auto-claim when unclaimed fees ≥ X% of position value |
| `autoSwapAfterClaim` | `false` | Swap base token to SOL after claiming |
| `solMode` | `false` | Report positions and PnL in SOL instead of USD |
| `minFeePerTvl24h` | `7` | Minimum fee yield % per 24h before yield check can trigger close |
| `minAgeBeforeYieldCheck` | `90` | Minutes before low yield can trigger close |
| `minFeesEarnedForYieldExit` | `0.20` | Minimum unclaimed fees (USD) before low yield close can trigger |
| `llmConfirmExit` | `false` | Ask LLM to confirm or veto Rules 2–5 exits before executing. Adds ~1–3s per position. Uses fee velocity and pool memory as context. Default off — opt in when you want the LLM to have a say over hardcoded exits. |
| `llmConfirmRules` | `[2,3,4,"4b",5]` | Which rule numbers require LLM confirmation when `llmConfirmExit=true`. Remove rules you want to stay fully deterministic. |

### Strategy

| Field | Default | Description |
|---|---|---|
| `strategy` | `bid_ask` | LP distribution strategy (`bid_ask`, `spot`, `curve`) |
| `lpStrategyMode` | `auto` | How to pick bid_ask vs spot: `auto` (signal-based, LLM decides), `bid_ask` (always bid_ask), `spot` (always spot), `fee_tvl` (decide by fee/TVL ratio — see below) |
| `ftvlThreshold` | `1.2` | Fee/TVL threshold for `fee_tvl` mode: ≤ threshold → spot, > threshold → bid_ask. Always measured at 1h timeframe regardless of screening timeframe. |
| `binsBelow` | `69` | Bins below active bin (overrides volatility formula when set) |
| `targetDownsidePct` | `0.35` | Cover X% price drop below active bin |
| `targetUpsidePct` | `0.20` | Cover X% price rise above active bin (spot/curve only) |
| `dynamicBinsAbove` | `true` | When `true`, empty buffer bins above active bin are calculated dynamically from volatility + bin_step: `targetUpside = 0.04 + (vol/5) * 0.06`, natural max = 12 at vol=5/bs=80. No liquidity placed there, but `maxBinId` is extended upward so the OOR-above clock doesn't start until price pumps past the buffer. When `false`, no buffer (0 bins). |

#### Bins below — dynamic formula

When `binsBelow` is not set, the number of bins below the active bin is auto-calculated from pool volatility and the active strategy (`spot`/`curve` vs `bid_ask`):

Both strategies share the same cap (safety over density) — bid_ask uses a slightly lower base target but can extend just as wide:

**bid_ask**:
```
targetDownside = min(0.55, 0.38 + (vol / 5) × 0.09)
bins_below     = min(cap, calcBinsFromTarget(binStep, targetDownside))
```

| Volatility | Target downside | bs=80 bins | bs=100 bins | bs=125 bins |
|---|---|---|---|---|
| 0 | 38% | 52 | 49 | 34 |
| 2.5 | 42.5% | 59 | 56 | 38 |
| 5 | 47% | 67 | 64 | 41 (cap) |

**spot / curve** (slightly wider — data shows 95.2% range efficiency at >50 bins vs 80.6% at 46–50):
```
targetDownside = min(0.55, 0.42 + (vol / 5) × 0.09)
bins_below     = min(cap, calcBinsFromTarget(binStep, targetDownside))
```

| Volatility | Target downside | bs=80 bins | bs=100 bins | bs=125 bins |
|---|---|---|---|---|
| 0 | 42% | 58 | 55 | 37 |
| 2.5 | 46.5% | 67 | 63 | 40 |
| 5 | 51% | 70 (cap) | 69 | 42 (cap) |

Caps (both strategies): `bs ≥ 125` → 42, `bs < 125` → 70.

#### Support-based bins (hybrid)

In addition to the volatility formula, Meridian attempts to detect the nearest demand/support level below the current price using swing lows from OHLCV data, then takes the wider of the two estimates:

```
finalBinsBelow = max(formulaBinsBelow, supportBinsBelow)
```

Support detection uses a **cascade** of timeframes to handle both mature and new tokens:

| Timeframe | Candles | Min amplitude | Min swings | Notes |
|---|---|---|---|---|
| `1h` | 50 | 0% | 2 | Tried first — clearest structural levels |
| `15m` | 60 | 1.5% | 2 | Fallback — amplitude filter avoids micro-noise |
| `5m` | 60 | 3.0% | 3 | Last resort for new tokens — stricter quality gates |

Once a valid support is found on any timeframe, the cascade stops. Support distance + a 5% buffer sets the target:

```
targetPct      = min(support.distance_pct / 100 + 0.05, 0.65)
supportBins    = min(maxBinsBelow, calcBinsFromTarget(binStep, targetPct))
finalBinsBelow = max(formulaBinsBelow, supportBins)
```

This means bins_below is **never narrower than the formula** — support only extends it when structural price history suggests the floor is deeper than volatility alone implies. If OHLCV fetch fails or no swing lows are found, the formula result is used unchanged.

#### lpStrategyMode

Controls how the screener chooses between `bid_ask` and `spot` for each deployed position:

| Mode | Behaviour |
|---|---|
| `auto` | LLM picks based on pool signals (volatility, smart money, price momentum). Default. |
| `bid_ask` | Always use `bid_ask`, ignoring pool signals. |
| `spot` | Always use `spot`, ignoring pool signals. |
| `fee_tvl` | Rule-based: compare pool's 1h `fee_active_tvl_ratio` against `ftvlThreshold`. ≤ threshold → `spot`, > threshold → `bid_ask`. Based on 206-position backtest: fee/TVL ≥ 1.2 gives bid_ask a +1.59pp edge; fee/TVL < 0.6 gives spot a +1.20pp edge. |

The `fee_tvl` mode always fetches fee/TVL at **1h timeframe** to match the historical data lessons were derived from — regardless of what `timeframe` is configured for screening.

### Schedule

| Field | Default | Description |
|---|---|---|
| `managementIntervalMin` | `10` | Management cycle frequency (minutes) |
| `screeningIntervalMin` | `30` | Screening cycle frequency (minutes) |
| `healthCheckIntervalMin` | `60` | Health check frequency (minutes) |

### Models

| Field | Default | Description |
|---|---|---|
| `managementModel` | `openrouter/healer-alpha` | LLM for management cycles |
| `screeningModel` | `openrouter/healer-alpha` | LLM for screening cycles |
| `generalModel` | `openrouter/healer-alpha` | LLM for REPL / chat |

Override model at runtime:
```bash
node cli.js config set screeningModel anthropic/claude-opus-4-5
```

### Darwinian signal weighting

Automatically tracks which screening signals predict profitable positions and adjusts their weights over time. Signals that appear consistently in winners get boosted; signals associated with losers get decayed.

| Field | Default | Description |
|---|---|---|
| `darwinEnabled` | `true` | Enable Darwinian weighting |
| `darwinWindowDays` | `60` | Rolling window for weight calculation |
| `darwinRecalcEvery` | `5` | Recalculate weights every N closed positions |
| `darwinBoost` | `1.05` | Multiplier for winning signals |
| `darwinDecay` | `0.95` | Multiplier for losing signals |
| `darwinFloor` | `0.3` | Minimum signal weight |
| `darwinCeiling` | `2.5` | Maximum signal weight |
| `darwinMinSamples` | `10` | Minimum positions before adjusting a signal's weight |

---

## Entry timing (bins_above=0 / SOL-only strategy)

When deploying SOL-only (`bid_ask` or explicit `bins_above=0`), all liquidity sits **below** the current price. You earn fees only while price trades inside that range — so the ideal entry is a pullback, not a pump.

### Entry signal guidelines

| Condition | `price_change_pct` | Action |
|---|---|---|
| Healthy pullback | `-5%` to `-25%` | **PREFER** — liquidity sits below, ready to catch rebound |
| Flat / ranging | `-5%` to `+5%` | OK — fee farming while price consolidates |
| Still pumping | `> +8%` | **CAUTION** — may deploy OOR immediately; only acceptable with `smart_money_buy` + rising volume |
| Sharp dump | `< -30%` AND volume collapsing | **AVOID** — likely rug, not a recoverable dip |

The screener agent applies these heuristics automatically. You can also enforce the pump guard as a hard filter:

```bash
node cli.js config set maxPriceChangePct 8
```

This drops any pool from the candidate list where `price_change_pct` exceeds 8% in the current screening timeframe.

### Entry signal logging & backtest

Every deploy records the entry market state as a `signal_snapshot` (stored in `state.json` and forwarded to `lessons.json` when the position closes). Retrieve it via:

```bash
node cli.js performance --limit 50
```

Each closed position now includes an `entry_signals` block:

```json
{
  "pool_name": "TOKEN/SOL",
  "pnl_pct": 4.2,
  "range_efficiency": 78.3,
  "entry_signals": {
    "price_change_pct": -12.5,
    "volume_change_pct": 3.1,
    "smart_money_buy": true
  }
}
```

Use this to correlate which entry conditions (price dip depth, volume health, smart money presence) produced the best PnL and range efficiency over time.

---

## Exit system

Meridian uses multiple layers of protection running in parallel. A lightweight PnL poller runs every 10–12 seconds (randomised to avoid rate limits) and checks all layers between management cycles — exits fire immediately without waiting for the next scheduled cycle.

### Stop loss layers (priority order)

| Layer | Trigger | Confirmation | Mechanism |
|---|---|---|---|
| **Velocity SL** | PnL drops ≥ `pnlVelocitySLPct` (3%) within `pnlVelocityWindowSec` (90s) | None — direct close | In-memory history in 10–12s poller; catches freefalls before hitting absolute SL |
| **PnL SL** | `pnl_pct ≤ stopLossPct` (-20%) | 15s recheck — cancels if PnL recovers | Catches slow bleed that velocity SL misses |

All stop losses respect `minAgeBeforeSL` (7 min) to avoid false triggers on fresh positions where PnL data may be unstable.

### Take-profit layers

| Layer | Trigger | Notes |
|---|---|---|
| **Trailing TP** | PnL activates at `trailingTriggerPct` (3%), closes when drops `trailingDropPct` (1.5%) from confirmed peak | Suppresses static TP once active |
| **Static TP** | `unclaimed fees ≥ takeProfitFeePct` (5%) of position value | Acts as ceiling before trailing activates |

### OOR exits

| Rule | Trigger |
|---|---|
| Upside OOR | Active bin > upper bin for `outOfRangeWaitMinutes` (30m) before close |
| Downside OOR | Active bin < lower bin for `downsideOorWaitMinutes` (5m) — faster because recovery from below range is rare |
| Far above range | Active bin > upper bin + `outOfRangeBinsToClose` — closes immediately, no wait |

`dynamicBinsAbove` (default `true`) extends the upper bin boundary by N empty buffer bins calculated from volatility + bin_step — so the 30-min OOR-above clock only starts once price pumps past the buffer, giving extra time without placing any liquidity above. Max 12 bins at vol=5/bs=80; scales down for lower volatility or larger bin steps. Set to `false` to disable the buffer entirely.

---

## Deploy cooldown (re-entry protection)

After a position closes, Meridian applies cooldowns to prevent immediately re-entering the same pool or token while conditions are still bad.

### Pool-level cooldown

Applies to the specific pool address:

| Close reason | Cooldown |
|---|---|
| Velocity SL or PnL SL | `oorCooldownHours` (default **4h**) — pool was crashing, needs time to stabilise |
| Low yield (dead volume) | **2h** — wait for volume to rebuild |
| Upside OOR | **30 min** — price pumped past range; may pull back shortly |
| Downside OOR / take profit / manual | **None** — normal exits, re-entry allowed immediately |

### Token-level cooldown

Applies to the token mint across **all** pools — if the same token repeatedly SL-closes it's a chronic problem, not a pool-specific one.

| Condition | Cooldown |
|---|---|
| Token hits SL ≥ `oorCooldownTriggerCount` (3) times within 48h | `mintCooldownHours` (default **24h**) — block all pools for this token |

When a token is on cooldown, it is skipped during screening even if a different pool for that token looks attractive.

### Config keys

| Key | Default | Effect |
|---|---|---|
| `oorCooldownHours` | `4` | Pool cooldown after SL close |
| `mintCooldownHours` | `24` | Token cooldown after repeated SL closes |
| `oorCooldownTriggerCount` | `3` | SL count threshold within 48h before token cooldown fires |

---

## Auto-compound mode

When `autoCompound: true`, position sizing scales with your **total portfolio** — free wallet SOL plus the value locked in open positions — rather than just the free wallet balance.

```
totalPortfolio = walletSol + openPositionsValueSol
deployable     = totalPortfolio × (1 - autoCompoundFeePct)
deployAmount   = clamp(deployable × positionSizePct, 0, maxDeployAmount)
```

Example with 2.75 SOL free and 0.95 SOL locked in one position:

| Mode | Basis | Deploy (positionSizePct=0.35) |
|---|---|---|
| Fixed (`autoCompound=false`) | 2.75 SOL free | 0.95 SOL |
| Portfolio-aware (`autoCompound=true`) | 3.70 SOL total | 1.27 SOL |

The executor safety check still prevents deploying more than available free SOL — the computed amount is an intent, not an override.

---

## Bear mode

When `bearMode: true`, Meridian keeps profits in USDC instead of SOL to protect against SOL price depreciation.

**After `close_position` or `claim_fees`:**
- Base token → SOL (normal swap)
- Excess SOL → USDC (keeps `gasReserve` in SOL for gas)
- Minimum sweep: 0.05 SOL — smaller amounts skipped to avoid tx fees

**Before `deploy_position`:**
- If SOL balance is insufficient, auto-swaps USDC → SOL (just enough to cover deploy + gasReserve, with 2% slippage buffer)

**Screening:** accepts combined SOL + USDC value as available balance, so low SOL doesn't block new deploys when USDC is available.

---

## How it learns

### Lessons

After every closed position the agent records performance and can derive lessons. These are injected into subsequent agent cycles as part of the system context.

Add a lesson manually:
```bash
node cli.js lessons add "Never deploy into pump.fun tokens under 2h old"
```

---

## LLM intelligence

Meridian continuously feeds richer context to the LLM so it makes better decisions with each cycle.

### Pool history stats (SCREENER)

Every screening candidate now includes a trusted `pool_history` line computed from Meridian's own deploy records — not from LLM-generated notes:

```
pool_history: deploys=3, win_rate=67%, adj_win_rate=80%, avg_pnl=+2.3%, last=profit
```

The LLM uses this to prefer proven pools (win rate ≥ 80%, ≥ 3 deploys) and skip consistently bad ones.

`adj_win_rate` excludes OOR/pump exits — a cleaner quality signal than raw win rate for pools that occasionally get pumped out of range.

### Fee velocity (MANAGER)

Every management action block now includes a `fee_velocity` line showing how fast unclaimed fees are growing:

```
fee_velocity: $0.45/hr (accelerating, n=8)
```

| Trend | Meaning | LLM guidance |
|---|---|---|
| `accelerating` | Fees growing faster than before | Pool heating up — reconsider close if rule was yield-based |
| `stable` | Consistent fee rate | Proceed with rule as planned |
| `decelerating` | Fees slowing down | Pool dying — execute close decisively |

Velocity is calculated from the last ~12 position snapshots (~1 hour at 5-min intervals). Post-claim resets (fee counter drops to near 0) are automatically detected and excluded.

### Relevant lessons (context-aware)

Instead of injecting the same 50 lessons every cycle, lessons are now scored by relevance to the current pool's signals — strategy, volatility, price trend, volume, OOR state, and yield — and the top matches appear first in the `── RELEVANT ──` section.

The SCREENER also injects per-candidate `relevant_lessons` directly into each candidate block, so the LLM sees the most applicable historical lessons next to the pool it's evaluating:

```
relevant_lessons: AVOID: TOKEN/SOL-type pools (volatility=4, bid_ask) — OOR 70% of the time | PATTERN: Quick win (<2h hold, PnL +6.1%). Short-hold works for high-volume pools.
```

### Technical indicators at entry (SCREENER)

Every screening candidate now includes a live `indicators` line computed from the last 31 × 1h candles fetched in parallel during pool recon:

```
indicators: ema=uptrend, rsi=62.1, bb=near_upper, atr=12.3%, vwap_delta=+4.5%, consec_red=0, vol_spike=no
```

Indicators are also stored in `lessons.json` as `indicators_at_entry` when a position closes, building a historical dataset for pattern analysis.

**Signal interpretation (derived from 85-position backtest):**

| Indicator | Best zone | Worst zone |
|---|---|---|
| `ema_trend` | `uptrend` — WR 82%, avg +0.68% | `downtrend` — WR 64%, avg -0.76% |
| `rsi_14` | 55–80 — WR 81–83% | 45–55 neutral — WR 60% |
| `bb_position` | `near_upper` / `outside_upper` — 77–80% | `near_lower` / `outside_lower` — 50–75% |
| `atr_14_pct` | 5–15% — WR 81% | >30% — WR 57%, avg -3.06% |
| `vwap_delta` | near/above VWAP (≥−5%) — WR 79–90% | <−20% — WR 69%, avg -0.69% |
| `vol_spike` | YES — avg PnL 3× higher | — |

**Best entry combo:** `ema=uptrend` + `rsi>55` + `atr<30%` → WR 81%, avg PnL +0.71%

#### Indicator-based deploy filter

Before any `deploy_position` executes, the executor fetches fresh 1h indicators and blocks two extreme combinations that historically produce losses:

| Condition | Threshold | Historical outcome |
|---|---|---|
| EMA downtrend + ATR | > 40% | WR 50%, avg PnL −2.93% |
| EMA downtrend + VWAP delta | < −30% | WR 58%, avg PnL −1.21% |

Thresholds are deliberately conservative — both conditions must be met simultaneously. If the OHLCV fetch fails, deploy proceeds normally (non-fatal).

When a deploy is blocked, a Telegram notification is sent with the indicator values and historical context.

#### Backfill script

To enrich existing `lessons.json` performance records with indicators:

```bash
node scripts/backfill-indicators.js           # backfill all missing
node scripts/backfill-indicators.js --dry-run  # preview only
node scripts/backfill-indicators.js --force    # overwrite existing
```

Fetches 30 pre-entry 1h candles per record from the Meteora OHLCV API using `deployed_at` timestamps. Rate limited to ~2.5 RPS.

### LLM exit confirmation (opt-in)

By default, Rules 2–5 (take profit, far above range, OOR timeout, low yield) are hardcoded JS decisions — fast and deterministic. Enable `llmConfirmExit` to add an LLM gate before each close fires:

```json
{ "llmConfirmExit": true }
```

When enabled, the LLM receives the position's context — PnL, age, fee velocity, pool memory, the rule that triggered — and responds with `CONFIRM` or `VETO`. A veto converts the action to `STAY` for that cycle.

The LLM uses fee velocity to inform its decision: accelerating fees are a strong signal to veto a yield-based close; decelerating fees confirm the close is correct.

On LLM timeout or error, the gate defaults to `CONFIRM` — positions are never stuck open by infrastructure failures.

---

## Hive Mind (optional)

Opt-in collective intelligence — share lessons and pool outcomes, receive crowd wisdom from other Meridian agents.

**What you get:** Pool consensus ("8 agents deployed here, 72% win rate"), strategy rankings, threshold medians.

**What you share:** Lessons, deploy outcomes, screening thresholds. No wallet addresses, private keys, or balances are ever sent. Agent IDs are anonymous UUIDs.

### Setup

```bash
node -e "import('./hive-mind.js').then(m => m.register('https://meridian-hive-api-production.up.railway.app', 'YOUR_TOKEN'))"
```

Credentials are saved to `user-config.json` automatically.

### Disable

```json
{
  "hiveMindUrl": "",
  "hiveMindApiKey": ""
}
```

---

## Using a local model (LM Studio)

```env
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-local-model-name
```

Any OpenAI-compatible endpoint works. Set `maxOutputTokens` to at least 2048 — free models with lower limits will produce empty responses.

---

## Architecture

```
index.js              Main entry: REPL + cron orchestration + Telegram bot polling
agent.js              ReAct loop: LLM → tool call → repeat
config.js             Runtime config from user-config.json + .env
prompt.js             System prompt builder (SCREENER / MANAGER / GENERAL roles)
state.js              Position registry (state.json)
lessons.js            Learning engine: records performance, derives lessons
signal-weights.js     Darwinian signal weighting: boosts/decays signals based on outcomes
pool-memory.js        Per-pool deploy history + snapshots
strategy-library.js   Saved LP strategies
telegram.js           Telegram bot: polling + notifications
hive-mind.js          Optional collective intelligence server sync
smart-wallets.js      KOL/alpha wallet tracker
token-blacklist.js    Permanent token blacklist
cli.js                Direct CLI — every tool as a subcommand with JSON output

tools/
  definitions.js      Tool schemas (OpenAI format)
  executor.js         Tool dispatch + safety checks + indicator hard filter
  dlmm.js             Meteora DLMM SDK wrapper
  screening.js        Pool discovery + scoring
  wallet.js           SOL/token balances + Jupiter swap
  token.js            Token info, holders, bundler detection
  indicators.js       Pure technical indicator calculations (RSI, BB, VWAP, ATR, EMA, volume spike)

scripts/
  backfill-indicators.js  Backfill indicators_at_entry for existing lessons.json records

discord-listener/
  index.js            Selfbot Discord listener
  pre-checks.js       Signal pre-check pipeline (dedup → blacklist → pool resolve → rug → fees)

.claude/
  agents/
    screener.md       Claude Code screener sub-agent
    manager.md        Claude Code manager sub-agent
  commands/
    screen.md         /screen slash command
    manage.md         /manage slash command
    balance.md        /balance slash command
    positions.md      /positions slash command
    candidates.md     /candidates slash command
    pool-ohlcv.md     /pool-ohlcv slash command
    pool-compare.md   /pool-compare slash command
```

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.
