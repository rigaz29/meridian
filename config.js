import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)      process.env.LLM_MODEL        ||= u.llmModel;
if (u.llmBaseUrl)    process.env.LLM_BASE_URL    ||= u.llmBaseUrl;
if (u.llmApiKey)     process.env.LLM_API_KEY     ||= u.llmApiKey;
if (u.minimaxApiKey) process.env.MINIMAX_API_KEY ||= u.minimaxApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);

// Derive sensible default model based on configured provider
function _defaultModel() {
  const base = process.env.LLM_BASE_URL || u.llmBaseUrl || "";
  if (base.includes("minimax.io")) return "MiniMax-M2.7";
  return "openrouter/healer-alpha";
}

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl            ?? 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    maxPriceChangePct:  u.maxPriceChangePct  ?? null, // e.g. 5 = skip pools where price_change_pct > 5% (avoid entering at pump peak); null = disabled
    maxPriceVolatility: u.maxPriceVolatility ?? 50,   // max % price swing during position (auto-evolved)
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes:   u.outOfRangeWaitMinutes   ?? 30,
    downsideOorWaitMinutes:  u.downsideOorWaitMinutes  ?? 5,   // faster exit for downside OOR (recovery rare)
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:        u.oorCooldownHours        ?? 4,   // pool cooldown after SL close (hours)
    mintCooldownHours:       u.mintCooldownHours       ?? 24,  // token cooldown after repeated SL closes (hours)
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -20,
    minAgeBeforeSL:        u.minAgeBeforeSL        ?? 7,   // minutes before stop loss can trigger
    velocitySLEnabled:     u.velocitySLEnabled     ?? true, // enable/disable velocity stop-loss
    pnlVelocitySLPct:      u.pnlVelocitySLPct      ?? 5,   // close if PnL drops X% within velocity window
    pnlVelocityWindowSec:  u.pnlVelocityWindowSec  ?? 90,  // velocity measurement window in seconds
    takeProfitFeePct:      u.takeProfitFeePct      ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck:    u.minAgeBeforeYieldCheck    ?? 60,   // minutes before low yield can trigger close
    minFeesEarnedForYieldExit: u.minFeesEarnedForYieldExit ?? 0.20, // min unclaimed fees (USD) before low yield can trigger close
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    autoCompound:          u.autoCompound          ?? false,   // scale deploy amount from wallet balance (no fixed floor)
    autoCompoundFeePct:    u.autoCompoundFeePct    ?? 0.02,   // reserve X% of wallet for tx fees (default 2%)
    bearMode:              u.bearMode              ?? false,   // swap excess SOL → USDC after close/claim; swap back before deploy
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    autoClaimPct:          u.autoClaimPct          ?? 5,    // claim when unclaimed fees >= X% of position value
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:         u.strategy         ?? "bid_ask",
    lpStrategyMode:      u.lpStrategyMode      ?? "auto",  // "bid_ask" | "spot" | "auto" | "fee_tvl"
    ftvlThreshold:       u.ftvlThreshold       ?? 1.2,   // fee_tvl mode: fee/tvl <= this → spot, > this → bid_ask (1.2 = backtest cutoff where bid_ask wins +1.59pp)
    targetDownsidePct: u.targetDownsidePct ?? 0.35,  // cover X% price drop below active bin
    targetUpsidePct:   u.targetUpsidePct   ?? 0.20,  // cover X% price rise above active bin (spot only)
    dynamicBinsAbove:  u.dynamicBinsAbove  ?? true,  // dynamic empty buffer bins above active bin for SOL-only/bid_ask: scales with vol+bin_step, max 12 at vol=5/bs=80. false = no buffer (0 bins)
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    // Default model: respect explicit overrides, then infer from provider
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? _defaultModel(),
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? _defaultModel(),
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? _defaultModel(),
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 *
 * Two modes:
 *
 * autoCompound=false (default — fixed floor):
 *   reserve   = gasReserve (fixed SOL)
 *   deployable = walletSol - reserve
 *   result    = clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * autoCompound=true (portfolio-aware, no fixed floor):
 *   totalPortfolio = walletSol + openPositionsValueSol
 *   reserve   = totalPortfolio × autoCompoundFeePct (default 2%)
 *   deployable = totalPortfolio - reserve
 *   result    = clamp(deployable × positionSizePct, floor=0, ceil=maxDeployAmount)
 *   → deploy amount scales with the FULL portfolio (free + locked), not just free wallet
 *   → actual deploy is capped by executor safety check (amount_y + gasReserve ≤ free SOL)
 *
 * @param {number} walletSol              Free SOL in wallet
 * @param {number} [openPositionsValueSol=0]  Total value of open LP positions in SOL equiv
 *                                         (autoCompound mode only — ignored in fixed-floor mode)
 *
 * Examples at autoCompound=true (positionSizePct=0.35, feePct=0.02, 1 open position = 1.0 SOL):
 *   1.0 SOL wallet → total 2.0 SOL → 0.69 SOL deploy
 *   2.0 SOL wallet → total 3.0 SOL → 1.03 SOL deploy
 *   5.0 SOL wallet → total 6.0 SOL → 2.06 SOL deploy
 */
export function computeDeployAmount(walletSol, openPositionsValueSol = 0) {
  const m    = config.management;
  const ceil = config.risk.maxDeployAmount;

  if (m.autoCompound) {
    const feePct        = m.autoCompoundFeePct ?? 0.02;
    const totalPortfolio = walletSol + openPositionsValueSol;
    const reserve       = totalPortfolio * feePct;
    const deployable    = Math.max(0, totalPortfolio - reserve);
    const dynamic       = deployable * (m.positionSizePct ?? 0.35);
    return parseFloat(Math.min(ceil, dynamic).toFixed(2));
  }

  // Fixed-floor mode (legacy default)
  const reserve    = m.gasReserve      ?? 0.2;
  const pct        = m.positionSizePct ?? 0.35;
  const floor      = m.deployAmountSol;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  return parseFloat(Math.min(ceil, Math.max(floor, dynamic)).toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         != null) s.maxTvl         = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxPriceChangePct !== undefined) s.maxPriceChangePct = fresh.maxPriceChangePct;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.maxPriceVolatility != null) s.maxPriceVolatility = fresh.maxPriceVolatility;
  } catch (err) {
    log("config_error", `Failed to reload screening thresholds: ${err.message}`);
  }
}
