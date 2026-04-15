/**
 * Pool memory — persistent deploy history per pool.
 *
 * Keyed by pool address. Automatically updated when positions close
 * (via recordPerformance in lessons.js). Agent can query before deploying.
 */

import fs from "fs";
import { log } from "./logger.js";
import { config } from "./config.js";

const POOL_MEMORY_FILE = "./pool-memory.json";
const MAX_NOTE_LENGTH = 280;

function sanitizeStoredNote(text, maxLen = MAX_NOTE_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(POOL_MEMORY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(POOL_MEMORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(POOL_MEMORY_FILE, JSON.stringify(data, null, 2));
}

function isOorCloseReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text === "oor" || text.includes("out of range") || text.includes("oor");
}

function isUpsideOorCloseReason(reason) {
  const text = String(reason || "").toLowerCase();
  return text.includes("pump") || text.includes("upside") || text.includes("above range");
}

function isLowYieldCloseReason(reason) {
  return String(reason || "").toLowerCase().includes("low yield");
}

function isSlCloseReason(reason) {
  const text = String(reason || "").toLowerCase();
  return text.includes("velocity sl") || text.includes("price-drop sl");
}

function isAdjustedWinRateExcludedReason(reason) {
  const text = String(reason || "").trim().toLowerCase();
  return text.includes("out of range") ||
    text.includes("pumped far above range") ||
    text === "oor" ||
    text.includes("oor");
}

function setPoolCooldown(entry, hours, reason) {
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  entry.cooldown_until = cooldownUntil;
  entry.cooldown_reason = reason;
  return cooldownUntil;
}

function setBaseMintCooldown(db, baseMint, hours, reason) {
  if (!baseMint) return null;
  const cooldownUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  for (const entry of Object.values(db)) {
    if (entry?.base_mint === baseMint) {
      entry.base_mint_cooldown_until = cooldownUntil;
      entry.base_mint_cooldown_reason = reason;
    }
  }
  return cooldownUntil;
}

// ─── Write ─────────────────────────────────────────────────────

/**
 * Record a closed deploy into pool-memory.json.
 * Called automatically from recordPerformance() in lessons.js.
 *
 * @param {string} poolAddress
 * @param {Object} deployData
 * @param {string} deployData.pool_name
 * @param {string} deployData.base_mint
 * @param {string} deployData.deployed_at
 * @param {string} deployData.closed_at
 * @param {number} deployData.pnl_pct
 * @param {number} deployData.pnl_usd
 * @param {number} deployData.range_efficiency
 * @param {number} deployData.minutes_held
 * @param {string} deployData.close_reason
 * @param {string} deployData.strategy
 * @param {number} deployData.volatility
 */
export function recordPoolDeploy(poolAddress, deployData) {
  if (!poolAddress) return;

  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: deployData.pool_name || poolAddress.slice(0, 8),
      base_mint: deployData.base_mint || null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  const entry = db[poolAddress];

  const deploy = {
    deployed_at: deployData.deployed_at || null,
    closed_at: deployData.closed_at || new Date().toISOString(),
    pnl_pct: deployData.pnl_pct ?? null,
    pnl_usd: deployData.pnl_usd ?? null,
    range_efficiency: deployData.range_efficiency ?? null,
    minutes_held: deployData.minutes_held ?? null,
    close_reason: deployData.close_reason || null,
    strategy: deployData.strategy || null,
    volatility_at_deploy: deployData.volatility ?? null,
    price_vs_ath_pct: deployData.price_vs_ath_pct ?? null,
  };

  entry.deploys.push(deploy);
  entry.total_deploys = entry.deploys.length;
  entry.last_deployed_at = deploy.closed_at;
  entry.last_outcome = (deploy.pnl_pct ?? 0) >= 0 ? "profit" : "loss";

  // Recompute aggregates
  const withPnl = entry.deploys.filter((d) => d.pnl_pct != null);
  if (withPnl.length > 0) {
    entry.avg_pnl_pct = Math.round(
      (withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length) * 100
    ) / 100;
    entry.win_rate = Math.round(
      (withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length) * 100
    ) / 100;
  }
  const adjusted = withPnl.filter((d) => !isAdjustedWinRateExcludedReason(d.close_reason));
  entry.adjusted_win_rate_sample_count = adjusted.length;
  entry.adjusted_win_rate = adjusted.length > 0
    ? Math.round((adjusted.filter((d) => d.pnl_pct >= 0).length / adjusted.length) * 10000) / 100
    : 0;

  if (deployData.base_mint && !entry.base_mint) {
    entry.base_mint = deployData.base_mint;
  }

  // ── Cooldown rules ──────────────────────────────────────────────────────
  // Rule 1: Velocity/Price-drop SL → oorCooldownHours (default 4h) — token was crashing, needs stabilisation
  if (isSlCloseReason(deploy.close_reason)) {
    const slHours = config.management.oorCooldownHours ?? 4;
    const cooldownUntil = setPoolCooldown(entry, slHours, "velocity/price-drop SL");
    log("pool-memory", `Cooldown ${slHours}h set for ${entry.name} until ${cooldownUntil} (SL close)`);

    // Base mint cooldown: if this token SL'd >= oorCooldownTriggerCount times in last 48h
    // across all pools → token is consistently problematic, block it everywhere
    const baseMint = deployData.base_mint || entry.base_mint;
    if (baseMint) {
      const triggerCount = config.management.oorCooldownTriggerCount ?? 3;
      const windowMs = 48 * 60 * 60 * 1000;
      const recentSlCount = Object.values(db).reduce((sum, e) => {
        if (e?.base_mint !== baseMint) return sum;
        return sum + (e.deploys || []).filter(d =>
          isSlCloseReason(d.close_reason) &&
          d.closed_at &&
          (Date.now() - new Date(d.closed_at).getTime()) < windowMs
        ).length;
      }, 0);
      if (recentSlCount >= triggerCount) {
        const mintHours = config.management.mintCooldownHours ?? 24;
        setBaseMintCooldown(db, baseMint, mintHours, `${recentSlCount} SL closes in 48h`);
        log("pool-memory", `Token cooldown ${mintHours}h set for mint ${baseMint.slice(0, 8)} (${recentSlCount} SL closes in 48h)`);
      }
    }

  // Rule 2: Low yield → 2h (pool dry, wait for volume to rebuild)
  } else if (isLowYieldCloseReason(deploy.close_reason)) {
    const cooldownUntil = setPoolCooldown(entry, 2, "low yield");
    log("pool-memory", `Cooldown 2h set for ${entry.name} until ${cooldownUntil} (low yield close)`);

  // Rule 3: Upside OOR → 30min flat (price pumped past range, wait for price to settle)
  //         Downside OOR → no cooldown (normal retracement, often recovers)
  } else if (isUpsideOorCloseReason(deploy.close_reason)) {
    const cooldownUntil = setPoolCooldown(entry, 0.5, "upside OOR");
    log("pool-memory", `Cooldown 30min set for ${entry.name} until ${cooldownUntil} (upside OOR)`);
  }

  save(db);
  log("pool-memory", `Recorded deploy for ${entry.name} (${poolAddress.slice(0, 8)}): PnL ${deploy.pnl_pct}%`);
}

export function isPoolOnCooldown(poolAddress) {
  if (!poolAddress) return false;
  const db = load();
  const entry = db[poolAddress];
  if (!entry?.cooldown_until) return false;
  return new Date(entry.cooldown_until) > new Date();
}

export function isBaseMintOnCooldown(baseMint) {
  if (!baseMint) return false;
  const db = load();
  const now = new Date();
  return Object.values(db).some((entry) =>
    entry?.base_mint === baseMint &&
    entry?.base_mint_cooldown_until &&
    new Date(entry.base_mint_cooldown_until) > now
  );
}

// ─── Read ──────────────────────────────────────────────────────

/**
 * Tool handler: get_pool_memory
 * Returns deploy history and summary for a pool.
 */
export function getPoolMemory({ pool_address }) {
  if (!pool_address) return { error: "pool_address required" };

  const db = load();
  const entry = db[pool_address];

  if (!entry) {
    return {
      pool_address,
      known: false,
      message: "No history for this pool — first time deploying here.",
    };
  }

  return {
    pool_address,
    known: true,
    name: entry.name,
    base_mint: entry.base_mint,
    total_deploys: entry.total_deploys,
    avg_pnl_pct: entry.avg_pnl_pct,
    win_rate: entry.win_rate,
    adjusted_win_rate: entry.adjusted_win_rate ?? 0,
    adjusted_win_rate_sample_count: entry.adjusted_win_rate_sample_count ?? 0,
    last_deployed_at: entry.last_deployed_at,
    last_outcome: entry.last_outcome,
    cooldown_until: entry.cooldown_until || null,
    cooldown_reason: entry.cooldown_reason || null,
    base_mint_cooldown_until: entry.base_mint_cooldown_until || null,
    base_mint_cooldown_reason: entry.base_mint_cooldown_reason || null,
    notes: entry.notes,
    history: entry.deploys.slice(-10), // last 10 deploys
  };
}

/**
 * Record a live position snapshot during a management cycle.
 * Builds a trend dataset while position is still open — not just at close.
 * Keeps last 48 snapshots per pool (~4h at 5min intervals).
 */
export function recordPositionSnapshot(poolAddress, snapshot) {
  if (!poolAddress) return;
  const db = load();

  if (!db[poolAddress]) {
    db[poolAddress] = {
      name: snapshot.pair || poolAddress.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      adjusted_win_rate: 0,
      adjusted_win_rate_sample_count: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
      snapshots: [],
    };
  }

  if (!db[poolAddress].snapshots) db[poolAddress].snapshots = [];

  db[poolAddress].snapshots.push({
    ts: new Date().toISOString(),
    position: snapshot.position,
    pnl_pct: snapshot.pnl_pct ?? null,
    pnl_usd: snapshot.pnl_usd ?? null,
    in_range: snapshot.in_range ?? null,
    unclaimed_fees_usd: snapshot.unclaimed_fees_usd ?? null,
    minutes_out_of_range: snapshot.minutes_out_of_range ?? null,
    age_minutes: snapshot.age_minutes ?? null,
  });

  // Keep last 48 snapshots (~4h at 5min intervals)
  if (db[poolAddress].snapshots.length > 48) {
    db[poolAddress].snapshots = db[poolAddress].snapshots.slice(-48);
  }

  save(db);
}

/**
 * Recall focused context for a specific pool — used before screening or management.
 * Returns a short formatted string ready for injection into the agent goal.
 */
export function recallForPool(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry) return null;

  const lines = [];

  // Deploy history summary
  if (entry.total_deploys > 0) {
    lines.push(`POOL MEMORY [${entry.name}]: ${entry.total_deploys} past deploy(s), avg PnL ${entry.avg_pnl_pct}%, win rate ${entry.win_rate}%, last outcome: ${entry.last_outcome}`);
  }

  if (entry.cooldown_until && new Date(entry.cooldown_until) > new Date()) {
    lines.push(`POOL COOLDOWN: active until ${entry.cooldown_until}${entry.cooldown_reason ? ` (${entry.cooldown_reason})` : ""}`);
  }

  if (entry.base_mint_cooldown_until && new Date(entry.base_mint_cooldown_until) > new Date()) {
    lines.push(`TOKEN COOLDOWN: active until ${entry.base_mint_cooldown_until}${entry.base_mint_cooldown_reason ? ` (${entry.base_mint_cooldown_reason})` : ""}`);
  }

  // Recent snapshot trend (last 6 = ~30min)
  const snaps = (entry.snapshots || []).slice(-6);
  if (snaps.length >= 2) {
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const pnlTrend = last.pnl_pct != null && first.pnl_pct != null
      ? (last.pnl_pct - first.pnl_pct).toFixed(2)
      : null;
    const oorCount = snaps.filter(s => s.in_range === false).length;
    lines.push(`RECENT TREND: PnL drift ${pnlTrend !== null ? (pnlTrend >= 0 ? "+" : "") + pnlTrend + "%" : "unknown"} over last ${snaps.length} cycles, OOR in ${oorCount}/${snaps.length} cycles`);
  }

  // Notes
  if (entry.notes?.length > 0) {
    const lastNote = entry.notes[entry.notes.length - 1];
    const safeNote = sanitizeStoredNote(lastNote.note);
    if (safeNote) lines.push(`NOTE: ${safeNote}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Compute a deterministic strategy recommendation for a pool before deploy.
 *
 * Priority order (highest wins):
 *  1. smart_money_buy signal         → bid_ask (hard override)
 *  2. Pool history: conflicting data → use whichever strategy has better avg PnL on this pool
 *  3. Volatility rule                → >= 3.0 = bid_ask; < 2.5 = consider spot
 *  4. Price momentum                 → |price_change_pct| > 3% = bid_ask
 *  5. Fee farming signal             → fee_tvl_ratio >= 0.8 AND vol < 2.5 AND no momentum = spot
 *  6. Default                        → bid_ask
 *
 * @param {string|null} poolAddress
 * @param {Object} signals
 * @param {boolean} [signals.smart_money_buy]
 * @param {number}  [signals.volatility]         0–10 scale
 * @param {number}  [signals.fee_tvl_ratio]
 * @param {number}  [signals.price_change_pct]   % change over recent period
 * @returns {{ strategy: "bid_ask"|"spot", reason: string, confidence: "high"|"medium"|"low" }}
 */
export function computeStrategyRecommendation(poolAddress, signals = {}) {
  const {
    smart_money_buy = false,
    volatility = 2.5,
    fee_tvl_ratio = 0,
    price_change_pct: _price_change_pct = null,
  } = signals;
  const price_change_pct = _price_change_pct != null ? parseFloat(_price_change_pct) : null;

  // Priority 1: smart money
  if (smart_money_buy) {
    return { strategy: "bid_ask", reason: "smart_money_buy signal present — directional momentum", confidence: "high" };
  }

  // Priority 2: pool history analysis
  if (poolAddress) {
    const db = load();
    const entry = db[poolAddress];
    if (entry?.deploys?.length >= 2) {
      const byStrategy = { bid_ask: [], spot: [] };
      for (const d of entry.deploys) {
        if (d.strategy && d.pnl_pct != null) {
          byStrategy[d.strategy]?.push(d.pnl_pct);
        }
      }
      const bidAskAvg = byStrategy.bid_ask.length
        ? byStrategy.bid_ask.reduce((s, v) => s + v, 0) / byStrategy.bid_ask.length
        : null;
      const spotAvg = byStrategy.spot.length
        ? byStrategy.spot.reduce((s, v) => s + v, 0) / byStrategy.spot.length
        : null;

      // Both strategies tried — pick the winner
      if (bidAskAvg !== null && spotAvg !== null) {
        if (bidAskAvg > spotAvg + 2) {
          return {
            strategy: "bid_ask",
            reason: `pool history: bid_ask avg ${bidAskAvg.toFixed(1)}% vs spot avg ${spotAvg.toFixed(1)}% on ${entry.name}`,
            confidence: "high",
          };
        }
        if (spotAvg > bidAskAvg + 2 && byStrategy.spot.length >= 2) {
          return {
            strategy: "spot",
            reason: `pool history: spot avg ${spotAvg.toFixed(1)}% vs bid_ask avg ${bidAskAvg.toFixed(1)}% on ${entry.name} (${byStrategy.spot.length} wins)`,
            confidence: "high",
          };
        }
      }

      // Only spot tried and it consistently lost → force bid_ask
      if (spotAvg !== null && bidAskAvg === null && spotAvg < 0) {
        return {
          strategy: "bid_ask",
          reason: `pool history: spot avg ${spotAvg.toFixed(1)}% — trying bid_ask instead`,
          confidence: "medium",
        };
      }
    }
  }

  // Priority 3: volatility rule
  const hasMomentum = price_change_pct != null && Math.abs(price_change_pct) > 3;

  if (volatility >= 3.0) {
    return {
      strategy: "bid_ask",
      reason: `volatility ${volatility.toFixed(1)} >= 3.0 — directional strategy preferred`,
      confidence: "high",
    };
  }

  // Priority 4: price momentum
  if (hasMomentum) {
    return {
      strategy: "bid_ask",
      reason: `price_change_pct ${price_change_pct > 0 ? "+" : ""}${price_change_pct.toFixed(1)}% — active momentum favors bid_ask`,
      confidence: "medium",
    };
  }

  // Priority 5: fee farming signal (low vol, high fee, no momentum)
  if (volatility < 2.5 && fee_tvl_ratio >= 0.8) {
    return {
      strategy: "spot",
      reason: `low volatility (${volatility.toFixed(1)}) + high fee/tvl (${fee_tvl_ratio.toFixed(2)}) + no price momentum — fee farming profile`,
      confidence: "medium",
    };
  }

  // Default
  return { strategy: "bid_ask", reason: "default — no strong spot signal detected", confidence: "low" };
}

/**
 * Returns a compact trusted stats string for SCREENER candidate blocks.
 * Computed from our own aggregates — never LLM/user-generated text, safe to inject without sanitization.
 */
export function getPoolMemoryStats(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  if (!entry || entry.total_deploys === 0) return null;

  const parts = [
    `deploys=${entry.total_deploys}`,
    `win_rate=${entry.win_rate}%`,
  ];
  if (entry.adjusted_win_rate_sample_count >= 2) {
    parts.push(`adj_win_rate=${entry.adjusted_win_rate}%`);
  }
  if (entry.avg_pnl_pct != null) {
    parts.push(`avg_pnl=${entry.avg_pnl_pct >= 0 ? "+" : ""}${entry.avg_pnl_pct}%`);
  }
  if (entry.last_outcome) parts.push(`last=${entry.last_outcome}`);
  return parts.join(", ");
}

/**
 * Calculate fee accumulation velocity from recent position snapshots.
 * Detects if fees are accelerating, stable, or decelerating — useful for hold/close decisions.
 * Returns { usd_per_hour, trend: "accelerating"|"stable"|"decelerating", sample_count } or null.
 */
export function getFeeVelocity(poolAddress) {
  if (!poolAddress) return null;
  const db = load();
  const entry = db[poolAddress];
  const allSnaps = (entry?.snapshots || []).filter(s => s.unclaimed_fees_usd != null);
  if (allSnaps.length < 3) return null;

  // Use last 12 snapshots (~1h at 5min intervals)
  const window = allSnaps.slice(-12);

  // Guard: skip values before last fee-claim reset (near-zero value = fees were claimed)
  const resetIdx = window.reduceRight((found, s, i) =>
    found === -1 && s.unclaimed_fees_usd < 0.01 ? i : found, -1);
  const safeWindow = resetIdx >= 0 ? window.slice(resetIdx + 1) : window;
  if (safeWindow.length < 3) return null;

  const oldest = safeWindow[0];
  const newest = safeWindow[safeWindow.length - 1];
  const feeGain = newest.unclaimed_fees_usd - oldest.unclaimed_fees_usd;
  const elapsedMs = new Date(newest.ts).getTime() - new Date(oldest.ts).getTime();
  if (elapsedMs <= 0) return null;

  const usd_per_hour = (feeGain / elapsedMs) * 3_600_000;

  // Detect acceleration vs deceleration by comparing two halves of the window
  const mid = Math.floor(safeWindow.length / 2);
  const firstHalf = safeWindow.slice(0, mid);
  const secondHalf = safeWindow.slice(mid);

  function halfRate(half) {
    if (half.length < 2) return 0;
    const dt = new Date(half[half.length - 1].ts).getTime() - new Date(half[0].ts).getTime();
    if (dt <= 0) return 0;
    return (half[half.length - 1].unclaimed_fees_usd - half[0].unclaimed_fees_usd) / dt;
  }

  const r1 = halfRate(firstHalf);
  const r2 = halfRate(secondHalf);
  const trend = r2 > r1 * 1.25 ? "accelerating"
    : r2 < r1 * 0.75 ? "decelerating"
    : "stable";

  return {
    usd_per_hour: Math.round(usd_per_hour * 100) / 100,
    trend,
    sample_count: safeWindow.length,
  };
}

/**
 * Tool handler: add_pool_note
 * Agent can annotate a pool with a freeform note.
 */
export function addPoolNote({ pool_address, note }) {
  if (!pool_address) return { error: "pool_address required" };
  const safeNote = sanitizeStoredNote(note);
  if (!safeNote) return { error: "note required" };

  const db = load();

  if (!db[pool_address]) {
    db[pool_address] = {
      name: pool_address.slice(0, 8),
      base_mint: null,
      deploys: [],
      total_deploys: 0,
      avg_pnl_pct: 0,
      win_rate: 0,
      last_deployed_at: null,
      last_outcome: null,
      notes: [],
    };
  }

  db[pool_address].notes.push({
    note: safeNote,
    added_at: new Date().toISOString(),
  });

  save(db);
  log("pool-memory", `Note added to ${pool_address.slice(0, 8)}: ${safeNote}`);
  return { saved: true, pool_address, note: safeNote };
}
