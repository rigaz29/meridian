import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";



/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */
export async function discoverPools({
  page_size = 50,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    `tvl<=${s.maxTvl}`,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    "quote_token_organic_score>=60",
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
  ].filter(Boolean).join("&&");

  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${s.timeframe}` +
    `&category=${s.category}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();

  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const condensed = (data.data || [])
    .filter((p) => p.token_y?.address === SOL_MINT)
    .map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  return {
    total: data.total,
    pools,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  const { pools } = await discoverPools({ page_size: 50 });
  const filteredOut = [];

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));

  const eligible = pools
    .filter((p) => {
      if (occupiedPools.has(p.pool)) {
        pushFilteredReason(filteredOut, p, "already have an open position in this pool");
        return false;
      }
      if (occupiedMints.has(p.base?.mint)) {
        pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
        return false;
      }
      if (isPoolOnCooldown(p.pool)) {
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "pool cooldown active");
        return false;
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "token cooldown active");
        return false;
      }
      return true;
    })
    .slice(0, limit);

  // Enrich with OKX data — advanced info (risk/bundle/sniper) + ATH price (no API key required)
  if (eligible.length > 0) {
    const { getAdvancedInfo, getPriceInfo, getClusterList, getRiskFlags } = await import("./okx.js");
    const okxResults = await Promise.allSettled(
      eligible.map(async (p) => {
        if (!p.base?.mint) return { adv: null, price: null, clusters: [], risk: null };
        const [adv, price, clusters, risk] = await Promise.allSettled([
          getAdvancedInfo(p.base.mint),
          getPriceInfo(p.base.mint),
          getClusterList(p.base.mint),
          getRiskFlags(p.base.mint),
        ]);

        const mintShort = p.base.mint.slice(0, 8);
        if (adv.status !== "fulfilled")      log("okx", `advanced-info unavailable for ${p.name} (${mintShort})`);
        if (price.status !== "fulfilled")    log("okx", `price-info unavailable for ${p.name} (${mintShort})`);
        if (clusters.status !== "fulfilled") log("okx", `cluster-list unavailable for ${p.name} (${mintShort})`);
        if (risk.status !== "fulfilled")     log("okx", `risk-check unavailable for ${p.name} (${mintShort})`);

        return {
          adv: adv.status === "fulfilled" ? adv.value : null,
          price: price.status === "fulfilled" ? price.value : null,
          clusters: clusters.status === "fulfilled" ? clusters.value : [],
          risk: risk.status === "fulfilled" ? risk.value : null,
        };
      })
    );
    for (let i = 0; i < eligible.length; i++) {
      const r = okxResults[i];
      if (r.status !== "fulfilled") continue;
      const { adv, price, clusters, risk } = r.value;
      if (adv) {
        eligible[i].risk_level      = adv.risk_level;
        eligible[i].bundle_pct      = adv.bundle_pct;
        eligible[i].sniper_pct      = adv.sniper_pct;
        eligible[i].suspicious_pct  = adv.suspicious_pct;
        eligible[i].smart_money_buy = adv.smart_money_buy;
        eligible[i].dev_sold_all    = adv.dev_sold_all;
        eligible[i].dex_boost       = adv.dex_boost;
        eligible[i].dex_screener_paid = adv.dex_screener_paid;
        if (adv.creator && !eligible[i].dev) eligible[i].dev = adv.creator;
      }
      if (risk) {
        eligible[i].is_rugpull = risk.is_rugpull;
        eligible[i].is_wash    = risk.is_wash;
      }
      if (price) {
        eligible[i].price_vs_ath_pct = price.price_vs_ath_pct;
        eligible[i].ath              = price.ath;
      }
      if (clusters?.length) {
        // Surface KOL presence and top cluster trend for LLM
        eligible[i].kol_in_clusters      = clusters.some((c) => c.has_kol);
        eligible[i].top_cluster_trend    = clusters[0]?.trend ?? null;      // buy|sell|neutral
        eligible[i].top_cluster_hold_pct = clusters[0]?.holding_pct ?? null;
      }
    }
    // Wash trading hard filter — fake volume = misleading fee yield
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (p.is_wash) {
        log("screening", `Risk filter: dropped ${p.name} — wash trading flagged`);
        pushFilteredReason(filteredOut, p, "wash trading flagged");
        return false;
      }
      return true;
    }));

    // ATH filter — drop pools where price is too close to ATH
    const athFilter = config.screening.athFilterPct;
    if (athFilter != null) {
      const threshold = 100 + athFilter; // e.g. -20 → threshold = 80 (price must be <= 80% of ATH)
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.price_vs_ath_pct == null) return true; // no data → don't filter
        if (p.price_vs_ath_pct > threshold) {
          log("screening", `ATH filter: dropped ${p.name} — ${p.price_vs_ath_pct}% of ATH (limit: ${threshold}%)`);
          pushFilteredReason(filteredOut, p, `${p.price_vs_ath_pct}% of ATH > ${threshold}% limit`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `ATH filter removed ${before - eligible.length} pool(s)`);
    }

    // Drop any pools whose creator is on the dev blocklist (caught via advanced-info)
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer (okx) ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via OKX creator check`);
  }

  return {
    candidates: eligible,
    total_screened: pools.length,
    filtered_examples: filteredOut.slice(0, 3),
  };
}

/**
 * Check whether a specific pool/coin passes all screening criteria.
 * Returns a pass/fail verdict per criterion and an overall summary.
 */
export async function checkPoolEligibility({ pool_address, timeframe = "1h" }) {
  if (!pool_address) return { error: "pool_address required" };

  const s = config.screening;
  const checks = [];
  let pool = null;

  // ── Fetch pool detail ──────────────────────────────────────────
  try {
    pool = await getPoolDetail({ pool_address, timeframe });
  } catch (e) {
    return { error: `Could not fetch pool: ${e.message}` };
  }

  const base = pool.token_x || {};
  const baseMint = base.address;
  const binStep = pool.dlmm_params?.bin_step ?? null;
  const mcap = base.market_cap ?? null;
  const holders = pool.base_token_holders ?? null;
  const volume = pool.volume ?? null;
  const tvl = pool.tvl ?? null;
  const activeTvl = pool.active_tvl ?? null;
  const fee = pool.fee ?? null;
  const feeActiveTvlRatio = pool.fee_active_tvl_ratio > 0
    ? pool.fee_active_tvl_ratio
    : (activeTvl > 0 ? (fee / activeTvl) * 100 : 0);
  const organicScore = Math.round(base.organic_score || 0);
  const tokenAgeHours = base.created_at
    ? Math.floor((Date.now() - base.created_at) / 3_600_000)
    : null;
  const dev = base.dev || null;

  function check(name, pass, value, threshold, note) {
    checks.push({ name, pass, value: value ?? "n/a", threshold: threshold ?? "n/a", note: note || null });
  }

  // ── Blacklist / blocklist ──────────────────────────────────────
  const blacklisted = isBlacklisted(baseMint);
  check("token_blacklist", !blacklisted, base.symbol, "not blacklisted",
    blacklisted ? "Token is on permanent blacklist" : null);

  const devBlocked = dev ? isDevBlocked(dev) : false;
  check("dev_blocklist", !devBlocked, dev ? dev.slice(0, 8) : "unknown", "not blocked",
    devBlocked ? "Deployer wallet is on blocklist" : null);

  // ── Cooldown ───────────────────────────────────────────────────
  const poolCooldown = isPoolOnCooldown(pool_address);
  check("pool_cooldown", !poolCooldown, pool_address.slice(0, 8), "not on cooldown",
    poolCooldown ? "Pool is on cooldown (recent OOR streak or low yield close)" : null);

  const mintCooldown = baseMint ? isBaseMintOnCooldown(baseMint) : false;
  check("token_cooldown", !mintCooldown, base.symbol, "not on cooldown",
    mintCooldown ? "Token is on cooldown across pools" : null);

  // ── API hard filters ───────────────────────────────────────────
  check("pool_type", pool.pool_type === "dlmm", pool.pool_type, "dlmm");

  check("bin_step", binStep != null && binStep >= s.minBinStep && binStep <= s.maxBinStep,
    binStep, `${s.minBinStep}–${s.maxBinStep}`);

  check("mcap", mcap != null && mcap >= s.minMcap && mcap <= s.maxMcap,
    mcap ? `$${Math.round(mcap / 1000)}k` : null, `$${s.minMcap / 1000}k–$${s.maxMcap / 1000000}M`);

  check("holders", holders != null && holders >= s.minHolders,
    holders, `≥${s.minHolders}`);

  check("volume", volume != null && volume >= s.minVolume,
    volume ? `$${Math.round(volume)}` : null, `≥$${s.minVolume}`);

  check("tvl", tvl != null && tvl >= s.minTvl && tvl <= s.maxTvl,
    tvl ? `$${Math.round(tvl)}` : null, `$${s.minTvl / 1000}k–$${s.maxTvl / 1000}k`);

  check("fee_active_tvl_ratio", feeActiveTvlRatio >= s.minFeeActiveTvlRatio,
    feeActiveTvlRatio.toFixed(4), `≥${s.minFeeActiveTvlRatio}`);

  check("organic_score", organicScore >= s.minOrganic,
    organicScore, `≥${s.minOrganic}`);

  if (s.minTokenAgeHours != null) {
    check("token_age_min", tokenAgeHours != null && tokenAgeHours >= s.minTokenAgeHours,
      tokenAgeHours != null ? `${tokenAgeHours}h` : null, `≥${s.minTokenAgeHours}h`);
  }
  if (s.maxTokenAgeHours != null) {
    check("token_age_max", tokenAgeHours != null && tokenAgeHours <= s.maxTokenAgeHours,
      tokenAgeHours != null ? `${tokenAgeHours}h` : null, `≤${s.maxTokenAgeHours}h`);
  }

  const criticalWarnings = base.warnings?.length > 0;
  check("no_critical_warnings", !criticalWarnings,
    criticalWarnings ? `${base.warnings.length} warning(s)` : "none", "0 warnings");

  // ── OKX enrichment ────────────────────────────────────────────
  let okxSummary = null;
  if (baseMint) {
    try {
      const { getAdvancedInfo, getPriceInfo, getRiskFlags } = await import("./okx.js");
      const [adv, price, risk] = await Promise.allSettled([
        getAdvancedInfo(baseMint),
        getPriceInfo(baseMint),
        getRiskFlags(baseMint),
      ]);

      if (risk.status === "fulfilled" && risk.value) {
        check("wash_trading", !risk.value.is_wash, risk.value.is_wash ? "flagged" : "clean", "not flagged");
        check("rugpull_flag", !risk.value.is_rugpull, risk.value.is_rugpull ? "flagged" : "clean", "not flagged",
          risk.value.is_rugpull ? "OKX flagged as rugpull — skip unless strong smart wallet signal" : null);
      }

      const athFilter = s.athFilterPct;
      if (price.status === "fulfilled" && price.value) {
        const priceVsAth = price.value.price_vs_ath_pct;
        if (athFilter != null) {
          const threshold = 100 + athFilter;
          check("ath_filter", priceVsAth == null || priceVsAth <= threshold,
            priceVsAth != null ? `${priceVsAth}%` : "n/a", `≤${threshold}% of ATH`);
        }
        okxSummary = {
          ...(okxSummary || {}),
          price_vs_ath_pct: price.value.price_vs_ath_pct,
          ath: price.value.ath,
        };
      }

      if (adv.status === "fulfilled" && adv.value) {
        const a = adv.value;
        okxSummary = {
          ...(okxSummary || {}),
          risk_level: a.risk_level,
          bundle_pct: a.bundle_pct,
          sniper_pct: a.sniper_pct,
          suspicious_pct: a.suspicious_pct,
          smart_money_buy: a.smart_money_buy,
          dev_sold_all: a.dev_sold_all,
          dex_boost: a.dex_boost,
        };

        // Soft checks (advisory, not hard fails)
        check("bundle_pct_advisory", a.bundle_pct == null || a.bundle_pct < 50,
          a.bundle_pct != null ? `${a.bundle_pct}%` : "n/a", "<50% (advisory)",
          a.bundle_pct >= 50 ? "High bundle % — LLM should weigh this negatively" : null);
      }
    } catch (e) {
      log("screening", `checkPoolEligibility: OKX enrichment failed: ${e.message}`);
    }
  }

  // ── Overall verdict ────────────────────────────────────────────
  const hardFails = checks.filter((c) => !c.pass);
  const passed = hardFails.length === 0;

  // Build human-readable summary
  const passLines = checks.filter((c) => c.pass).map((c) => `✓ ${c.name}: ${c.value}`);
  const failLines = hardFails.map((c) => `✗ ${c.name}: ${c.value} (need ${c.threshold})${c.note ? " — " + c.note : ""}`);

  return {
    pool: pool_address,
    name: pool.name || `${base.symbol}-${pool.token_y?.symbol}`,
    base_symbol: base.symbol,
    base_mint: baseMint,
    passed,
    hard_fails: hardFails.length,
    summary: passed
      ? `PASS — ${base.symbol} meets all ${checks.length} screening criteria.`
      : `FAIL — ${base.symbol} fails ${hardFails.length}/${checks.length} criteria: ${hardFails.map((c) => c.name).join(", ")}.`,
    checks,
    pass_list: passLines,
    fail_list: failLines,
    okx: okxSummary,
    note: passed
      ? "This pool passed hard filters. LLM still needs to evaluate narrative, smart wallets, and fees_sol before deploying."
      : null,
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "1h" }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${pool_address}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const pool = (data.data || [])[0];

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    // API sometimes returns 0 for fee_active_tvl_ratio on short timeframes — compute from raw values as fallback
    fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
      ? fix(p.fee_active_tvl_ratio, 4)
      : (p.active_tvl > 0 ? fix((p.fee / p.active_tvl) * 100, 4) : 0),
    volatility: fix(p.volatility, 2),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  return n != null ? Number(n.toFixed(decimals)) : null;
}

function pushFilteredReason(list, pool, reason) {
  if (!list || !pool) return;
  list.push({
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
  });
}
