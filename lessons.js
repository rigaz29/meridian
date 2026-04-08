/**
 * Agent learning system.
 *
 * After each position closes, performance is analyzed, enriched with
 * on-chain data from Meteora API (price action, volume, pool context),
 * and lessons are derived. These lessons are injected into the system
 * prompt so the agent avoids repeating mistakes and doubles down on
 * what works.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { enrichPosition, fetchAndEnrichClosedPositions } from "./meteora-api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const LESSONS_FILE = "./lessons.json";
const MIN_EVOLVE_POSITIONS = 5;
const MAX_CHANGE_PER_STEP  = 0.20;
const MAX_MANUAL_LESSON_LENGTH = 400;

function sanitizeLessonText(text, maxLen = MAX_MANUAL_LESSON_LENGTH) {
  if (text == null) return null;
  return String(text).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").replace(/[<>`]/g, "").trim().slice(0, maxLen) || null;
}

function load() {
  if (!fs.existsSync(LESSONS_FILE)) return { lessons: [], performance: [] };
  try { return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8")); } catch { return { lessons: [], performance: [] }; }
}

function save(data) { fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2)); }

// ─── Record Position Performance ──────────────────────────────

export async function recordPerformance(perf) {
  const data = load();

  const suspiciousUnitMix =
    Number.isFinite(perf.initial_value_usd) && Number.isFinite(perf.final_value_usd) &&
    Number.isFinite(perf.amount_sol) && perf.initial_value_usd >= 20 &&
    perf.amount_sol >= 0.25 && perf.final_value_usd > 0 &&
    perf.final_value_usd <= perf.amount_sol * 2;

  if (suspiciousUnitMix) {
    log("lessons_warn", `Skipped suspicious performance record for ${perf.pool_name || perf.pool}: initial=${perf.initial_value_usd}, final=${perf.final_value_usd}, amount_sol=${perf.amount_sol}`);
    return;
  }

  const pnl_usd = (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0 ? (pnl_usd / perf.initial_value_usd) * 100 : 0;
  const range_efficiency = perf.minutes_held > 0 ? (perf.minutes_in_range / perf.minutes_held) * 100 : 0;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  if (Number.isFinite(pnl_pct) && perf.initial_value_usd >= 20 && pnl_pct <= -90 && !closeReasonText.includes("stop loss")) {
    log("lessons_warn", `Skipped absurd closed PnL record for ${perf.pool_name || perf.pool}: pnl_pct=${pnl_pct.toFixed(2)} reason=${perf.close_reason}`);
    return;
  }

  let entry = {
    ...perf,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    duration_hours: perf.minutes_held > 0 ? Math.round((perf.minutes_held / 60) * 10) / 10 : null,
    recorded_at: new Date().toISOString(),
  };

  // ── Enrich with Meteora API data ───────────────────────────
  try {
    entry = await enrichFromMeteora(entry);
    log("lessons", `Enriched position ${perf.pool_name || perf.pool} with Meteora data`);
  } catch (err) {
    log("lessons_warn", `Meteora enrichment failed for ${perf.pool_name || perf.pool}: ${err.message}`);
  }

  data.performance.push(entry);
  // Rolling window — keep last 500 records to prevent unbounded file growth
  if (data.performance.length > 500) data.performance = data.performance.slice(-500);

  const lesson = derivLesson(entry);
  if (lesson) { data.lessons.push(lesson); log("lessons", `New lesson: ${lesson.rule}`); }
  save(data);

  // Update pool-level memory
  if (perf.pool) {
    const { recordPoolDeploy } = await import("./pool-memory.js");
    recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name, base_mint: perf.base_mint,
      deployed_at: perf.deployed_at, closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct, pnl_usd: entry.pnl_usd,
      range_efficiency: entry.range_efficiency, minutes_held: perf.minutes_held,
      close_reason: perf.close_reason, strategy: perf.strategy,
      volatility: perf.volatility,
      price_change_pct: entry.price_change_pct,
      pool_tvl_usd: entry.pool_tvl_usd,
      volume_trend: entry.volume_trend,
    });
  }

  // Evolve thresholds every 5 closed positions
  if (data.performance.length % MIN_EVOLVE_POSITIONS === 0) {
    const { config, reloadScreeningThresholds } = await import("./config.js");
    const result = evolveThresholds(data.performance, config);
    if (result?.changes && Object.keys(result.changes).length > 0) {
      reloadScreeningThresholds();
      log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
    }
    if (config.darwin?.enabled) {
      const { recalculateWeights } = await import("./signal-weights.js");
      const wResult = recalculateWeights(data.performance, config);
      if (wResult.changes.length > 0) log("evolve", `Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
    }
  }

  import("./hive-mind.js").then(m => m.syncToHive()).catch(() => {});
}

// ─── Meteora API Enrichment ───────────────────────────────────

async function enrichFromMeteora(entry) {
  const enriched = await enrichPosition({
    position: entry.position, pool: entry.pool,
    deployed_at: entry.deployed_at, created_at: entry.deployed_at || entry.recorded_at,
    closed_at: entry.recorded_at, recorded_at: entry.recorded_at,
  });

  const fields = [
    "price_at_entry", "price_at_exit", "price_change_pct",
    "price_max", "price_min", "price_range_pct", "price_max_drawdown_pct",
    "pool_tvl_usd", "pool_base_fee", "pool_cumulative_volume",
    "avg_volume_per_candle", "total_volume_during", "volume_trend",
    "event_count_deposits", "event_count_withdraws", "event_count_claims",
    "total_events", "minutes_to_first_withdraw",
    "_candle_count", "_candle_timeframe", "_pool_snapshot", "_enriched_at",
  ];
  for (const f of fields) { if (enriched[f] != null && entry[f] == null) entry[f] = enriched[f]; }
  return entry;
}

// ─── Derive Lesson (Enhanced) ─────────────────────────────────

function derivLesson(perf) {
  const tags = [];
  const outcome = perf.pnl_pct >= 5 ? "good" : perf.pnl_pct >= 0 ? "neutral" : perf.pnl_pct >= -5 ? "poor" : "bad";
  if (outcome === "neutral") return null;

  const context = [
    `${perf.pool_name}`, `strategy=${perf.strategy}`, `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`, `fee_tvl_ratio=${perf.fee_tvl_ratio}`,
    `organic=${perf.organic_score}`,
    `bin_range=${typeof perf.bin_range === 'object' ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
  ].join(", ");

  let rule = "";

  if (outcome === "good" || outcome === "bad") {
    if (perf.range_efficiency < 30 && outcome === "bad") {
      rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — OOR ${Math.round(100 - perf.range_efficiency)}% of the time.`;
      if (isFiniteNum(perf.price_range_pct)) rule += ` Price swung ${perf.price_range_pct}% — consider wider bin_range or bid_ask strategy.`;
      tags.push("oor", perf.strategy, `volatility_${Math.round(perf.volatility || 0)}`);

    } else if (perf.range_efficiency > 80 && outcome === "good") {
      rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — ${perf.range_efficiency}% in-range, PnL +${perf.pnl_pct}%.`;
      if (perf.duration_hours) rule += ` Held ${perf.duration_hours}h.`;
      tags.push("efficient", perf.strategy);

    } else if (outcome === "bad" && isFiniteNum(perf.price_change_pct) && perf.price_change_pct < -15) {
      rule = `AVOID_ENTRY: Price dropped ${Math.abs(perf.price_change_pct).toFixed(1)}% during ${perf.pool_name} position.`;
      if (isFiniteNum(perf.price_max_drawdown_pct)) rule += ` Max drawdown ${Math.abs(perf.price_max_drawdown_pct).toFixed(1)}% from peak.`;
      rule += ` Check price trend before entry — avoid deploying into active downtrend.`;
      tags.push("price_dump", "timing", "entry");

    } else if (outcome === "bad" && isFiniteNum(perf.volume_trend) && perf.volume_trend < -50) {
      rule = `AVOID: ${perf.pool_name} showed ${Math.abs(perf.volume_trend).toFixed(0)}% volume decline during position. Fee earnings evaporated. Check volume sustainability before deploying.`;
      tags.push("volume_collapse", "screening");

    } else if (outcome === "good" && isFiniteNum(perf.volume_trend) && perf.volume_trend > 30) {
      rule = `PATTERN: ${perf.pool_name} had increasing volume (+${perf.volume_trend.toFixed(0)}%) during position → PnL +${perf.pnl_pct}%. Pools with rising volume trend are better candidates.`;
      tags.push("volume_surge", "screening");

    } else if (outcome === "good" && isFiniteNum(perf.duration_hours) && perf.duration_hours < 2) {
      rule = `PATTERN: Quick win on ${perf.pool_name} (<2h hold, PnL +${perf.pnl_pct}%). Short-hold works for high-volume pools.`;
      tags.push("short_hold", "timing", "management");

    } else if (outcome === "bad" && isFiniteNum(perf.duration_hours) && perf.duration_hours > 12) {
      rule = `TIMING: Held ${perf.pool_name} for ${perf.duration_hours.toFixed(1)}h, PnL ${perf.pnl_pct}%. Long holds on volatile pools erode value. Consider tighter time-based exit (${Math.min(perf.duration_hours * 0.5, 6).toFixed(0)}h max).`;
      tags.push("long_hold", "timing", "management");

    } else if (outcome === "bad" && isFiniteNum(perf.pool_tvl_usd) && perf.pool_tvl_usd < 5000) {
      rule = `AVOID: ${perf.pool_name} had only $${Math.round(perf.pool_tvl_usd)} TVL — thin liquidity leads to high slippage and IL.`;
      tags.push("low_tvl", "screening");

    } else if (outcome === "good" && isFiniteNum(perf.price_range_pct) && perf.price_range_pct < 5 && perf.range_efficiency > 70) {
      rule = `IDEAL: ${perf.pool_name} — low price volatility (${perf.price_range_pct.toFixed(1)}% range) + high in-range (${perf.range_efficiency}%) → PnL +${perf.pnl_pct}%. Look for similar stable-price, high-volume pools.`;
      tags.push("ideal_setup", "screening", "strategy");

    } else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
      rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly.`;
      tags.push("volume_collapse");

    } else if (outcome === "good") {
      rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
      if (perf.duration_hours) rule += ` Held ${perf.duration_hours}h.`;
      if (isFiniteNum(perf.price_change_pct)) rule += ` Price ${perf.price_change_pct > 0 ? "+" : ""}${perf.price_change_pct.toFixed(1)}%.`;
      tags.push("worked");

    } else {
      rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
      if (isFiniteNum(perf.price_change_pct)) rule += ` Price ${perf.price_change_pct > 0 ? "+" : ""}${perf.price_change_pct.toFixed(1)}%.`;
      if (isFiniteNum(perf.volume_trend)) rule += ` Volume trend: ${perf.volume_trend > 0 ? "+" : ""}${perf.volume_trend.toFixed(0)}%.`;
      tags.push("failed");
    }
  }

  if (!rule) return null;

  return {
    id: Date.now(), rule, tags, outcome, context,
    pnl_pct: perf.pnl_pct, range_efficiency: perf.range_efficiency,
    price_change_pct: perf.price_change_pct ?? null,
    volume_trend: perf.volume_trend ?? null,
    duration_hours: perf.duration_hours ?? null,
    pool: perf.pool, created_at: new Date().toISOString(),
  };
}

// ─── Adaptive Threshold Evolution ──────────────────────────────

export function evolveThresholds(perfData, config) {
  if (!perfData || perfData.length < MIN_EVOLVE_POSITIONS) return null;

  const winners = perfData.filter((p) => p.pnl_pct > 0);
  const losers  = perfData.filter((p) => p.pnl_pct < -5);
  if (winners.length < 2 && losers.length < 2) return null;

  const changes = {}, rationale = {};

  // ── 1. maxVolatility ─────────────────────────────────────────
  {
    const winnerVols = winners.map((p) => p.volatility).filter(isFiniteNum);
    const loserVols  = losers.map((p) => p.volatility).filter(isFiniteNum);
    const current    = config.screening.maxVolatility;
    if (current != null && loserVols.length >= 2) {
      const loserP25 = percentile(loserVols, 25);
      if (loserP25 < current) {
        const newVal = clamp(nudge(current, loserP25 * 1.15, MAX_CHANGE_PER_STEP), 1.0, 20.0);
        const rounded = Number(newVal.toFixed(1));
        if (rounded < current) { changes.maxVolatility = rounded; rationale.maxVolatility = `Losers clustered at ~${loserP25.toFixed(1)} — tightened ${current} → ${rounded}`; }
      }
    } else if (current != null && winnerVols.length >= 3 && losers.length === 0) {
      const winnerP75 = percentile(winnerVols, 75);
      if (winnerP75 > current * 1.1) {
        const newVal = clamp(nudge(current, winnerP75 * 1.1, MAX_CHANGE_PER_STEP), 1.0, 20.0);
        const rounded = Number(newVal.toFixed(1));
        if (rounded > current) { changes.maxVolatility = rounded; rationale.maxVolatility = `All ${winners.length} profitable — loosened ${current} → ${rounded}`; }
      }
    }
  }

  // ── 2. minFeeActiveTvlRatio ──────────────────────────────────
  {
    const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const loserFees  = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const current    = config.screening.minFeeActiveTvlRatio;
    if (current != null && winnerFees.length >= 2) {
      const minWF = Math.min(...winnerFees);
      if (minWF > current * 1.2) {
        const newVal = clamp(nudge(current, minWF * 0.85, MAX_CHANGE_PER_STEP), 0.05, 10.0);
        const rounded = Number(newVal.toFixed(2));
        if (rounded > current) { changes.minFeeActiveTvlRatio = rounded; rationale.minFeeActiveTvlRatio = `Lowest winner=${minWF.toFixed(2)} — raised ${current} → ${rounded}`; }
      }
    }
    if (current != null && loserFees.length >= 2 && !changes.minFeeActiveTvlRatio) {
      const maxLF = Math.max(...loserFees);
      if (maxLF < current * 1.5 && winnerFees.length > 0 && Math.min(...winnerFees) > maxLF) {
        const newVal = clamp(nudge(current, maxLF * 1.2, MAX_CHANGE_PER_STEP), 0.05, 10.0);
        const rounded = Number(newVal.toFixed(2));
        if (rounded > current) { changes.minFeeActiveTvlRatio = rounded; rationale.minFeeActiveTvlRatio = `Losers fee_tvl<=${maxLF.toFixed(2)} — raised ${current} → ${rounded}`; }
      }
    }
  }

  // ── 3. minOrganic ─────────────────────────────────────────────
  {
    const loserOrg = losers.map((p) => p.organic_score).filter(isFiniteNum);
    const winnerOrg = winners.map((p) => p.organic_score).filter(isFiniteNum);
    const current = config.screening.minOrganic;
    if (loserOrg.length >= 2 && winnerOrg.length >= 1) {
      const avgL = avg(loserOrg), avgW = avg(winnerOrg);
      if (avgW - avgL >= 10) {
        const newVal = clamp(Math.round(nudge(current, Math.max(Math.min(...winnerOrg) - 3, current), MAX_CHANGE_PER_STEP)), 60, 90);
        if (newVal > current) { changes.minOrganic = newVal; rationale.minOrganic = `Winner avg ${avgW.toFixed(0)} vs loser ${avgL.toFixed(0)} — raised ${current} → ${newVal}`; }
      }
    }
  }

  // ── 4. minTvl (NEW — from enrichment) ─────────────────────────
  {
    const loserTvls = losers.map((p) => p.pool_tvl_usd).filter(isFiniteNum);
    const winnerTvls = winners.map((p) => p.pool_tvl_usd).filter(isFiniteNum);
    const current = config.screening.minTvl ?? 0;
    if (loserTvls.length >= 2 && winnerTvls.length >= 1) {
      const lMed = percentile(loserTvls, 50), wMed = percentile(winnerTvls, 50);
      if (wMed > lMed * 1.5) {
        const newVal = clamp(nudge(current, lMed * 1.2, MAX_CHANGE_PER_STEP), 0, 500_000);
        const rounded = Math.round(newVal);
        if (rounded > current) { changes.minTvl = rounded; rationale.minTvl = `Loser median TVL=$${lMed.toFixed(0)} vs winner=$${wMed.toFixed(0)} — raised $${current} → $${rounded}`; }
      }
    }
  }

  // ── 5. maxPriceVolatility (NEW — from enrichment) ─────────────
  {
    const loserPV = losers.map((p) => p.price_range_pct).filter(isFiniteNum);
    const current = config.screening.maxPriceVolatility ?? 50;
    if (loserPV.length >= 2) {
      const lP25 = percentile(loserPV, 25);
      if (lP25 < current) {
        const newVal = clamp(nudge(current, lP25 * 1.1, MAX_CHANGE_PER_STEP), 5, 100);
        const rounded = Number(newVal.toFixed(1));
        if (rounded < current) { changes.maxPriceVolatility = rounded; rationale.maxPriceVolatility = `Losers price_range ~${lP25.toFixed(1)}% — tightened ${current}% → ${rounded}%`; }
      }
    }
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  // Persist
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) { try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch {} }
  Object.assign(userConfig, changes);
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._positionsAtEvolution = perfData.length;
  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  const s = config.screening;
  for (const [k, v] of Object.entries(changes)) { if (s[k] !== undefined || k === "maxPriceVolatility") s[k] = v; }

  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule: `[AUTO-EVOLVED @ ${perfData.length} positions] ${Object.entries(changes).map(([k,v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    tags: ["evolution", "config_change"], outcome: "manual", created_at: new Date().toISOString(),
  });
  save(data);
  return { changes, rationale };
}

// ─── Bootstrap from On-Chain History ──────────────────────────

export async function bootstrapFromHistory(walletAddress, { limit = 10, force = false } = {}) {
  log("bootstrap", `Starting bootstrap: fetching last ${limit} closed positions from Meteora...`);
  const enrichedPositions = await fetchAndEnrichClosedPositions(walletAddress, { limit });
  if (!enrichedPositions || enrichedPositions.length === 0) {
    log("bootstrap", "No positions to bootstrap from");
    return { imported: 0, skipped: 0, lessons_generated: 0 };
  }

  const data = load();
  const existing = new Set(data.performance.map((p) => p.position).filter(Boolean));
  let imported = 0, skipped = 0, lessonsGenerated = 0;

  for (const pos of enrichedPositions) {
    if (!force && pos.position && existing.has(pos.position)) { skipped++; continue; }

    const entry = {
      position: pos.position, pool: pos.pool,
      pool_name: pos._pool_snapshot?.name || `Pool ${pos.pool?.slice(0, 8)}`,
      bin_range: pos.upper_bin_id && pos.lower_bin_id ? pos.upper_bin_id - pos.lower_bin_id : null,
      bin_step: pos._pool_snapshot?.bin_step || null,
      pnl_usd: pos.pnl_usd ?? null, pnl_pct: pos.pnl_pct ?? null,
      initial_value_usd: pos.total_deposits?.amount_usd ?? null,
      final_value_usd: pos.total_withdraws?.amount_usd ?? null,
      fees_earned_usd: pos.total_claimed_fees?.amount_usd ?? 0,
      duration_hours: pos.created_at && pos.closed_at ? Math.round(((pos.closed_at - pos.created_at) / 3600) * 10) / 10 : null,
      price_at_entry: pos.price_at_entry ?? null, price_at_exit: pos.price_at_exit ?? null,
      price_change_pct: pos.price_change_pct ?? null, price_range_pct: pos.price_range_pct ?? null,
      price_max_drawdown_pct: pos.price_max_drawdown_pct ?? null,
      pool_tvl_usd: pos.pool_tvl_usd ?? null, pool_base_fee: pos.pool_base_fee ?? null,
      pool_cumulative_volume: pos.pool_cumulative_volume ?? null,
      avg_volume_per_candle: pos.avg_volume_per_candle ?? null,
      total_volume_during: pos.total_volume_during ?? null, volume_trend: pos.volume_trend ?? null,
      event_count_deposits: pos.event_count_deposits ?? null,
      event_count_withdraws: pos.event_count_withdraws ?? null,
      event_count_claims: pos.event_count_claims ?? null,
      strategy: null, volatility: null, fee_tvl_ratio: null, organic_score: null,
      amount_sol: null, minutes_in_range: null, minutes_held: null, range_efficiency: null,
      close_reason: "historical_import",
      _source: "bootstrap_meteora_api", recorded_at: new Date().toISOString(), _enriched_at: pos._enriched_at,
    };

    data.performance.push(entry);
    imported++;
    const lesson = derivLesson(entry);
    if (lesson) { lesson.tags.push("bootstrap"); data.lessons.push(lesson); lessonsGenerated++; }
  }

  save(data);
  log("bootstrap", `Bootstrap complete: ${imported} imported, ${skipped} skipped, ${lessonsGenerated} lessons generated`);
  return { imported, skipped, lessons_generated: lessonsGenerated };
}

// ─── Helpers ───────────────────────────────────────────────────

function isFiniteNum(n) { return typeof n === "number" && isFinite(n); }
function avg(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }
function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
function nudge(current, target, maxChange) {
  const delta = target - current, maxDelta = current * maxChange;
  return Math.abs(delta) <= maxDelta ? target : current + Math.sign(delta) * maxDelta;
}

// ─── Manual Lessons ────────────────────────────────────────────

export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const safeRule = sanitizeLessonText(rule); if (!safeRule) return;
  const data = load();
  data.lessons.push({ id: Date.now(), rule: safeRule, tags, outcome: "manual", pinned: !!pinned, role: role || null, created_at: new Date().toISOString() });
  save(data);
  log("lessons", `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${safeRule}`);
}

export function pinLesson(id) {
  const data = load(); const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false }; lesson.pinned = true; save(data);
  log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: lesson.rule };
}

export function unpinLesson(id) {
  const data = load(); const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false }; lesson.pinned = false; save(data);
  return { found: true, pinned: false, id, rule: lesson.rule };
}

export function listLessons({ role = null, pinned = null, tag = null, limit = 30 } = {}) {
  const data = load(); let lessons = [...data.lessons];
  if (pinned !== null) lessons = lessons.filter((l) => !!l.pinned === pinned);
  if (role) lessons = lessons.filter((l) => !l.role || l.role === role);
  if (tag) lessons = lessons.filter((l) => l.tags?.includes(tag));
  return { total: lessons.length, lessons: lessons.slice(-limit).map((l) => ({
    id: l.id, rule: l.rule.slice(0, 120), tags: l.tags, outcome: l.outcome,
    pinned: !!l.pinned, role: l.role || "all", created_at: l.created_at?.slice(0, 10),
  })) };
}

export function removeLesson(id) { const data = load(); const b = data.lessons.length; data.lessons = data.lessons.filter((l) => l.id !== id); save(data); return b - data.lessons.length; }
export function removeLessonsByKeyword(keyword) { const data = load(); const b = data.lessons.length; const kw = keyword.toLowerCase(); data.lessons = data.lessons.filter((l) => !l.rule.toLowerCase().includes(kw)); save(data); return b - data.lessons.length; }
export function clearAllLessons() { const data = load(); const c = data.lessons.length; data.lessons = []; save(data); return c; }
export function clearPerformance() { const data = load(); const c = data.performance.length; data.performance = []; save(data); return c; }

// ─── Lesson Retrieval ──────────────────────────────────────────

const ROLE_TAGS = {
  SCREENER: ["screening","narrative","strategy","deployment","token","volume","entry","bundler","holders","organic","volume_collapse","volume_surge","low_tvl","ideal_setup","price_dump","timing"],
  MANAGER:  ["management","risk","oor","fees","position","hold","close","pnl","rebalance","claim","short_hold","long_hold","timing"],
  GENERAL:  [],
};

export function getLessonsForPrompt(opts = {}) {
  if (typeof opts === "number") opts = { maxLessons: opts };
  const { agentType = "GENERAL", maxLessons } = opts;
  const data = load(); if (data.lessons.length === 0) return null;

  const isAuto = agentType === "SCREENER" || agentType === "MANAGER";
  const PINNED_CAP = isAuto ? 5 : 10, ROLE_CAP = isAuto ? 6 : 15, RECENT_CAP = maxLessons ?? (isAuto ? 10 : 35);
  const outP = { bad:0, poor:1, failed:1, good:2, worked:2, manual:1, neutral:3, evolution:2 };
  const byP = (a, b) => (outP[a.outcome]??3) - (outP[b.outcome]??3);

  const pinned = data.lessons.filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL")).sort(byP).slice(0, PINNED_CAP);
  const usedIds = new Set(pinned.map((l) => l.id));
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = data.lessons.filter((l) => {
    if (usedIds.has(l.id)) return false;
    return (!l.role || l.role === agentType || agentType === "GENERAL") && (roleTags.length === 0 || !l.tags?.length || l.tags.some((t) => roleTags.includes(t)));
  }).sort(byP).slice(0, ROLE_CAP);
  roleMatched.forEach((l) => usedIds.add(l.id));
  const rem = RECENT_CAP - pinned.length - roleMatched.length;
  const recent = rem > 0 ? data.lessons.filter((l) => !usedIds.has(l.id)).sort((a,b) => (b.created_at||"").localeCompare(a.created_at||"")).slice(0, rem) : [];
  const selected = [...pinned, ...roleMatched, ...recent];
  if (selected.length === 0) return null;
  const sections = [];
  if (pinned.length) sections.push(`── PINNED (${pinned.length}) ──\n` + fmt(pinned));
  if (roleMatched.length) sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmt(roleMatched));
  if (recent.length) sections.push(`── RECENT (${recent.length}) ──\n` + fmt(recent));
  return sections.join("\n\n");
}

function fmt(lessons) {
  return lessons.map((l) => {
    const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
    return `${l.pinned ? "📌 " : ""}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
  }).join("\n");
}

export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const data = load(); const p = data.performance;
  if (p.length === 0) return { positions: [], count: 0, hours };
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const filtered = p.filter((r) => r.recorded_at >= cutoff).slice(-limit).map((r) => ({
    pool_name: r.pool_name, pool: r.pool, strategy: r.strategy,
    pnl_usd: r.pnl_usd, pnl_pct: r.pnl_pct, fees_earned_usd: r.fees_earned_usd,
    range_efficiency: r.range_efficiency, minutes_held: r.minutes_held,
    duration_hours: r.duration_hours, close_reason: r.close_reason, closed_at: r.recorded_at,
    price_change_pct: r.price_change_pct, volume_trend: r.volume_trend, pool_tvl_usd: r.pool_tvl_usd,
  }));
  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter((r) => r.pnl_usd > 0).length;
  return { hours, count: filtered.length, total_pnl_usd: Math.round(totalPnl * 100) / 100, win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null, positions: filtered };
}

export function getPerformanceSummary() {
  const data = load(); const p = data.performance;
  if (p.length === 0) return null;
  const totalPnl = p.reduce((s, x) => s + (x.pnl_usd ?? 0), 0);
  const avgPnlPct = p.reduce((s, x) => s + (x.pnl_pct ?? 0), 0) / p.length;
  const reArr = p.filter(x => isFiniteNum(x.range_efficiency));
  const avgRE = reArr.length > 0 ? reArr.reduce((s, x) => s + x.range_efficiency, 0) / reArr.length : 0;
  const wins = p.filter((x) => (x.pnl_usd ?? 0) > 0).length;
  const durations = p.map((x) => x.duration_hours).filter(isFiniteNum);
  const priceChanges = p.map((x) => x.price_change_pct).filter(isFiniteNum);
  const enriched = p.filter((x) => x._enriched_at).length;
  return {
    total_positions_closed: p.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRE * 10) / 10,
    win_rate_pct: Math.round((wins / p.length) * 100),
    total_lessons: data.lessons.length,
    avg_duration_hours: durations.length > 0 ? Math.round((durations.reduce((a,b) => a+b, 0) / durations.length) * 10) / 10 : null,
    positions_with_price_dump: priceChanges.filter((x) => x < -15).length,
    enriched_count: enriched,
    bootstrapped_count: p.filter((x) => x._source === "bootstrap_meteora_api").length,
  };
}
