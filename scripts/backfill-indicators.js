/**
 * backfill-indicators.js
 *
 * Backfills indicators_at_entry for existing performance records in lessons.json.
 * Fetches 30 pre-entry 1h candles from Meteora OHLCV API using deployed_at timestamp,
 * computes RSI, Bollinger Bands, VWAP, ATR, EMA trend, consecutive red candles,
 * and saves results back into lessons.json.
 *
 * Usage:
 *   node scripts/backfill-indicators.js           # backfill all missing
 *   node scripts/backfill-indicators.js --dry-run  # preview only, no writes
 *   node scripts/backfill-indicators.js --force    # overwrite existing indicators
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { computeIndicators } from "../tools/indicators.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSONS_FILE  = path.join(__dirname, "../lessons.json");
const BASE_URL      = "https://dlmm.datapi.meteora.ag";
const LOOKBACK      = 30;     // pre-entry candles for indicator warmup
const CANDLE_SEC    = 3600;   // 1h candles
const DELAY_MS      = 400;    // polite rate limit (~2.5 RPS)

const isDryRun = process.argv.includes("--dry-run");
const isForce  = process.argv.includes("--force");

// ─── Helpers ───────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toUnixSec(ts) {
  if (!ts) return null;
  if (typeof ts === "number") return ts > 1e10 ? Math.floor(ts / 1000) : ts;
  const ms = new Date(ts).getTime();
  return isNaN(ms) ? null : Math.floor(ms / 1000);
}

async function fetchOHLCV(poolAddress, startTime, endTime) {
  const params = new URLSearchParams({ timeframe: "1h" });
  if (startTime) params.set("start_time", String(startTime));
  if (endTime)   params.set("end_time",   String(endTime));
  const url = `${BASE_URL}/pools/${poolAddress}/ohlcv?${params}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 429) {
        const wait = 1000 * attempt * 2;
        console.log(`  ⚠ Rate limited — waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (Array.isArray(data)) return data;
      if (data?.data && Array.isArray(data.data)) return data.data;
      return null;
    } catch (err) {
      if (attempt === 3) return null;
      await sleep(500 * attempt);
    }
  }
  return null;
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(LESSONS_FILE)) {
    console.error("lessons.json not found");
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  const perf = data.performance || [];

  const eligible = perf.filter(p =>
    p.pool && p.deployed_at && (isForce || !p.indicators_at_entry)
  );

  console.log(`lessons.json: ${perf.length} total records`);
  console.log(`Eligible for backfill: ${eligible.length} (pool + deployed_at${isForce ? ", force" : ", no indicators yet"})`);
  if (isDryRun) console.log("DRY RUN — no writes");
  console.log("");

  let success = 0, skipped = 0, failed = 0;

  for (let i = 0; i < eligible.length; i++) {
    const p = eligible[i];
    const label = `[${i + 1}/${eligible.length}] ${p.pool_name || p.pool.slice(0, 8)} (${p.deployed_at?.slice(0, 10)})`;

    const entryTime = toUnixSec(p.deployed_at);
    if (!entryTime) {
      console.log(`${label} — skip: invalid deployed_at`);
      skipped++;
      continue;
    }

    const startTime = entryTime - LOOKBACK * CANDLE_SEC;
    const endTime   = entryTime + CANDLE_SEC; // include entry candle

    process.stdout.write(`${label} — fetching...`);

    const candles = await fetchOHLCV(p.pool, startTime, endTime);

    if (!candles || candles.length < 5) {
      console.log(` no data (${candles?.length ?? 0} candles)`);
      failed++;
      await sleep(DELAY_MS);
      continue;
    }

    const indicators = computeIndicators(candles);

    if (!indicators) {
      console.log(` insufficient candles (${candles.length})`);
      failed++;
      await sleep(DELAY_MS);
      continue;
    }

    console.log(` ✓ RSI=${indicators.rsi_14 ?? "?"} BB=${indicators.bb_position ?? "?"} EMA=${indicators.ema_trend ?? "?"} ATR=${indicators.atr_14_pct ?? "?"}% red=${indicators.consecutive_red ?? "?"}`);

    if (!isDryRun) {
      // Update the record in-place (find by reference in original array)
      const original = perf.find(r => r === p || (r.pool === p.pool && r.deployed_at === p.deployed_at && r.position === p.position));
      if (original) original.indicators_at_entry = indicators;
    }

    success++;
    await sleep(DELAY_MS);
  }

  console.log(`\n─────────────────────────────`);
  console.log(`Done: ${success} enriched, ${skipped} skipped, ${failed} failed`);

  if (!isDryRun && success > 0) {
    fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
    console.log(`Saved → lessons.json`);
  }
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
