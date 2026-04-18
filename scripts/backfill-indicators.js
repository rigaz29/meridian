#!/usr/bin/env node
/**
 * backfill-indicators.js
 *
 * Fills missing indicators_at_entry and indicators_at_exit for performance
 * records in lessons.json using historical OHLCV from the Meteora API.
 *
 * Usage:
 *   node scripts/backfill-indicators.js
 *   node scripts/backfill-indicators.js --dry-run          # preview, no save
 *   node scripts/backfill-indicators.js --force            # overwrite existing indicators
 *   node scripts/backfill-indicators.js --limit 20         # process at most N records
 *   node scripts/backfill-indicators.js --entry-only       # skip indicators_at_exit
 *   node scripts/backfill-indicators.js --exit-only        # skip indicators_at_entry
 *
 * Rate: one API call per 400ms to stay under Meteora's 30 RPS limit.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { computeIndicatorsAt } from "../meteora-api.js";

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
  return `RSI=${indicators.rsi_14 ?? "?"} BB=${indicators.bb_position ?? "?"} EMA=${indicators.ema_trend ?? "?"} ATR=${indicators.atr_14_pct ?? "?"}% [${indicators._timeframe ?? "5m"}]`;
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const data = load();
  const perf = data.performance;

  console.log(`\n=== Meridian Indicator Backfill ===`);
  console.log(`Total records:        ${perf.length}`);
  console.log(`Has indicators_entry: ${perf.filter(r => r.indicators_at_entry).length}`);
  console.log(`Has indicators_exit:  ${perf.filter(r => r.indicators_at_exit).length}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"} | Force: ${FORCE} | Limit: ${LIMIT === Infinity ? "all" : LIMIT}`);
  console.log("");

  // Build work queue
  const queue = [];
  for (const rec of perf) {
    if (!rec.pool) continue;

    const needEntry = !EXIT_ONLY && rec.deployed_at && (FORCE || !rec.indicators_at_entry);
    const needExit  = !ENTRY_ONLY && rec.recorded_at && (FORCE || !rec.indicators_at_exit);

    if (needEntry || needExit) {
      queue.push({ rec, needEntry, needExit });
    }
  }

  if (queue.length === 0) {
    console.log("Nothing to backfill — all records already have indicators.");
    return;
  }

  const toProcess = queue.slice(0, LIMIT);
  console.log(`Records to process: ${toProcess.length} (skipping ${queue.length - toProcess.length})\n`);

  let filled = 0, failed = 0, apiCalls = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const { rec, needEntry, needExit } = toProcess[i];
    const label = `[${i + 1}/${toProcess.length}] ${rec.pool_name || rec.pool.slice(0, 8)}`;

    // ── indicators_at_entry ──────────────────────────────────
    if (needEntry) {
      if (apiCalls > 0) await sleep(RATE_DELAY_MS);
      process.stdout.write(`${label} entry (${rec.deployed_at?.slice(0, 10)}) ... `);
      try {
        const ind = await computeIndicatorsAt(rec.pool, rec.deployed_at);
        apiCalls++;
        if (ind) {
          if (!DRY_RUN) rec.indicators_at_entry = ind;
          console.log(`OK  ${fmt(ind)}`);
          filled++;
        } else {
          console.log("SKIP (not enough OHLCV data)");
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
        const ind = await computeIndicatorsAt(rec.pool, rec.recorded_at);
        apiCalls++;
        if (ind) {
          if (!DRY_RUN) rec.indicators_at_exit = ind;
          console.log(`OK  ${fmt(ind)}`);
          filled++;
        } else {
          console.log("SKIP (not enough OHLCV data)");
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
  console.log(`Filled:   ${filled}`);
  console.log(`Failed:   ${failed}`);
  console.log(`API calls: ${apiCalls}`);
  if (DRY_RUN) console.log("(DRY RUN — no changes written)");
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
