import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (from performance log)
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  const DIV = "<code>──────────────────</code>";
  const dateStr = now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  // Performance section
  const wins24h = perfLast24h.filter(p => p.pnl_usd > 0).length;
  const winRateStr = perfLast24h.length > 0
    ? `${Math.round(wins24h / perfLast24h.length * 100)}%  (${wins24h}/${perfLast24h.length})`
    : "—";
  const pnlSign = totalPnLUsd >= 0 ? "+" : "";
  const pnlIcon = totalPnLUsd >= 0 ? "📈" : "📉";

  // Portfolio section
  const openTotalUsd = openPositions.reduce((s, p) => s + Number(p.initial_value_usd ?? 0), 0);

  const lines = [
    `☀️ <b>Daily Briefing</b>  ·  ${dateStr}`,
    DIV,

    `${pnlIcon} <b>PERFORMANCE (24h)</b>`,
    `Net PnL:   <b>${pnlSign}$${Math.abs(totalPnLUsd).toFixed(2)}</b>`,
    `Fees:      <b>+$${totalFeesUsd.toFixed(2)}</b>`,
    `Win rate:  <b>${winRateStr}</b>`,
    DIV,

    `📂 <b>ACTIVITY</b>`,
    `Opened:  ${openedLast24h.length}  ·  Closed: ${closedLast24h.length}`,
    DIV,
  ];

  if (lessonsLast24h.length > 0) {
    lines.push(`🧠 <b>NEW LESSONS (${lessonsLast24h.length})</b>`);
    for (const l of lessonsLast24h.slice(0, 5)) {
      lines.push(`• ${l.rule.slice(0, 120)}`);
    }
    lines.push(DIV);
  }

  lines.push(`📊 <b>PORTFOLIO</b>`);
  lines.push(`Open:  <b>${openPositions.length} positions</b>${openTotalUsd > 0 ? `  ·  $${openTotalUsd.toFixed(0)}` : ""}`);
  if (perfSummary) {
    const allSign = perfSummary.total_pnl_usd >= 0 ? "+" : "";
    lines.push(`All-time:  <b>${allSign}$${perfSummary.total_pnl_usd.toFixed(2)}</b>  ·  ${perfSummary.win_rate_pct}% win rate`);
  }

  return lines.join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
