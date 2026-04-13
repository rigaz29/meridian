#!/usr/bin/env node
/**
 * pnl-compare.js — Standalone PnL accuracy comparator
 *
 * Compares PnL (% and USD/SOL) between:
 *   - Meteora datapi  (https://dlmm.datapi.meteora.ag)
 *   - LPAgent API     (https://api.lpagent.io/open-api/v1)
 *
 * Reads positions from Meridian's state.json. No Meridian imports.
 *
 * Usage:
 *   node pnl-compare.js [--sol]   # --sol = show SOL-mode PnL instead of USD
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

// ─── Config ────────────────────────────────────────────────────
const MERIDIAN_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE     = path.join(MERIDIAN_DIR, ".env");
const STATE_FILE   = path.join(MERIDIAN_DIR, "state.json");

const METEORA_API  = "https://dlmm.datapi.meteora.ag";
const LPAGENT_API  = "https://api.lpagent.io/open-api/v1";

const SOL_MODE = process.argv.includes("--sol");

// ─── Load .env ─────────────────────────────────────────────────
function loadEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    env[key] = val;
  }
  return env;
}

// ─── Wallet address from private key ───────────────────────────
function walletFromPrivateKey(raw) {
  try {
    let secret;
    if (raw.startsWith("[")) {
      secret = Uint8Array.from(JSON.parse(raw));
    } else {
      secret = bs58.decode(raw);
    }
    return Keypair.fromSecretKey(secret).publicKey.toString();
  } catch {
    throw new Error("Cannot parse WALLET_PRIVATE_KEY — check .env");
  }
}

// ─── Helpers ───────────────────────────────────────────────────
const safeNum = (v, fallback = 0) => {
  const n = parseFloat(v);
  return isFinite(n) ? n : fallback;
};

const fmt = (n, decimals = 2) =>
  n == null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(decimals);

const fmtUsd = (n) =>
  n == null ? "—" : (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toFixed(2);

const fmtSol = (n) =>
  n == null ? "—" : (n >= 0 ? "+" : "-") + "◎" + Math.abs(n).toFixed(4);

const truncate = (s, n = 8) => (s || "").slice(0, n) + "...";

// ─── Meteora API ───────────────────────────────────────────────
async function fetchMeteoraPnl(poolAddress, walletAddress) {
  const url = `${METEORA_API}/positions/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora PnL ${res.status}: ${await res.text().slice(0, 120)}`);
  const data = await res.json();
  const positions = data.positions || data.data || [];
  const byAddress = {};
  for (const p of positions) {
    const addr = p.positionAddress || p.address || p.position;
    if (addr) byAddress[addr] = p;
  }
  return byAddress;
}

// ─── LPAgent API ───────────────────────────────────────────────
async function fetchLpAgentPnl(walletAddress, apiKey) {
  if (!apiKey) return {};
  const url = `${LPAGENT_API}/lp-positions/opening?owner=${walletAddress}`;
  const res = await fetch(url, { headers: { "x-api-key": apiKey } });
  if (!res.ok) throw new Error(`LPAgent ${res.status}: ${await res.text().slice(0, 120)}`);
  const data = await res.json();
  const positions = data?.data || [];
  const byAddress = {};
  for (const p of positions) {
    const addr = p.position || p.id || p.tokenId;
    if (addr) byAddress[addr] = p;
  }
  return byAddress;
}

// ─── Extract PnL fields from Meteora raw data ──────────────────
function parseMeteora(raw) {
  if (!raw) return null;
  const unclaimedUsd =
    safeNum(raw.unrealizedPnl?.unclaimedFeeTokenX?.usd) +
    safeNum(raw.unrealizedPnl?.unclaimedFeeTokenY?.usd);
  const unclaimedSol =
    safeNum(raw.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) +
    safeNum(raw.unrealizedPnl?.unclaimedFeeTokenY?.amountSol);
  return {
    pnl_usd:         safeNum(raw.pnlUsd),
    pnl_pct_usd:     safeNum(raw.pnlPctChange),
    pnl_pct_sol:     safeNum(raw.pnlSolPctChange),
    value_usd:       safeNum(raw.unrealizedPnl?.balances),
    value_sol:       safeNum(raw.unrealizedPnl?.balancesSol),
    unclaimed_usd:   unclaimedUsd,
    unclaimed_sol:   unclaimedSol,
    all_time_fee_usd: safeNum(raw.allTimeFees?.total?.usd),
    deposit_usd:     safeNum(raw.depositedUsd ?? raw.totalDeposited?.usd),
    deposit_sol:     safeNum(raw.depositedSol ?? raw.totalDeposited?.sol),
    in_range:        !raw.isOutOfRange,
    lower_bin:       raw.lowerBinId ?? null,
    upper_bin:       raw.upperBinId ?? null,
    active_bin:      raw.poolActiveBinId ?? null,
  };
}

// ─── Extract PnL fields from LPAgent raw data ─────────────────
function parseLpAgent(raw) {
  if (!raw) return null;
  return {
    pnl_usd:       safeNum(raw.pnl?.usd ?? raw.pnlUsd),
    pnl_pct_usd:   safeNum(raw.pnl?.percent),
    pnl_pct_sol:   safeNum(raw.pnl?.percentNative),
    value_usd:     safeNum(raw.value),
    value_sol:     safeNum(raw.valueNative),
    unclaimed_usd: safeNum(raw.unCollectedFee),
    unclaimed_sol: safeNum(raw.unCollectedFeeNative),
    collected_usd: safeNum(raw.collectedFee),
    collected_sol: safeNum(raw.collectedFeeNative),
    deposit_usd:   safeNum(raw.depositUsd ?? raw.depositedUsd),
    deposit_sol:   safeNum(raw.depositSol ?? raw.depositedSol),
  };
}

// ─── Derive PnL% from value and initial deposit ────────────────
function derivePnlPct(currentValue, initialValue) {
  if (!initialValue || initialValue === 0) return null;
  return ((currentValue - initialValue) / initialValue) * 100;
}

// ─── Colour helpers for terminal output ───────────────────────
const RED    = "\x1b[31m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const RESET  = "\x1b[0m";

const colorPnl = (n) => {
  if (n == null) return DIM + "—" + RESET;
  const s = fmt(n) + "%";
  return n > 0 ? GREEN + s + RESET : n < 0 ? RED + s + RESET : DIM + s + RESET;
};

const colorDiff = (n) => {
  if (n == null) return DIM + "—" + RESET;
  const abs = Math.abs(n);
  const s = fmt(n) + "pp";
  return abs >= 5 ? RED + BOLD + s + RESET
       : abs >= 2 ? YELLOW + s + RESET
       : DIM + s + RESET;
};

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  console.log(BOLD + "\n📊  PnL Accuracy Comparator — Meteora vs LPAgent\n" + RESET);

  // Load env
  const env = loadEnv(ENV_FILE);
  const privateKey = env.WALLET_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY;
  const lpagentKey = env.LPAGENT_API_KEY    || process.env.LPAGENT_API_KEY;

  if (!privateKey) {
    console.error(RED + "❌  WALLET_PRIVATE_KEY not found in .env" + RESET);
    process.exit(1);
  }

  const wallet = walletFromPrivateKey(privateKey);
  console.log(DIM + "Wallet : " + wallet + RESET);
  console.log(DIM + "Mode   : " + (SOL_MODE ? "SOL" : "USD") + RESET);
  console.log(DIM + "LPAgent: " + (lpagentKey ? "✅ key found" : "❌ no key — LPAgent column will be empty") + RESET);
  console.log();

  // Load state.json
  if (!fs.existsSync(STATE_FILE)) {
    console.error(RED + "❌  state.json not found at " + STATE_FILE + RESET);
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const tracked = state.positions || {};

  const openPositions = Object.entries(tracked).filter(([, v]) => !v.closed);
  if (openPositions.length === 0) {
    console.log(YELLOW + "No open positions in state.json." + RESET);
    return;
  }

  console.log(`Found ${openPositions.length} open position(s) in state.json\n`);

  // Collect unique pools
  const pools = [...new Set(openPositions.map(([, v]) => v.pool).filter(Boolean))];

  // Fetch both APIs in parallel
  console.log(DIM + "Fetching Meteora API..." + RESET);
  const meteoraResults = {};
  await Promise.all(
    pools.map(async (poolAddr) => {
      try {
        const byPos = await fetchMeteoraPnl(poolAddr, wallet);
        Object.assign(meteoraResults, byPos);
      } catch (e) {
        console.error(YELLOW + `  ⚠ Meteora fetch failed for pool ${truncate(poolAddr)}: ${e.message}` + RESET);
      }
    })
  );

  console.log(DIM + "Fetching LPAgent API..." + RESET);
  let lpagentResults = {};
  try {
    lpagentResults = await fetchLpAgentPnl(wallet, lpagentKey);
  } catch (e) {
    console.error(YELLOW + `  ⚠ LPAgent fetch failed: ${e.message}` + RESET);
  }

  console.log();

  // ── Build comparison rows ───────────────────────────────────
  const rows = [];
  let totalDiffs = [];

  for (const [posAddr, stateData] of openPositions) {
    const metRaw  = meteoraResults[posAddr];
    const lpRaw   = lpagentResults[posAddr];
    const met     = parseMeteora(metRaw);
    const lp      = parseLpAgent(lpRaw);

    // Initial value: prefer state.json initial_value_usd, else derive from amount_sol
    const initialUsd = stateData.initial_value_usd ?? null;
    const initialSol = stateData.amount_sol ?? null;
    const deployedAt = stateData.deployed_at
      ? new Date(stateData.deployed_at).toLocaleString()
      : "unknown";

    // PnL % to compare (USD or SOL mode)
    const metPnlPct  = met  ? (SOL_MODE ? met.pnl_pct_sol  : met.pnl_pct_usd)  : null;
    const lpPnlPct   = lp   ? (SOL_MODE ? lp.pnl_pct_sol   : lp.pnl_pct_usd)   : null;

    // Current value to compare
    const metValue   = met  ? (SOL_MODE ? met.value_sol     : met.value_usd)     : null;
    const lpValue    = lp   ? (SOL_MODE ? lp.value_sol      : lp.value_usd)      : null;

    // PnL USD from Meteora (direct), LPAgent (derived if not available)
    const metPnlUsd  = met?.pnl_usd ?? null;
    const lpPnlUsd   = lp?.pnl_usd ?? (lp && initialUsd ? lp.value_usd - initialUsd : null);

    // Derived PnL% from first principles (current_value / initial_value)
    const metDerived = met && initialUsd ? derivePnlPct(met.value_usd, initialUsd) : null;
    const lpDerived  = lp  && initialUsd ? derivePnlPct(lp.value_usd,  initialUsd) : null;

    // Diffs
    const pnlPctDiff = metPnlPct != null && lpPnlPct != null ? (lpPnlPct - metPnlPct)  : null;
    const pnlUsdDiff = metPnlUsd != null && lpPnlUsd != null ? (lpPnlUsd - metPnlUsd)  : null;
    const valueDiff  = metValue  != null && lpValue  != null ? (lpValue  - metValue)    : null;

    if (pnlPctDiff != null) totalDiffs.push(Math.abs(pnlPctDiff));

    rows.push({
      name:        stateData.pool_name || truncate(posAddr, 12),
      posAddr,
      deployedAt,
      initialUsd,
      initialSol,
      // Meteora
      metPnlPct, metPnlUsd, metValue,
      metUnclaimed: met ? (SOL_MODE ? met.unclaimed_sol : met.unclaimed_usd) : null,
      metDerived,
      metRaw: met,
      // LPAgent
      lpPnlPct, lpPnlUsd, lpValue,
      lpUnclaimed: lp ? (SOL_MODE ? lp.unclaimed_sol : lp.unclaimed_usd) : null,
      lpDerived,
      lpRaw: lp,
      // Diffs
      pnlPctDiff, pnlUsdDiff, valueDiff,
      suspicious: pnlPctDiff != null && Math.abs(pnlPctDiff) >= 2,
      metMissing: !met,
      lpMissing:  !lp,
    });
  }

  // ── Print comparison table ──────────────────────────────────
  const SEP = "─".repeat(100);

  for (const r of rows) {
    const statusIcon = r.suspicious ? RED + "⚠ SUSPICIOUS" + RESET
                     : r.metMissing || r.lpMissing ? YELLOW + "⚠ PARTIAL" + RESET
                     : GREEN + "✓ OK" + RESET;

    console.log(BOLD + SEP + RESET);
    console.log(
      BOLD + CYAN + r.name + RESET +
      DIM + "  [" + truncate(r.posAddr, 16) + "]" + RESET +
      "  " + statusIcon
    );
    console.log(
      DIM + "Deployed : " + r.deployedAt +
      "  |  Initial: " + (r.initialUsd != null ? "$" + r.initialUsd.toFixed(2) : "—") +
      (r.initialSol != null ? " / ◎" + r.initialSol : "") + RESET
    );
    console.log();

    // Header row
    const COL = 28;
    // pad uses visible length (strips ANSI codes for width calc)
    const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
    const pad = (s, n = COL) => {
      const str = String(s ?? "");
      const visible = stripAnsi(str).length;
      return str + " ".repeat(Math.max(0, n - visible));
    };
    const dash = DIM + "—" + RESET;

    console.log(
      pad("", COL) +
      BOLD + pad("METEORA", COL) + pad("LPAGENT", COL) + "DIFF (LPAgent − Meteora)" + RESET
    );
    console.log(DIM + pad("", COL) + "─".repeat(COL * 2 + 30) + RESET);

    // row: label | met (pre-colored string) | lp (pre-colored string) | diff
    const row = (label, met, lp, diff) => {
      console.log(
        pad(label, COL) +
        pad(met  ?? dash, COL) +
        pad(lp   ?? dash, COL) +
        (diff ?? dash)
      );
    };

    // PnL % (reported by API)
    row(
      "PnL % (" + (SOL_MODE ? "SOL" : "USD") + ") [reported]",
      r.metPnlPct != null ? colorPnl(r.metPnlPct) : null,
      r.lpPnlPct  != null ? colorPnl(r.lpPnlPct)  : null,
      r.pnlPctDiff != null ? colorDiff(r.pnlPctDiff) : null,
    );

    // PnL % derived from first principles (current_value / initial_value)
    if (r.initialUsd) {
      row(
        "PnL % (derived, USD)",
        r.metDerived != null ? colorPnl(r.metDerived) : null,
        r.lpDerived  != null ? colorPnl(r.lpDerived)  : null,
        r.metDerived != null && r.lpDerived != null
          ? colorDiff(r.lpDerived - r.metDerived) : null,
      );
    }

    // PnL USD
    const pnlUsdDiffFmt = r.pnlUsdDiff != null
      ? (Math.abs(r.pnlUsdDiff) >= 1 ? YELLOW : DIM) + fmtUsd(r.pnlUsdDiff) + RESET : null;
    row(
      "PnL USD [reported]",
      r.metPnlUsd != null ? (r.metPnlUsd >= 0 ? GREEN : RED) + fmtUsd(r.metPnlUsd) + RESET : null,
      r.lpPnlUsd  != null ? (r.lpPnlUsd  >= 0 ? GREEN : RED) + fmtUsd(r.lpPnlUsd)  + RESET : null,
      pnlUsdDiffFmt,
    );

    // Current value
    const valDiffFmt = r.valueDiff != null
      ? (Math.abs(r.valueDiff) >= 1 ? YELLOW : DIM) +
        (SOL_MODE ? fmtSol(r.valueDiff) : fmtUsd(r.valueDiff)) + RESET : null;
    row(
      "Current Value (" + (SOL_MODE ? "SOL" : "USD") + ")",
      r.metValue != null ? (SOL_MODE ? fmtSol(r.metValue) : fmtUsd(r.metValue)) : null,
      r.lpValue  != null ? (SOL_MODE ? fmtSol(r.lpValue)  : fmtUsd(r.lpValue))  : null,
      valDiffFmt,
    );

    // Unclaimed fees
    const feeDiff = r.metUnclaimed != null && r.lpUnclaimed != null
      ? r.lpUnclaimed - r.metUnclaimed : null;
    row(
      "Unclaimed Fees (" + (SOL_MODE ? "SOL" : "USD") + ")",
      r.metUnclaimed != null ? (SOL_MODE ? fmtSol(r.metUnclaimed) : fmtUsd(r.metUnclaimed)) : null,
      r.lpUnclaimed  != null ? (SOL_MODE ? fmtSol(r.lpUnclaimed)  : fmtUsd(r.lpUnclaimed))  : null,
      feeDiff != null ? DIM + (SOL_MODE ? fmtSol(feeDiff) : fmtUsd(feeDiff)) + RESET : null,
    );

    // Collected fees (LPAgent only)
    if (r.lpRaw) {
      const collectedVal = safeNum(SOL_MODE ? r.lpRaw.collected_sol : r.lpRaw.collected_usd);
      if (collectedVal) {
        row(
          "Collected Fees (LPAgent)",
          null,
          SOL_MODE ? fmtSol(collectedVal) : fmtUsd(collectedVal),
          null,
        );
      }
    }

    // All-time fees (Meteora only)
    if (r.metRaw?.all_time_fee_usd) {
      row(
        "All-time Fees (Meteora)",
        fmtUsd(r.metRaw.all_time_fee_usd),
        null,
        null,
      );
    }

    // Suspicious warning
    if (r.suspicious) {
      console.log();
      console.log(
        RED + BOLD + "  ⚠  PnL% gap of " + fmt(Math.abs(r.pnlPctDiff)) + "pp detected — APIs disagree significantly!" + RESET
      );
    }
    if (r.metMissing) console.log(YELLOW + "  ⚠  Position NOT found in Meteora PnL API" + RESET);
    if (r.lpMissing)  console.log(YELLOW + "  ⚠  Position NOT found in LPAgent API" + RESET);

    console.log();
  }

  // ── Summary ─────────────────────────────────────────────────
  console.log(BOLD + SEP + RESET);
  console.log(BOLD + "\n📋  SUMMARY\n" + RESET);

  const bothPresent = rows.filter(r => !r.metMissing && !r.lpMissing);
  const suspicious  = rows.filter(r => r.suspicious);

  console.log(`Total positions   : ${rows.length}`);
  console.log(`Both APIs present : ${bothPresent.length}`);
  console.log(`Meteora only      : ${rows.filter(r => !r.metMissing && r.lpMissing).length}`);
  console.log(`LPAgent only      : ${rows.filter(r => r.metMissing && !r.lpMissing).length}`);
  console.log(`Neither API       : ${rows.filter(r => r.metMissing && r.lpMissing).length}`);

  if (totalDiffs.length > 0) {
    const avg = totalDiffs.reduce((s, v) => s + v, 0) / totalDiffs.length;
    const max = Math.max(...totalDiffs);
    console.log();
    console.log("PnL% diff stats (LPAgent − Meteora):");
    console.log(`  Avg absolute diff : ${fmt(avg)}pp`);
    console.log(`  Max absolute diff : ${fmt(max)}pp`);
  }

  if (suspicious.length > 0) {
    console.log();
    console.log(RED + BOLD + `⚠  ${suspicious.length} position(s) with suspicious diff (≥2pp):` + RESET);
    for (const r of suspicious) {
      console.log(RED + `   • ${r.name} — diff: ${fmt(r.pnlPctDiff)}pp` + RESET);
    }
  } else if (bothPresent.length > 0) {
    console.log(GREEN + "\n✅  All positions within acceptable range (<2pp diff)" + RESET);
  }

  console.log();
}

main().catch((e) => {
  console.error("\x1b[31m❌  Fatal: " + e.message + "\x1b[0m");
  process.exit(1);
});
