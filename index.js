import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances, swapToken } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary, bootstrapFromHistory } from "./lessons.js";
import { registerCronRestarter } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, sendHTML, notifyOutOfRange, notifyClose, isEnabled as telegramEnabled, createLiveMessage, formatPositionsList } from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits, queuePeakConfirmation, resolvePendingPeak, queueTrailingDropConfirmation, resolvePendingTrailingDrop, queueStopLossConfirmation, resolvePendingStopLoss } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);

// Auto-swap base token to SOL after direct closes (trailing TP, stop loss, /close command)
// This mirrors the auto-swap logic in executor.js for LLM-triggered closes.
async function autoSwapBaseToken(base_mint, context = "") {
  if (!base_mint) return;
  try {
    // Retry up to 3x with 5s gap — Helius can lag indexing token balance after close tx
    let token = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const balances = await getWalletBalances({});
      token = balances.tokens?.find(t => t.mint === base_mint);
      if (token?.usd >= 0.10) break;
      if (attempt < 2) {
        log("executor", `[${context}] Token ${base_mint.slice(0, 8)} not yet visible (attempt ${attempt + 1}/3) — retrying in 5s`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    if (token && token.usd >= 0.10) {
      log("executor", `[${context}] Auto-swapping ${token.symbol || base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
      await swapToken({ input_mint: base_mint, output_mint: "SOL", amount: token.balance });
    }
  } catch (e) {
    log("executor_warn", `[${context}] Auto-swap after close failed: ${e.message}`);
  }
  // Bear mode: keep only gasReserve in SOL, sweep excess → USDC
  if (config.management.bearMode) {
    try {
      const fresh = await getWalletBalances({});
      const reserve = config.management.gasReserve ?? 0.2;
      const excess = parseFloat((fresh.sol - reserve).toFixed(4));
      if (excess >= 0.05) {
        log("bear_mode", `[${context}] Sweeping ${excess} SOL → USDC (keeping ${reserve} SOL reserve)`);
        await swapToken({ input_mint: config.tokens.SOL, output_mint: config.tokens.USDC, amount: excess });
      }
    } catch (e) {
      log("bear_mode_warn", `[${context}] SOL → USDC sweep failed: ${e.message}`);
    }
  }
}

const TP_PCT = config.management.takeProfitFeePct;
const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
let _pollTriggeredAt = 0; // epoch ms — cooldown for poller-triggered management
const _peakConfirmTimers = new Map();
const _trailingDropConfirmTimers = new Map();
const _stopLossConfirmTimers = new Map();
const _pnlHistory = new Map(); // positionAddress → [{ts, pnl_pct}] — for velocity SL
const _closingPositions = new Set(); // mutex — prevents concurrent close attempts on same position
const TRAILING_PEAK_CONFIRM_DELAY_MS = 15_000;
const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;
const TRAILING_DROP_CONFIRM_DELAY_MS = 15_000;
const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 0.3;
const STOP_LOSS_CONFIRM_DELAY_MS = 15_000;
const STOP_LOSS_CONFIRM_TOLERANCE_PCT = 0.5;

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

function schedulePeakConfirmation(positionAddress) {
  if (!positionAddress || _peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      resolvePendingPeak(positionAddress, position?.pnl_pct ?? null, TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error) {
      log("state_warn", `Peak confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  _peakConfirmTimers.set(positionAddress, timer);
}

function scheduleTrailingDropConfirmation(positionAddress, { restart = false } = {}) {
  if (!positionAddress) return;
  if (_trailingDropConfirmTimers.has(positionAddress)) {
    if (!restart) return;
    clearTimeout(_trailingDropConfirmTimers.get(positionAddress));
    _trailingDropConfirmTimers.delete(positionAddress);
  }

  const timer = setTimeout(async () => {
    _trailingDropConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      const resolved = resolvePendingTrailingDrop(
        positionAddress,
        position?.pnl_pct ?? null,
        config.management.trailingDropPct,
        TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
      );
      if (resolved?.confirmed) {
        if (_closingPositions.has(positionAddress)) {
          log("state", `[Trailing TP] Skipping duplicate close for ${positionAddress} — already closing`);
          return;
        }
        log("state", `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — closing directly`);
        _closingPositions.add(positionAddress);
        try {
          const closeResult = await closePosition({ position_address: positionAddress, reason: resolved.reason });
          log("state", `[Trailing TP] Direct close succeeded for ${positionAddress}`);
          if (closeResult?.success && telegramEnabled()) {
            notifyClose({
              pair:            closeResult.pool_name || positionAddress.slice(0, 8),
              pnlUsd:          closeResult.pnl_usd          ?? 0,
              pnlPct:          closeResult.pnl_pct          ?? 0,
              feesEarned:      closeResult.fees_earned_usd,
              reason:          resolved.reason,
              rangeEfficiency: closeResult.range_efficiency,
              ageMinutes:      closeResult.age_minutes,
              deploySol:       closeResult.deploy_sol,
              depositedUsd:    closeResult.deposited_usd,
              withdrawnUsd:    closeResult.withdrawn_usd,
              positionAddress,
            }).catch(() => {});
          }
          if (closeResult?.base_mint) {
            autoSwapBaseToken(closeResult.base_mint, "Trailing TP").catch(() => {});
          }
        } catch (closeErr) {
          log("cron_error", `[Trailing TP] Direct close failed for ${positionAddress}: ${closeErr.message} — falling back to management cycle`);
          runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Trailing recheck management failed: ${e.message}`));
        } finally {
          _closingPositions.delete(positionAddress);
        }
      }
    } catch (error) {
      log("state_warn", `Trailing drop confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_DROP_CONFIRM_DELAY_MS);

  _trailingDropConfirmTimers.set(positionAddress, timer);
}

function scheduleStopLossConfirmation(positionAddress) {
  if (!positionAddress || _stopLossConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _stopLossConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      const resolved = resolvePendingStopLoss(
        positionAddress,
        position?.pnl_pct ?? null,
        config.management.stopLossPct,
        STOP_LOSS_CONFIRM_TOLERANCE_PCT,
      );
      if (resolved?.confirmed) {
        if (_closingPositions.has(positionAddress)) {
          log("state", `[Stop Loss] Skipping duplicate close for ${positionAddress} — already closing`);
          return;
        }
        log("state", `[SL recheck] Confirmed stop loss for ${positionAddress} — closing directly`);
        _closingPositions.add(positionAddress);
        try {
          const closeResult = await closePosition({ position_address: positionAddress, reason: resolved.reason });
          log("state", `[Stop Loss] Direct close succeeded for ${positionAddress}`);
          if (closeResult?.success && telegramEnabled()) {
            notifyClose({
              pair:            closeResult.pool_name || positionAddress.slice(0, 8),
              pnlUsd:          closeResult.pnl_usd          ?? 0,
              pnlPct:          closeResult.pnl_pct          ?? 0,
              feesEarned:      closeResult.fees_earned_usd,
              reason:          resolved.reason,
              rangeEfficiency: closeResult.range_efficiency,
              ageMinutes:      closeResult.age_minutes,
              deploySol:       closeResult.deploy_sol,
              depositedUsd:    closeResult.deposited_usd,
              withdrawnUsd:    closeResult.withdrawn_usd,
              positionAddress,
            }).catch(() => {});
          }
          if (closeResult?.base_mint) {
            autoSwapBaseToken(closeResult.base_mint, "Stop Loss").catch(() => {});
          }
        } catch (closeErr) {
          log("cron_error", `[Stop Loss] Direct close failed for ${positionAddress}: ${closeErr.message} — falling back to management cycle`);
          runManagementCycle({ silent: true }).catch((e) => log("cron_error", `SL recheck management failed: ${e.message}`));
        } finally {
          _closingPositions.delete(positionAddress);
        }
      }
    } catch (error) {
      log("state_warn", `Stop loss confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, STOP_LOSS_CONFIRM_DELAY_MS);

  _stopLossConfirmTimers.set(positionAddress, timer);
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  if (_promptInterval) { clearInterval(_promptInterval); _promptInterval = null; }
  _cronTasks = [];
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS trailing TP check
    const exitMap = new Map();
    for (const p of positionData) {
      if (_closingPositions.has(p.position)) continue; // already being closed by direct path
      if (!p.pnl_pct_suspicious && queuePeakConfirmation(p.position, p.pnl_pct)) {
        schedulePeakConfirmation(p.position);
      }
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        if (exit.action === "TRAILING_TP" && exit.needs_confirmation) {
          const queued = queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct);
          if (queued) scheduleTrailingDropConfirmation(p.position, { restart: true });
          continue;
        }
        if (exit.action === "STOP_LOSS" && exit.needs_confirmation) {
          if (queueStopLossConfirmation(p.position, exit.current_pnl_pct)) {
            scheduleStopLossConfirmation(p.position);
          }
          continue;
        }
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      // Sanity-check PnL against tracked initial deposit — API sometimes returns bad data
      // giving -99% PnL which would incorrectly trigger stop loss
      const tracked = getTrackedPosition(p.position);
      const pnlSuspect = (() => {
        if (p.pnl_pct == null) return false;
        if (p.pnl_pct > -90) return false; // only flag extreme negatives
        // Cross-check: if we have a tracked deposit and current value isn't near zero, it's bad data
        if (tracked?.amount_sol && (p.total_value_usd ?? 0) > 0.01) {
          log("cron_warn", `Suspect PnL for ${p.pair}: ${p.pnl_pct}% but position still has value — skipping PnL rules`);
          return true;
        }
        return false;
      })();

      // Rule 2: take profit ceiling — fires even if trailing is active (hard ceiling above trailingTriggerPct)
      if (!pnlSuspect && p.pnl_pct != null && p.pnl_pct >= config.management.takeProfitFeePct) {
        actionMap.set(p.position, { action: "CLOSE", rule: 2, reason: "take profit" });
        continue;
      }
      // Rule 3: pumped far above range
      if (p.active_bin != null && p.upper_bin != null &&
          p.active_bin > p.upper_bin + config.management.outOfRangeBinsToClose) {
        actionMap.set(p.position, { action: "CLOSE", rule: 3, reason: "pumped far above range" });
        continue;
      }
      // Rule 4: stale above range — timeout scales down with volatility (high vol = exit faster)
      {
        const vol = tracked?.volatility ?? 1;
        const effectiveOorWait = Math.round(config.management.outOfRangeWaitMinutes / Math.sqrt(Math.max(1, vol)));
        if (p.active_bin != null && p.upper_bin != null &&
            p.active_bin > p.upper_bin &&
            (p.minutes_out_of_range ?? 0) >= effectiveOorWait) {
          actionMap.set(p.position, { action: "CLOSE", rule: 4, reason: `upside OOR (${effectiveOorWait}m)` });
          continue;
        }
      }
      // Rule 4b: downside OOR — close faster, recovery from below range is rare on meme tokens
      {
        const downsideWait = config.management.downsideOorWaitMinutes ?? 10;
        if (p.active_bin != null && p.lower_bin != null &&
            p.active_bin < p.lower_bin &&
            (p.minutes_out_of_range ?? 0) >= downsideWait) {
          actionMap.set(p.position, { action: "CLOSE", rule: "4b", reason: `downside OOR (${downsideWait}m)` });
          continue;
        }
      }
      // Rule 5: fee yield too low
      if (p.fee_per_tvl_24h != null &&
          p.fee_per_tvl_24h < config.management.minFeePerTvl24h &&
          (p.age_minutes ?? 0) >= config.management.minAgeBeforeYieldCheck &&
          (p.unclaimed_fees_usd ?? 0) >= config.management.minFeesEarnedForYieldExit) {
        actionMap.set(p.position, { action: "CLOSE", rule: 5, reason: "low yield" });
        continue;
      }
      // Rule 6: spot max hold time exceeded
      {
        const spotMax = config.management.spotMaxHoldMinutes ?? 150;
        if (spotMax > 0 && (tracked?.strategy === "spot" || tracked?.strategy === "curve") &&
            (p.age_minutes ?? 0) >= spotMax) {
          actionMap.set(p.position, { action: "CLOSE", rule: 6, reason: `spot max hold ${spotMax}m` });
          continue;
        }
      }
      // Claim rule: absolute threshold OR % of position value (compound lebih sering pada posisi besar)
      {
        const unclaimed = p.unclaimed_fees_usd ?? 0;
        const autoClaimPct = config.management.autoClaimPct ?? 5;
        const pctTrigger = p.total_value_usd > 0
          ? (unclaimed / p.total_value_usd) * 100 >= autoClaimPct
          : false;
        if (unclaimed >= config.management.minClaimAmount || pctTrigger) {
          actionMap.set(p.position, { action: "CLAIM" });
          continue;
        }
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const cur = config.management.solMode ? "◎" : "$";

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const ageMin = p.age_minutes ?? 0;
      const h = Math.floor(ageMin / 60), m = ageMin % 60;
      const age = ageMin >= 60 ? `${h}h${m > 0 ? ` ${m}m` : ""}` : `${ageMin}m`;
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = `${cur}${Number(p.total_value_usd ?? 0).toFixed(2)}`;
      const fees = `${cur}${Number(p.unclaimed_fees_usd ?? 0).toFixed(2)}`;
      const pnlPct = p.pnl_pct != null ? `${Number(p.pnl_pct) >= 0 ? "+" : ""}${Number(p.pnl_pct).toFixed(1)}%` : "?%";
      const yield_ = p.fee_per_tvl_24h != null ? `yield ${Number(p.fee_per_tvl_24h).toFixed(2)}%` : null;
      const actionLabel = act.action === "INSTRUCTION" ? "HOLD" : act.action;
      const meta = [age, val, `PnL ${pnlPct}`, `fees ${fees}`, yield_, inRange].filter(Boolean).join("  ·  ");
      let line = `${p.pair}  ·  ${meta}  →  ${actionLabel}`;
      if (p.instruction) line += `\n  📌 "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n  ⚡ ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\n  Rule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n  → Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    mgmtReport = reportLines.join("\n\n") +
      `\n\n💼 ${positions.length} pos  ·  ${cur}${totalValue.toFixed(2)}  ·  fees ${cur}${totalUnclaimed.toFixed(2)}  →  ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      log("cron", `Management: ${actionPositions.length} action(s) needed — invoking LLM [model: ${config.llm.managementModel}]`);

      const actionBlocks = actionPositions.map((p) => {
        const act = actionMap.get(p.position);
        return [
          `POSITION: ${p.pair} (${p.position})`,
          `  pool: ${p.pool}`,
          `  action: ${act.action}${act.rule && act.rule !== "exit" ? ` — Rule ${act.rule}: ${act.reason}` : ""}${act.rule === "exit" ? ` — ⚡ Trailing TP: ${act.reason}` : ""}`,
          `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
          `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
          p.instruction ? `  instruction: "${p.instruction}"` : null,
        ].filter(Boolean).join("\n");
      }).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${actionPositions.length} position(s)

${actionBlocks}

RULES:
- CLOSE: call close_position only — it handles fee claiming internally, do NOT call claim_fees first
- CLAIM: call claim_fees with position address
- INSTRUCTION: evaluate the instruction condition. If met → close_position. If not → HOLD, do nothing.
- ⚡ exit alerts: close immediately, no exceptions

Execute the required actions. Do NOT re-evaluate CLOSE/CLAIM — rules already applied. Just execute.
After executing, write a brief one-line result per position.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });

      mgmtReport += `\n\n${content}`;
    } else {
      log("cron", "Management: all positions STAY — skipping LLM");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendHTML(`🔄 <b>Management Cycle</b>\n<code>──────────────────</code>\n${stripThink(mgmtReport).slice(0, 3800)}`).catch(() => { });
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      _screeningBusy = false;
      return screenReport;
    }
    const minRequired = config.management.autoCompound
      ? config.management.minSolToOpen   // auto-compound: only need enough to open any position
      : config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.sol < minRequired) {
      // Bear mode: check if USDC balance covers the shortfall (will swap before deploy)
      if (config.management.bearMode && preBalance.sol_price > 0 && preBalance.usdc > 1) {
        const totalSolEquiv = preBalance.sol + preBalance.usdc / preBalance.sol_price;
        if (totalSolEquiv >= minRequired) {
          log("cron", `Bear mode: low SOL (${preBalance.sol.toFixed(3)}) but ${preBalance.usdc.toFixed(2)} USDC available — will swap before deploy`);
          // Allow screening to proceed; USDC→SOL swap happens in executor safety check
        } else {
          log("cron", `Screening skipped — insufficient funds in bear mode (${totalSolEquiv.toFixed(3)} SOL equiv < ${minRequired})`);
          screenReport = `Screening skipped — insufficient funds (${preBalance.sol.toFixed(3)} SOL + ${preBalance.usdc.toFixed(2)} USDC < ${minRequired} SOL equiv needed).`;
          _screeningBusy = false;
          return screenReport;
        }
      } else {
        log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
        screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
        _screeningBusy = false;
        return screenReport;
      }
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    // Bear mode: wallet funds are mostly in USDC — use total value (SOL + USDC equiv) so
    // computeDeployAmount sees the real portfolio size, not just the SOL gas reserve.
    const effectiveSol = (config.management.bearMode && currentBalance.sol_price > 0)
      ? currentBalance.sol + currentBalance.usdc / currentBalance.sol_price
      : currentBalance.sol;
    // autoCompound: include locked position value so sizing is proportional to full portfolio.
    // Uses cached positions (no extra RPC call) — falls back to 0 if unavailable.
    let openPositionsValueSol = 0;
    if (config.management.autoCompound && currentBalance.sol_price > 0) {
      const cachedPos = await getMyPositions({ force: false, silent: true }).catch(() => null);
      openPositionsValueSol = (cachedPos?.positions || []).reduce((sum, p) => {
        const usd = p.total_value_true_usd;
        return usd != null ? sum + usd / currentBalance.sol_price : sum;
      }, 0);
    }
    const deployAmount = computeDeployAmount(effectiveSol, openPositionsValueSol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${effectiveSol.toFixed(3)} SOL${openPositionsValueSol > 0 ? `, positions: ${openPositionsValueSol.toFixed(3)} SOL` : ""}${config.management.bearMode ? `, USDC: ${currentBalance.usdc}` : ""})`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP default: ${activeStrategy.lp_strategy} | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for} | bins auto-calculated from config targets`
      : `No active strategy — choose bid_ask or spot based on token signals. Bins auto-calculated.`;

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      return true;
    });

    if (passing.length === 0) {
      const examples = filteredOut.slice(0, 3)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 3)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      screenReport = combinedExamples
        ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
        : `No candidates available (all filtered by launchpad / holder-quality rules).`;
      return screenReport;
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Build compact candidate blocks
    const candidateBlocks = passing.map(({ pool, sw, n, ti, mem }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      // Reversal signal: harga turun signifikan + lebih banyak seller = distribusi/dump
      const reversalRisk = priceChange != null && netBuyers != null &&
        priceChange < -3 && netBuyers < 0;

      // OKX signals
      const okxParts = [
        pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
        pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
        pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%`    : null,
        pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%`   : null,
        pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
        pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
      ].filter(Boolean).join(", ");
      const okxUnavailable = !okxParts && pool.price_vs_ath_pct == null;

      const okxTags = [
        pool.smart_money_buy    ? "smart_money_buy"    : null,
        pool.kol_in_clusters    ? "kol_in_clusters"    : null,
        pool.dex_boost          ? "dex_boost"          : null,
        pool.dex_screener_paid  ? "dex_screener_paid"  : null,
        pool.dev_sold_all       ? "dev_sold_all(bullish)" : null,
      ].filter(Boolean).join(", ");

      const block = [
        `POOL: ${pool.name} (${pool.pool})`,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
        okxParts ? `  okx: ${okxParts}` : okxUnavailable ? `  okx: unavailable` : null,
        okxTags  ? `  tags: ${okxTags}` : null,
        pool.price_vs_ath_pct != null ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        reversalRisk ? `  ⚠️ REVERSAL RISK: price ${priceChange}%, net_buyers=${netBuyers} — bearish distribution signal, skip unless strong counter-evidence` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
        mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
      ].filter(Boolean).join("\n");

      return block;
    });

    const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)}${config.management.bearMode && currentBalance.usdc > 0 ? ` + ${currentBalance.usdc.toFixed(2)} USDC` : ""} | Deploy: ${deployAmount} SOL${config.management.bearMode ? " (bear mode: USDC auto-swaps to SOL before deploy — SOL balance will look low, proceed anyway)" : ""}

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Pick the best candidate based on narrative quality, smart wallets, and pool metrics.
2. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   Choose strategy (bid_ask or spot) based on token signals. Bins are auto-calculated — pass only strategy and bin_step.
3. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Downside buffer: <negative %>

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   RISK
   <If OKX advanced/risk data exists, list only the fields that actually exist: Risk level, Bundle, Sniper, Suspicious, ATH distance, Rugpull, Wash.>
   <If only rugpull/wash exist, list just those.>
   <If OKX enrichment is missing, write exactly: OKX: unavailable>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
4. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Never write "unknown" for OKX. Use real values, omit missing fields, or write exactly "OKX: unavailable".
- Keep the whole report compact and highly scannable for Telegram.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });
    screenReport = content;
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        else sendHTML(`🔍 <b>Screening Cycle</b>\n<code>──────────────────</code>\n${stripThink(screenReport).slice(0, 3800)}`).catch(() => { });
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Lightweight 30s PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;

      // Clean up pnl history for positions no longer open
      const _activePositionSet = new Set(result.positions.map(p => p.position));
      for (const addr of _pnlHistory.keys()) {
        if (!_activePositionSet.has(addr)) _pnlHistory.delete(addr);
      }

      for (const p of result.positions) {
        // ── Velocity SL: detect rapid PnL freefall ─────────────────────
        if (!p.pnl_pct_suspicious && p.pnl_pct != null) {
          const now = Date.now();
          const windowMs = (config.management.pnlVelocityWindowSec ?? 90) * 1000;
          const hist = _pnlHistory.get(p.position) || [];
          const trimmed = hist.filter(h => now - h.ts < windowMs * 2);
          trimmed.push({ ts: now, pnl_pct: p.pnl_pct });
          _pnlHistory.set(p.position, trimmed);

          const velocityThreshold = config.management.pnlVelocitySLPct ?? 5;
          // Scale threshold by volatility — high-vol tokens have larger normal swings.
          // Same pattern as outOfRangeWait scaling (sqrt), but inverse: high vol → higher threshold.
          // Cap at 2x so even vol=9 tokens can't ignore a 10%+ freefall.
          const posVol = getTrackedPosition(p.position)?.volatility ?? 1;
          const effectiveVelocityThreshold = velocityThreshold * Math.min(2, Math.sqrt(Math.max(1, posVol)));
          const minAge = config.management.minAgeBeforeSL ?? 7;
          const windowStart = now - windowMs;
          const oldest = trimmed.find(h => h.ts >= windowStart);
          if (velocityThreshold > 0 && oldest && oldest !== trimmed[trimmed.length - 1] && (p.age_minutes ?? 0) >= minAge) {
            const drop = oldest.pnl_pct - p.pnl_pct;
            if (drop >= effectiveVelocityThreshold) {
              if (_closingPositions.has(p.position)) continue; // already being closed
              const windowSec = Math.round((now - oldest.ts) / 1000);
              const reason = `Velocity SL: PnL dropped ${drop.toFixed(2)}% in ${windowSec}s (${oldest.pnl_pct.toFixed(2)}% → ${p.pnl_pct.toFixed(2)}%)`;
              log("state", `[Velocity SL] ${p.pair}: ${reason}`);
              _pnlHistory.delete(p.position);
              _closingPositions.add(p.position);
              try {
                const closeResult = await closePosition({ position_address: p.position, reason });
                log("state", `[Velocity SL] Close succeeded for ${p.position}`);
                if (closeResult?.success && telegramEnabled()) {
                  notifyClose({
                    pair:            closeResult.pool_name || p.pair,
                    pnlUsd:          closeResult.pnl_usd          ?? 0,
                    pnlPct:          closeResult.pnl_pct          ?? 0,
                    feesEarned:      closeResult.fees_earned_usd,
                    reason,
                    rangeEfficiency: closeResult.range_efficiency,
                    ageMinutes:      closeResult.age_minutes,
                    deploySol:       closeResult.deploy_sol,
                    depositedUsd:    closeResult.deposited_usd,
                    withdrawnUsd:    closeResult.withdrawn_usd,
                    positionAddress: p.position,
                  }).catch(() => {});
                }
                if (closeResult?.base_mint) {
                  autoSwapBaseToken(closeResult.base_mint, "Velocity SL").catch(() => {});
                }
              } catch (closeErr) {
                log("cron_error", `[Velocity SL] Direct close failed for ${p.position}: ${closeErr.message} — triggering management`);
                runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Velocity SL management failed: ${e.message}`));
              } finally {
                _closingPositions.delete(p.position);
              }
              continue;
            }
          }
        }

        if (_closingPositions.has(p.position)) continue; // already being closed by direct path
        if (!p.pnl_pct_suspicious && queuePeakConfirmation(p.position, p.pnl_pct)) {
          schedulePeakConfirmation(p.position);
        }
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          if (exit.action === "TRAILING_TP" && exit.needs_confirmation) {
            const queued = queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct);
            if (queued) scheduleTrailingDropConfirmation(p.position, { restart: true });
            continue;
          }
          if (exit.action === "STOP_LOSS" && exit.needs_confirmation) {
            if (queueStopLossConfirmation(p.position, exit.current_pnl_pct)) {
              scheduleStopLossConfirmation(p.position);
            }
            continue;
          }
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval ref so stopCronJobs can clear it
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopCronJobs();
  stopPolling();
  const positions = await getMyPositions();
  log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;
let _promptInterval = null;

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;
  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendHTML("📭 <b>No open positions.</b>"); return; }
      await sendHTML(formatPositionsList(positions, { solMode: config.management.solMode }));
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendHTML(`⏳ <b>Closing ${pos.pair}…</b>`);
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        const cur = config.management.solMode ? "◎" : "$";
        const pnlUsd = Number(result.pnl_usd ?? 0);
        const pnlPct = Number(result.pnl_pct ?? 0);
        const icon = pnlUsd >= 0 ? "🟢" : "🔴";
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const feesUsd = Number(result.fees_earned_usd ?? 0);
        const feesLine = feesUsd > 0 ? `\n💎 Fees: <b>+${cur}${feesUsd.toFixed(2)}</b>` : "";
        const pnlSign = pnlUsd >= 0 ? "+" : "";
        await sendHTML(
          `${icon} <b>Closed — ${pos.pair}</b>\n` +
          `<code>──────────────────</code>\n` +
          `PnL: <b>${pnlSign}${cur}${Math.abs(pnlUsd).toFixed(2)}  (${pnlSign}${pnlPct.toFixed(2)}%)</b>` +
          feesLine +
          `\n📋 <code>${closeTxs?.[0]?.slice(0, 20) ?? "n/a"}</code>`
        );
        if (result.base_mint) {
          autoSwapBaseToken(result.base_mint, "/close command").catch(() => {});
        }
      } else {
        await sendHTML(`❌ <b>Close failed</b> — ${pos.pair}\n<i>${String(result.error ?? result.reason ?? "unknown").slice(0, 200)}</i>`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const bootstrapMatch = text.match(/^\/bootstrap\s+([1-9A-HJ-NP-Za-km-z]{32,44})$/i);
  if (bootstrapMatch) {
    const walletAddr = bootstrapMatch[1].trim();
    try {
      await sendHTML(`⏳ <b>Bootstrapping from wallet</b>\n<code>${walletAddr.slice(0, 16)}...</code>`);
      const result = await bootstrapFromHistory(walletAddr, { limit: 25 });
      await sendHTML(
        `✅ <b>Bootstrap complete</b>\n` +
        `<code>──────────────────</code>\n` +
        `📥 Imported: <b>${result.imported}</b>\n` +
        `⏭ Skipped: <b>${result.skipped}</b> (already known)\n` +
        `🧠 Lessons: <b>${result.lessons_generated}</b>`
      );
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  _promptInterval = setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  let startupCandidates = [];

  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    startupCandidates = candidates;

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /bootstrap     Import last 10 closed positions from Meteora API and learn from them
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= startupCandidates.length) {
      await runBusy(async () => {
        const pool = startupCandidates[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        startupCandidates = candidates;
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    if (input.startsWith("/bootstrap")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const limitArg = parseInt(parts[1]) || 10;
        try {
          const { Keypair } = await import("@solana/web3.js");
          const bs58 = await import("bs58");
          const wallet = Keypair.fromSecretKey(bs58.default.decode(process.env.WALLET_PRIVATE_KEY));
          const walletAddress = wallet.publicKey.toString();

          console.log(`\nBootstrapping from Meteora API: importing last ${limitArg} closed positions for ${walletAddress.slice(0, 8)}...\n`);

          const result = await bootstrapFromHistory(walletAddress, { limit: limitArg });

          console.log(`\nBootstrap complete:`);
          console.log(`  Imported:  ${result.imported} positions`);
          console.log(`  Skipped:   ${result.skipped} (already in lessons.json)`);
          console.log(`  Lessons:   ${result.lessons_generated} new lessons generated\n`);

          if (result.imported > 0) {
            const perf = getPerformanceSummary();
            if (perf) {
              console.log(`  Total positions: ${perf.total_positions_closed}`);
              console.log(`  Total PnL: $${perf.total_pnl_usd}  |  Win rate: ${perf.win_rate_pct}%`);
              console.log(`  Enriched: ${perf.enriched_count}  |  Bootstrapped: ${perf.bootstrapped_count}\n`);
            }
          }
        } catch (err) {
          console.log(`\nBootstrap failed: ${err.message}\n`);
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel);
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      const bearNote = config.management.bearMode ? " (bear mode: USDC counts toward balance — SOL will look low)" : "";
      const startupStep3 = process.env.DRY_RUN === "true"
        ? `3. Ignore wallet SOL threshold in dry run: get_top_candidates then simulate deploy ${DEPLOY} SOL.`
        : `3. If SOL${bearNote} >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL.`;
      await agentLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. ${startupStep3} 4. Report.
      `, config.llm.maxSteps, [], "SCREENER");
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
