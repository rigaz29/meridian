import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId   = process.env.TELEGRAM_CHAT_ID || null;
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch { /**/ }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== chatId) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Formatting helpers ──────────────────────────────────────────
const DIV = "──────────────────";

/** Escape special HTML chars for Telegram HTML mode */
function esc(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtPct(pct) {
  const v = Number(pct ?? 0);
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtUsd(usd) {
  const v = Number(usd ?? 0);
  return `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
}

function fmtPrice(p) {
  if (p == null) return "?";
  return p < 0.0001 ? p.toExponential(3) : p.toFixed(6);
}

function progressBar(pct, width = 16) {
  const filled = Math.round((Math.min(Math.max(pct, 0), 100) / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function postTelegram(method, body) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

async function editHTML(html, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: html.slice(0, 4096),
    parse_mode: "HTML",
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info:            "Token info",
    get_token_narrative:       "Token narrative",
    get_token_holders:         "Token holders",
    get_top_candidates:        "Top candidates",
    get_pool_detail:           "Pool detail",
    get_active_bin:            "Active bin",
    deploy_position:           "Deploy position",
    close_position:            "Close position",
    claim_fees:                "Claim fees",
    swap_token:                "Swap token",
    update_config:             "Update config",
    get_my_positions:          "Positions",
    get_wallet_balance:        "Wallet balance",
    check_smart_wallets_on_pool: "Smart wallets",
    study_top_lpers:           "Study top LPers",
    get_top_lpers:             "Top LPers",
    search_pools:              "Search pools",
    discover_pools:            "Discover pools",
    check_pool_eligibility:    "Pool eligibility check",
    get_position_pnl:          "Position PnL",
    set_position_note:         "Set note",
    get_pool_ohlcv:            "Pool OHLCV",
    bootstrap_history:         "Bootstrap history",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed ✓" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `${result.claimed_amount} SOL` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    case "check_pool_eligibility":
      return result.eligible ? "eligible ✓" : `rejected — ${result.fail_reason ?? "criteria not met"}`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

// ─── Live message (agent thinking indicator) ─────────────────────
export async function createLiveMessage(title, intro = "Starting...") {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    lastSentHtml: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render() {
    const parts = [
      `<b>${esc(state.title)}</b>`,
      state.intro ? esc(state.intro) : null,
      state.toolLines.length > 0 ? `<code>${DIV}</code>\n${state.toolLines.join("\n")}` : null,
      state.footer ? `<code>${DIV}</code>\n${esc(state.footer)}` : null,
    ].filter(Boolean);
    return parts.join("\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const html = render();
    if (!state.messageId) {
      const sent = await sendHTML(html);
      state.messageId = sent?.result?.message_id ?? null;
      state.lastSentHtml = html;
      return;
    }
    if (html === state.lastSentHtml) return;
    await editHTML(html, state.messageId);
    state.lastSentHtml = html;
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const line = `${icon} <i>${esc(label)}</i>${suffix ? ` — ${esc(suffix)}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(`<i>${esc(label)}</i>`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "⏳", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary || "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────

export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, binStep, baseFee, strategy }) {
  if (hasActiveLiveMessage()) return;

  const rangeStr = priceRange
    ? `\n📊 Range: <code>${fmtPrice(priceRange.min)}</code> – <code>${fmtPrice(priceRange.max)}</code>`
    : "";
  const poolStr = (binStep || baseFee)
    ? `\n⚙️ Bin step: <b>${binStep ?? "?"}</b>  │  Base fee: <b>${baseFee != null ? baseFee + "%" : "?"}</b>${strategy ? `  │  Strategy: <b>${strategy}</b>` : ""}`
    : strategy ? `\n🎯 Strategy: <b>${strategy}</b>` : "";

  await sendHTML(
    `✅ <b>DEPLOYED — ${esc(pair)}</b>\n` +
    `<code>${DIV}</code>\n` +
    `💰 Amount: <b>${amountSol} SOL</b>` +
    poolStr +
    rangeStr +
    `\n🔑 Position: <code>${position?.slice(0, 12)}...</code>` +
    (tx ? `\n📋 Tx: <code>${tx.slice(0, 16)}...</code>` : "")
  );
}

export async function notifyClose({
  pair, pnlUsd, pnlPct, feesEarned, reason, rangeEfficiency,
  ageMinutes, deploySol, depositedUsd, withdrawnUsd, positionAddress,
  strategy, binStep, volatility,
}) {

  const pnlNum    = Number(pnlUsd ?? 0);
  const pnlPctNum = Number(pnlPct ?? 0);
  const profit    = pnlNum >= 0;

  // ── Exit type → icon + label ──────────────────────────────────
  const exitType = (() => {
    const r = String(reason ?? "");
    if (/trailing/i.test(r))           return { icon: "🔔", label: "Trailing TP" };
    if (/velocity/i.test(r))           return { icon: "⚡", label: "Velocity SL" };
    if (/stop.?loss/i.test(r))         return { icon: "🛑", label: "Stop Loss" };
    if (/take.?profit|static.?tp/i.test(r)) return { icon: "🎯", label: "Take Profit" };
    if (/downside.*oor|oor.*4b/i.test(r))   return { icon: "📉", label: "Downside OOR" };
    if (/upside.*oor|out.?of.?range/i.test(r)) return { icon: "📊", label: "OOR" };
    if (/low.?yield|yield/i.test(r))   return { icon: "😴", label: "Low Yield" };
    if (/pump|above.?range/i.test(r))  return { icon: "🚀", label: "Pumped OOR" };
    if (/user|manual/i.test(r))        return { icon: "👤", label: "Manual" };
    return { icon: "📌", label: "Closed" };
  })();

  const resultIcon = profit ? "🟢" : "🔴";

  // ── Format age ────────────────────────────────────────────────
  function fmtAge(min) {
    if (min == null) return "?";
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  // ── Capital flow ──────────────────────────────────────────────
  const dep  = Number(depositedUsd ?? 0);
  const with_ = Number(withdrawnUsd ?? 0);
  const flowStr = dep > 0
    ? `$${dep.toFixed(2)} → $${with_.toFixed(2)}`
    : null;

  // ── Fees ──────────────────────────────────────────────────────
  const fees = Number(feesEarned ?? 0);

  // ── Range efficiency bar ──────────────────────────────────────
  const eff = rangeEfficiency != null ? Number(rangeEfficiency) : null;
  const effBar = eff != null
    ? `${progressBar(eff, 14)} ${eff.toFixed(0)}%`
    : null;

  // ── Pool meta ────────────────────────────────────────────────
  const metaParts = [];
  if (binStep)   metaParts.push(`bs=${binStep}`);
  if (strategy)  metaParts.push(strategy);
  if (volatility != null) metaParts.push(`vol=${Number(volatility).toFixed(2)}`);
  const metaStr = metaParts.length ? metaParts.join("  ·  ") : null;

  // ── Reason detail (strip label prefix if redundant) ──────────
  const reasonDetail = (() => {
    if (!reason) return null;
    const r = String(reason);
    // Strip "Trailing TP: " / "Velocity SL: " prefix — already shown in header
    return r.replace(/^(Trailing TP|Velocity SL|Stop Loss|Take Profit|OOR)[:\s-]*/i, "").trim() || null;
  })();

  // ── Build message ─────────────────────────────────────────────
  const lines = [
    // Header
    `${exitType.icon} <b>${esc(exitType.label)}</b>  ${resultIcon} <b>${esc(pair)}</b>`,
    `<code>${DIV}</code>`,

    // PnL — most important, biggest visual weight
    `<b>${profit ? "▲" : "▼"} ${fmtPct(pnlPctNum)}</b>  <code>${fmtUsd(pnlNum)}</code>`,

    // Capital flow
    flowStr ? `💰 ${esc(flowStr)}` : null,

    // Fees
    fees > 0 ? `💎 Fees  <code>+$${fees.toFixed(2)}</code>` : null,

    `<code>${DIV}</code>`,

    // Position stats
    `⏱ Held  <b>${esc(fmtAge(ageMinutes))}</b>` +
      (deploySol != null ? `   ·   ◎${Number(deploySol).toFixed(3)} deployed` : ""),

    effBar ? `📐 In-range  <code>${esc(effBar)}</code>` : null,

    metaStr ? `⚙️ <i>${esc(metaStr)}</i>` : null,

    // Reason detail (only if there's meaningful extra info)
    reasonDetail
      ? `<code>${DIV}</code>\n<i>${esc(reasonDetail)}</i>`
      : null,

    // Position address
    positionAddress
      ? `<code>${DIV}</code>\n🔑 <code>${positionAddress.slice(0, 20)}…</code>`
      : null,
  ].filter(Boolean);

  await sendHTML(lines.join("\n"));
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;

  const inStr  = amountIn  != null ? String(Number(amountIn).toLocaleString("en", { maximumFractionDigits: 6 }))  : "?";
  const outStr = amountOut != null ? String(Number(amountOut).toLocaleString("en", { maximumFractionDigits: 6 })) : "?";

  await sendHTML(
    `🔄 <b>SWAPPED</b>\n` +
    `<code>${DIV}</code>\n` +
    `<b>${esc(inputSymbol ?? "?")} → ${esc(outputSymbol ?? "?")}</b>\n` +
    `📥 In: <code>${inStr}</code>\n` +
    `📤 Out: <code>${outStr}</code>` +
    (tx ? `\n📋 Tx: <code>${tx.slice(0, 16)}...</code>` : "")
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `⚠️ <b>OUT OF RANGE — ${esc(pair)}</b>\n` +
    `<code>${DIV}</code>\n` +
    `⏱ OOR for <b>${minutesOOR}m</b> — will close if no recovery`
  );
}

/**
 * Render a formatted HTML /positions list.
 * Called from index.js Telegram command handler.
 */
export function formatPositionsList(positions, { solMode = false } = {}) {
  const cur = solMode ? "◎" : "$";
  const total = positions.length;

  const lines = positions.map((p, i) => {
    const pnlUsd = Number(p.pnl_usd ?? 0);
    const pnlPct = Number(p.pnl_pct ?? 0);
    const val    = Number(p.total_value_usd ?? 0);
    const fees   = Number(p.unclaimed_fees_usd ?? 0);
    const age    = p.age_minutes != null ? `${p.age_minutes}m` : "?";
    const inRange = p.in_range;
    const oor = !inRange ? `🔴 OOR ${p.minutes_out_of_range ?? 0}m` : "🟢 In range";
    const pnlSign = pnlUsd >= 0 ? "+" : "";

    return (
      `<b>${i + 1}. ${esc(p.pair)}</b>  <i>${age}</i>\n` +
      `   ${cur}${val.toFixed(2)} │ PnL: <b>${pnlSign}${cur}${Math.abs(pnlUsd).toFixed(2)} (${fmtPct(pnlPct)})</b>\n` +
      `   💎 Fees: ${cur}${fees.toFixed(2)} │ ${oor}`
    );
  });

  return (
    `📊 <b>Open Positions (${total})</b>\n` +
    `<code>${DIV}</code>\n` +
    lines.join(`\n<code>${DIV}</code>\n`) +
    `\n<code>${DIV}</code>\n` +
    `<i>/close &lt;n&gt; • /set &lt;n&gt; &lt;note&gt;</i>`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
