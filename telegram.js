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

  const meta = [
    amountSol != null ? `◎ ${Number(amountSol).toFixed(3)} SOL` : null,
    strategy ? strategy : null,
    binStep  ? `bs=${binStep}` : null,
    baseFee  != null ? `fee ${baseFee}%` : null,
  ].filter(Boolean).join("  ·  ");

  const rangeStr = priceRange
    ? `\n📊 <code>${fmtPrice(priceRange.min)}</code>  →  <code>${fmtPrice(priceRange.max)}</code>`
    : "";

  await sendHTML(
    `🚀 <b>DEPLOYED — ${esc(pair)}</b>\n` +
    `<code>${DIV}</code>\n` +
    (meta ? `<code>${esc(meta)}</code>` : "") +
    rangeStr +
    `\n🔑 <code>${position?.slice(0, 20) ?? "?"}</code>` +
    (tx ? `\n📋 <code>${tx.slice(0, 20)}</code>` : "")
  );
}

export async function notifyClose({
  pair, pnlUsd, pnlPct, feesEarned, reason, rangeEfficiency,
  ageMinutes, deploySol, depositedUsd, withdrawnUsd, positionAddress,
}) {
  if (hasActiveLiveMessage()) return;

  const pnlVal = Number(pnlUsd ?? 0);
  const profit = pnlVal >= 0;
  const icon   = profit ? "🟢" : "🔴";

  const reasonTag = (() => {
    if (!reason) return null;
    const r = String(reason);
    if (/trailing/i.test(r))           return `🔔 ${r}`;
    if (/stop.?loss/i.test(r))         return `🛑 ${r}`;
    if (/take.?profit|tp/i.test(r))    return `🎯 ${r}`;
    if (/out.?of.?range|oor/i.test(r)) return `📤 ${r}`;
    if (/low.?yield|yield/i.test(r))   return `📉 ${r}`;
    if (/velocity/i.test(r))           return `⚡ ${r}`;
    if (/pump|above.?range/i.test(r))  return `🚀 ${r}`;
    return `📌 ${r}`;
  })();

  // PnL hero line
  const pnlHero = `<b>${fmtUsd(pnlUsd)}</b>  <b>${fmtPct(pnlPct)}</b>`;

  // Stat row: fees · age · deployed
  const statParts = [];
  const fees = Number(feesEarned ?? 0);
  if (fees > 0) statParts.push(`💎 $${fees.toFixed(2)} fees`);
  if (ageMinutes != null) {
    const h = Math.floor(ageMinutes / 60), m = ageMinutes % 60;
    statParts.push(`⏱ ${h > 0 ? `${h}h ${m}m` : `${m}m`}`);
  }
  if (deploySol != null) statParts.push(`◎ ${Number(deploySol).toFixed(3)}`);
  const statsLine = statParts.length ? statParts.join("  ·  ") : null;

  // Capital flow
  const flowLine = (depositedUsd != null && withdrawnUsd != null && depositedUsd > 0)
    ? `💰 $${Number(depositedUsd).toFixed(2)}  →  $${Number(withdrawnUsd).toFixed(2)}`
    : null;

  // Range bar
  const effLine = rangeEfficiency != null
    ? `📐 <code>${progressBar(rangeEfficiency, 14)}</code> ${Number(rangeEfficiency).toFixed(0)}%`
    : null;

  const addrLine = positionAddress
    ? `🔑 <code>${positionAddress.slice(0, 20)}</code>`
    : null;

  const lines = [
    `${icon} <b>CLOSED — ${esc(pair)}</b>`,
    `<code>${DIV}</code>`,
    reasonTag ? esc(reasonTag) : null,
    reasonTag ? `<code>${DIV}</code>` : null,
    pnlHero,
    statsLine,
    flowLine,
    effLine,
    addrLine,
  ].filter(Boolean);

  await sendHTML(lines.join("\n"));
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;

  const inVal  = amountIn  != null ? Number(amountIn)  : null;
  const outVal = amountOut != null ? Number(amountOut) : null;
  const inStr  = inVal  != null ? inVal.toLocaleString("en",  { maximumFractionDigits: 6 }) : "?";
  const outStr = outVal != null ? outVal.toLocaleString("en", { maximumFractionDigits: 6 }) : "?";

  const rateStr = (inVal && outVal && inVal > 0)
    ? `\n⚡ <code>1 ${esc(inputSymbol ?? "?")} = ${(outVal / inVal).toLocaleString("en", { maximumFractionDigits: 8 })} ${esc(outputSymbol ?? "?")}</code>`
    : "";

  await sendHTML(
    `🔄 <b>SWAPPED</b>  <b>${esc(inputSymbol ?? "?")} → ${esc(outputSymbol ?? "?")}</b>\n` +
    `<code>${DIV}</code>\n` +
    `📥 <code>${inStr}</code>  →  📤 <code>${outStr}</code>` +
    rateStr +
    (tx ? `\n📋 <code>${tx.slice(0, 20)}</code>` : "")
  );
}

export async function notifyOutOfRange({ pair, minutesOOR, direction }) {
  if (hasActiveLiveMessage()) return;
  const dirTag = direction === "up"   ? "📈 price above range" :
                 direction === "down" ? "📉 price below range" : "";
  await sendHTML(
    `⚠️ <b>OOR — ${esc(pair)}</b>\n` +
    `<code>${DIV}</code>\n` +
    `⏱ <b>${minutesOOR}m</b> out of range${dirTag ? `  ·  ${dirTag}` : ""}\n` +
    `<i>Will close if no recovery</i>`
  );
}

/**
 * Render a formatted HTML /positions list.
 * Called from index.js Telegram command handler.
 */
export function formatPositionsList(positions, { solMode = false } = {}) {
  const cur = solMode ? "◎" : "$";
  const total = positions.length;
  const totalVal = positions.reduce((s, p) => s + Number(p.total_value_usd ?? 0), 0);

  const lines = positions.map((p, i) => {
    const pnlUsd = Number(p.pnl_usd ?? 0);
    const pnlPct = Number(p.pnl_pct ?? 0);
    const val    = Number(p.total_value_usd ?? 0);
    const fees   = Number(p.unclaimed_fees_usd ?? 0);
    const ageMin = p.age_minutes ?? 0;
    const h = Math.floor(ageMin / 60), m = ageMin % 60;
    const age = ageMin >= 60 ? `${h}h${m > 0 ? ` ${m}m` : ""}` : `${ageMin}m`;
    const inRange = p.in_range;
    const rangeTag = inRange
      ? `🟢 in range`
      : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
    const pnlIcon = pnlUsd >= 0 ? "▲" : "▼";

    return (
      `<b>${i + 1}. ${esc(p.pair)}</b>  ·  ⏱ ${age}\n` +
      `   ${cur}${val.toFixed(2)}  ·  PnL <b>${fmtUsd(pnlUsd)} (${pnlIcon}${Math.abs(pnlPct).toFixed(2)}%)</b>\n` +
      `   💎 ${cur}${fees.toFixed(2)} fees  ·  ${rangeTag}`
    );
  });

  const header = `📊 <b>Positions (${total})</b>  ·  ${cur}${totalVal.toFixed(2)} total`;

  return (
    header + `\n<code>${DIV}</code>\n` +
    lines.join(`\n<code>${DIV}</code>\n`) +
    `\n<code>${DIV}</code>\n` +
    `<i>/close &lt;n&gt;  ·  /set &lt;n&gt; &lt;note&gt;</i>`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
