#!/usr/bin/env node
/**
 * backfill-indicators.js
 *
 * Fills missing indicators_at_entry and indicators_at_exit for performance
 * records in lessons.json using OKX DEX API (15m) → GeckoTerminal (15m).
 * No Meteora OHLCV fallback — 15m only.
 *
 * Usage:
 *   node scripts/backfill-indicators.js
 *   node scripts/backfill-indicators.js --dry-run          # preview, no save
 *   node scripts/backfill-indicators.js --force            # overwrite existing indicators
 *   node scripts/backfill-indicators.js --limit 20         # process at most N records
 *   node scripts/backfill-indicators.js --entry-only       # skip indicators_at_exit
 *   node scripts/backfill-indicators.js --exit-only        # skip indicators_at_entry
 *
 * Rate: one API call per 400ms to stay under rate limits.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchPool, computeIndicatorsFromCandles, fetchOHLCVGeckoTerminal } from "../meteora-api.js";
import { fetchOHLCVCandles } from "../tools/okx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSONS_FILE = path.join(__dirname, "../lessons.json");
const RATE_DELAY_MS = 400;

// ─── CLI args ───────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN    = args.includes("--dry-run");
const FORCE      = args.includes("--force");
const ENTRY_ONLY = args.includes("--entry-only");
const EXIT_ONLY  = args.includes("--exit-only");
const limitIdx   = args.indexOf("--limit");
const LIMIT      = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

// ─── Helpers ────────────────────────────────────────────────────

function load() {
  try { return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8")); }
  catch { console.error("Could not read lessons.json"); process.exit(1); }
}

function save(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fmt(indicators) {
  if (!indicators) return "null";
  const st = indicators.supertrend;
  const stStr = st ? `ST=${st.direction}(${st.distance_pct}%)` : "ST=n/a";
  const src = [indicators._timeframe ?? "15m", indicators._source].filter(Boolean).join("/");
  return `RSI=${indicators.rsi_14 ?? "?"} BB=${indicators.bb_position ?? "?"} EMA=${indicators.ema_trend ?? "?"} ATR=${indicators.atr_14_pct ?? "?"}% ${stStr} [${src}]`;
}

/**
 * Resolve base token mint for a pool address.
 * Fetches from Meteora API; cached per-pool to avoid redundant calls.
 */
const mintCache = new Map();

async function resolveTokenMint(poolAddress) {
  if (mintCache.has(poolAddress)) return mintCache.get(poolAddress);
  try {
    const pool = await fetchPool(poolAddress);
    const tx = pool?.token_x;
    const mint = typeof tx === "string" ? tx : (tx?.address ?? null);
    mintCache.set(poolAddress, mint);
    return mint;
  } catch {
    mintCache.set(poolAddress, null);
    return null;
  }
}

/**
 * Fetch 15m OHLCV candles anchored to a historical timestamp.
 * Source priority: OKX 15m (token-mint) → GeckoTerminal 15m (pool-address).
 * Returns { candles, source } or null if both fail / insufficient data.
 */
async function fetch15mCandlesAt(poolAddress, tokenMint, atTimeSec) {
  // 1. OKX — requires token mint
  if (tokenMint) {
    try {
      const candles = await fetchOHLCVCandles(tokenMint, {
        timeframe: "15m",
        limit: 100,
        beforeMs: atTimeSec * 1000,
      });
      if (candles?.length >= 21) return { candles, source: "okx" };
    } catch { /* fall through */ }
  }

  // 2. GeckoTerminal — pool-address based
  try {
    const candles = await fetchOHLCVGeckoTerminal(poolAddress, {
      aggregate: 15,
      limit: 100,
      beforeSec: atTimeSec,
    });
    if (candles?.length >= 21) return { candles, source: "gecko" };
  } catch { /* fall through */ }

  return null;
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const data = load();
  const perf = data.performance;

  console.log(`\n=== Meridian Indicator Backfill (OKX→GeckoTerminal 15m) ===`);
  console.log(`Total records:        ${perf.length}`);
  console.log(`Has indicators_entry: ${perf.filter(r => r.indicators_at_entry).length}`);
  console.log(`Has indicators_exit:  ${perf.filter(r => r.indicators_at_exit).length}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"} | Force: ${FORCE} | Limit: ${LIMIT === Infinity ? "all" : LIMIT}`);
  console.log("");

  // Build work queue
  const queue = [];
  for (const rec of perf) {
    if (!rec.pool) continue;
    const needEntry = !EXIT_ONLY  && rec.deployed_at  && (FORCE || !rec.indicators_at_entry);
    const needExit  = !ENTRY_ONLY && rec.recorded_at  && (FORCE || !rec.indicators_at_exit);
    if (needEntry || needExit) queue.push({ rec, needEntry, needExit });
  }

  if (queue.length === 0) {
    console.log("Nothing to backfill — all records already have indicators.");
    return;
  }

  const toProcess = queue.slice(0, LIMIT);
  console.log(`Records to process: ${toProcess.length} (skipping ${queue.length - toProcess.length})\n`);

  // Pre-resolve token mints for all unique pools
  const uniquePools = [...new Set(toProcess.map(({ rec }) => rec.pool))];
  console.log(`Resolving mints for ${uniquePools.length} unique pool(s)...`);
  for (const pool of uniquePools) {
    const mint = await resolveTokenMint(pool);
    console.log(`  ${pool.slice(0, 8)}… → ${mint ? mint.slice(0, 8) + "…" : "not found"}`);
    await sleep(RATE_DELAY_MS);
  }
  console.log("");

  let filled = 0, failed = 0, apiCalls = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const { rec, needEntry, needExit } = toProcess[i];
    const label = `[${i + 1}/${toProcess.length}] ${rec.pool_name || rec.pool.slice(0, 8)}`;
    const tokenMint = mintCache.get(rec.pool) ?? null;

    // ── indicators_at_entry ──────────────────────────────────
    if (needEntry) {
      if (apiCalls > 0) await sleep(RATE_DELAY_MS);
      process.stdout.write(`${label} entry (${rec.deployed_at?.slice(0, 10)}) ... `);
      try {
        const ts = Math.floor(new Date(rec.deployed_at).getTime() / 1000);
        const result = await fetch15mCandlesAt(rec.pool, tokenMint, ts);
        apiCalls++;
        if (result) {
          const ind = computeIndicatorsFromCandles(result.candles);
          if (ind) {
            const full = { ...ind, _timeframe: "15m", _source: result.source };
            if (!DRY_RUN) rec.indicators_at_entry = full;
            console.log(`OK  ${fmt(full)}`);
            filled++;
          } else {
            console.log("SKIP (indicators compute failed)");
            failed++;
          }
        } else {
          console.log("SKIP (not enough 15m OHLCV data)");
          failed++;
        }
      } catch (e) {
        console.log(`ERR ${e.message}`);
        failed++;
        apiCalls++;
      }
    }

    // ── indicators_at_exit ───────────────────────────────────
    if (needExit) {
      if (apiCalls > 0) await sleep(RATE_DELAY_MS);
      process.stdout.write(`${label} exit  (${rec.recorded_at?.slice(0, 10)}) ... `);
      try {
        const ts = Math.floor(new Date(rec.recorded_at).getTime() / 1000);
        const result = await fetch15mCandlesAt(rec.pool, tokenMint, ts);
        apiCalls++;
        if (result) {
          const ind = computeIndicatorsFromCandles(result.candles);
          if (ind) {
            const full = { ...ind, _timeframe: "15m", _source: result.source };
            if (!DRY_RUN) rec.indicators_at_exit = full;
            console.log(`OK  ${fmt(full)}`);
            filled++;
          } else {
            console.log("SKIP (indicators compute failed)");
            failed++;
          }
        } else {
          console.log("SKIP (not enough 15m OHLCV data)");
          failed++;
        }
      } catch (e) {
        console.log(`ERR ${e.message}`);
        failed++;
        apiCalls++;
      }
    }

    // Save every 10 records (incremental — avoids losing progress on crash)
    if (!DRY_RUN && (i + 1) % 10 === 0) {
      save(data);
      console.log(`  >> Saved progress (${i + 1}/${toProcess.length})`);
    }
  }

  if (!DRY_RUN) save(data);

  console.log(`\n=== Done ===`);
  console.log(`Filled:    ${filled}`);
  console.log(`Failed:    ${failed}`);
  console.log(`API calls: ${apiCalls}`);
  if (DRY_RUN) console.log("(DRY RUN — no changes written)");
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
