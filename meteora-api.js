/**
 * meteora-api.js — Meteora DLMM Datapi client for position enrichment.
 *
 * Provides fetchers for:
 *   - Pool detail (TVL, reserves, config, bin step)
 *   - OHLCV price history during a position's lifetime
 *   - Volume history for a pool
 *   - Closed positions from on-chain data (source of truth)
 *   - Position events (deposits, withdraws, fee claims)
 *
 * Rate limit: 30 RPS. All fetchers include retry + backoff logic.
 */

import { log } from "./logger.js";
import { computeIndicators } from "./tools/indicators.js";

const BASE_URL = "https://dlmm.datapi.meteora.ag";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;
const FETCH_TIMEOUT_MS = 15_000;

// ─── Low-level fetch with retry + timeout ──────────────────────

async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 429) {
        const delay = RETRY_DELAY_MS * attempt * 2;
        log("meteora_api", `Rate limited (429), waiting ${delay}ms before retry ${attempt}/${retries}`);
        await sleep(delay);
        continue;
      }

      // 4xx (except 429) = client error — no point retrying
      if (res.status >= 400 && res.status < 500) {
        log("meteora_api_warn", `HTTP ${res.status} for ${url} — skipping retries`);
        return null;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      return await res.json();
    } catch (err) {
      if (attempt === retries) {
        log("meteora_api_error", `Failed after ${retries} attempts: ${url} — ${err.message}`);
        return null;
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Pool Detail ───────────────────────────────────────────────

export async function fetchPool(poolAddress) {
  if (!poolAddress) return null;
  return fetchWithRetry(`${BASE_URL}/pools/${poolAddress}`);
}

// ─── OHLCV Price Data ──────────────────────────────────────────

export async function fetchOHLCV(poolAddress, { startTime, endTime, timeframe = "1h" } = {}) {
  if (!poolAddress) return null;

  const params = new URLSearchParams({ timeframe });
  if (startTime) params.set("start_time", String(startTime));
  if (endTime) params.set("end_time", String(endTime));

  const url = `${BASE_URL}/pools/${poolAddress}/ohlcv?${params}`;
  const data = await fetchWithRetry(url);

  if (Array.isArray(data)) return data;
  if (data?.data && Array.isArray(data.data)) return data.data;
  return data;
}

// ─── Volume History ────────────────────────────────────────────

export async function fetchVolumeHistory(poolAddress, { startTime, endTime, timeframe = "1h" } = {}) {
  if (!poolAddress) return null;

  const params = new URLSearchParams({ timeframe });
  if (startTime) params.set("start_time", String(startTime));
  if (endTime) params.set("end_time", String(endTime));

  const url = `${BASE_URL}/pools/${poolAddress}/volume/history?${params}`;
  const data = await fetchWithRetry(url);

  if (Array.isArray(data)) return data;
  if (data?.data && Array.isArray(data.data)) return data.data;
  return data;
}

// ─── Wallet Closed Positions ───────────────────────────────────

export async function fetchClosedPositions(walletAddress, { limit = 10, cursor, startTime, endTime } = {}) {
  if (!walletAddress) return null;

  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  if (startTime) params.set("start_time", String(startTime));
  if (endTime) params.set("end_time", String(endTime));

  return fetchWithRetry(`${BASE_URL}/wallet/${walletAddress}/closed_positions?${params}`);
}

// ─── Open Positions ────────────────────────────────────────────

export async function fetchOpenPositions(walletAddress) {
  if (!walletAddress) return null;
  return fetchWithRetry(`${BASE_URL}/wallet/${walletAddress}/open_positions`);
}

// ─── Position Events ───────────────────────────────────────────

export async function fetchPositionEvents(positionAddress) {
  if (!positionAddress) return null;

  const data = await fetchWithRetry(`${BASE_URL}/position/${positionAddress}/events`);
  if (Array.isArray(data)) return data;
  if (data?.data && Array.isArray(data.data)) return data.data;
  return data;
}

// ─── Position Total Claimed Fees ───────────────────────────────

export async function fetchPositionClaimFees(positionAddress) {
  if (!positionAddress) return null;
  return fetchWithRetry(`${BASE_URL}/position/${positionAddress}/claim_fees`);
}

// ─── Pool Position PnL ─────────────────────────────────────────

export async function fetchPoolPositionPnL(poolAddress, walletAddress) {
  if (!poolAddress || !walletAddress) return null;
  const params = new URLSearchParams({ user: walletAddress });
  return fetchWithRetry(`${BASE_URL}/pool/${poolAddress}/positions_pnl?${params}`);
}

// ─── Portfolio Summary ─────────────────────────────────────────

export async function fetchPortfolioTotal(walletAddress) {
  if (!walletAddress) return null;
  return fetchWithRetry(`${BASE_URL}/wallet/${walletAddress}/portfolio_total`);
}

// ─── Enrichment: Full Position Context ─────────────────────────

/**
 * Enrich a position record with pool context + OHLCV price action.
 * Main function called by lessons.js enrichment.
 */
export async function enrichPosition(position) {
  const enriched = { ...position };
  const poolAddr = position.pool;

  if (!poolAddr) {
    log("meteora_api", "enrichPosition: no pool address, skipping");
    return enriched;
  }

  const entryTime = parseTimestamp(position.deployed_at || position.created_at);
  const exitTime = parseTimestamp(position.closed_at || position.recorded_at);

  // ── 1. Pool snapshot ───────────────────────────────────────
  try {
    const pool = await fetchPool(poolAddr);
    if (pool) {
      enriched._pool_snapshot = {
        name: pool.name,
        bin_step: pool.bin_step,
        active_bin_id: pool.active_bin_id,
        token_x: pool.token_x,
        token_y: pool.token_y,
        token_x_amount: pool.token_x_amount,
        token_y_amount: pool.token_y_amount,
        base_fee: pool.config?.base_fee,
        max_fee: pool.config?.max_fee,
        protocol_fee_pct: pool.config?.protocol_fee,
        cumulative_volume: pool.cumulative?.volume,
        cumulative_trade_fee: pool.cumulative?.trade_fee,
      };
      enriched.pool_tvl_usd = pool.token_x_amount != null && pool.token_y_amount != null
        ? pool.token_x_amount + pool.token_y_amount
        : null;
      enriched.pool_base_fee = pool.config?.base_fee ?? null;
      enriched.pool_cumulative_volume = pool.cumulative?.volume ?? null;
    }
  } catch (err) {
    log("meteora_api_error", `Pool fetch failed for ${poolAddr}: ${err.message}`);
  }

  await sleep(100);

  // ── 2. OHLCV price action ──────────────────────────────────
  if (entryTime && exitTime) {
    try {
      const durationHours = (exitTime - entryTime) / 3600;
      const timeframe = durationHours <= 2 ? "5m"
        : durationHours <= 12 ? "15m"
        : durationHours <= 48 ? "1h"
        : "4h";

      const candles = await fetchOHLCV(poolAddr, {
        startTime: entryTime,
        endTime: exitTime,
        timeframe,
      });

      if (Array.isArray(candles) && candles.length > 0) {
        const opens = candles.map((c) => c.open).filter(isNum);
        const highs = candles.map((c) => c.high).filter(isNum);
        const lows = candles.map((c) => c.low).filter(isNum);
        const closes = candles.map((c) => c.close).filter(isNum);
        const volumes = candles.map((c) => c.volume).filter(isNum);

        if (opens.length > 0 && closes.length > 0) {
          const priceAtEntry = opens[0];
          const priceAtExit = closes[closes.length - 1];
          const maxPrice = Math.max(...highs);
          const minPrice = Math.min(...lows);

          enriched.price_at_entry = priceAtEntry;
          enriched.price_at_exit = priceAtExit;
          enriched.price_change_pct = priceAtEntry > 0
            ? round(((priceAtExit - priceAtEntry) / priceAtEntry) * 100, 2)
            : null;
          enriched.price_max = maxPrice;
          enriched.price_min = minPrice;
          enriched.price_range_pct = priceAtEntry > 0
            ? round(((maxPrice - minPrice) / priceAtEntry) * 100, 2)
            : null;
          enriched.price_max_drawdown_pct = maxPrice > 0
            ? round(((minPrice - maxPrice) / maxPrice) * 100, 2)
            : null;
        }

        if (volumes.length > 0) {
          enriched.avg_volume_per_candle = round(volumes.reduce((a, b) => a + b, 0) / volumes.length, 2);
          enriched.total_volume_during = round(volumes.reduce((a, b) => a + b, 0), 2);

          const mid = Math.floor(volumes.length / 2);
          const firstHalf = volumes.slice(0, mid);
          const secondHalf = volumes.slice(mid);
          if (firstHalf.length > 0 && secondHalf.length > 0) {
            const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
            const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
            enriched.volume_trend = avgFirst > 0
              ? round(((avgSecond - avgFirst) / avgFirst) * 100, 2)
              : null;
          }
        }

        enriched._candle_count = candles.length;
        enriched._candle_timeframe = timeframe;
      }
    } catch (err) {
      log("meteora_api_error", `OHLCV fetch failed for ${poolAddr}: ${err.message}`);
    }
  }

  await sleep(100);

  // ── 2b. Technical indicators at entry ─────────────────────
  // Fetch 30 pre-entry candles (1h) for RSI/BB lookback, then compute
  // indicators at the moment of entry. Stored separately from position OHLCV.
  if (entryTime) {
    try {
      const LOOKBACK = 30;        // candles before entry (covers RSI-14 + BB-20 warmup)
      const CANDLE_SEC = 3600;    // 1h candles for consistency across positions
      const preStart = entryTime - LOOKBACK * CANDLE_SEC;
      const preEnd = entryTime + CANDLE_SEC; // +1 candle to include entry candle itself

      const preCandles = await fetchOHLCV(poolAddr, {
        startTime: preStart,
        endTime: preEnd,
        timeframe: "1h",
      });

      if (Array.isArray(preCandles) && preCandles.length >= 5) {
        const indicators = computeIndicators(preCandles);
        if (indicators) {
          enriched.indicators_at_entry = indicators;
          log("meteora_api", `Indicators computed for ${poolAddr.slice(0, 8)}: RSI=${indicators.rsi_14 ?? "?"} BB=${indicators.bb_position ?? "?"}`);
        }
      }
    } catch (err) {
      log("meteora_api_error", `Indicator fetch failed for ${poolAddr}: ${err.message}`);
    }
  }

  await sleep(100);

  // ── 3. Position events ─────────────────────────────────────
  const posAddr = position.position || position.position_address;
  if (posAddr) {
    try {
      const events = await fetchPositionEvents(posAddr);
      if (Array.isArray(events) && events.length > 0) {
        enriched.event_count_deposits = events.filter((e) => e.type === "deposit").length;
        enriched.event_count_withdraws = events.filter((e) => e.type === "withdraw").length;
        enriched.event_count_claims = events.filter((e) => e.type === "claim_fee" || e.type === "claim").length;
        enriched.total_events = events.length;

        const deposits = events.filter((e) => e.type === "deposit");
        const withdraws = events.filter((e) => e.type === "withdraw");
        if (deposits.length > 0 && withdraws.length > 0) {
          const firstDeposit = parseTimestamp(deposits[0].timestamp || deposits[0].created_at);
          const firstWithdraw = parseTimestamp(withdraws[0].timestamp || withdraws[0].created_at);
          if (firstDeposit && firstWithdraw) {
            enriched.minutes_to_first_withdraw = round((firstWithdraw - firstDeposit) / 60, 1);
          }
        }
      }
    } catch (err) {
      log("meteora_api_error", `Events fetch failed for ${posAddr}: ${err.message}`);
    }
  }

  enriched._enriched_at = new Date().toISOString();
  return enriched;
}

// ─── Batch Enrichment ──────────────────────────────────────────

/**
 * Fetch and enrich last N closed positions from Meteora API.
 * "Learn from history" function — call at startup or on-demand.
 */
export async function fetchAndEnrichClosedPositions(walletAddress, { limit = 25, delayMs = 200 } = {}) {
  log("meteora_api", `Fetching last ${limit} closed positions for ${walletAddress.slice(0, 8)}...`);

  const closedResp = await fetchClosedPositions(walletAddress, { limit });
  if (!closedResp?.data || closedResp.data.length === 0) {
    log("meteora_api", "No closed positions found");
    return [];
  }

  const positions = closedResp.data;
  log("meteora_api", `Found ${positions.length} closed positions, enriching...`);

  const enriched = [];
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    log("meteora_api", `Enriching ${i + 1}/${positions.length}: ${pos.pool_address?.slice(0, 8)}...`);

    const enrichedPos = await enrichPosition({
      position: pos.position_address,
      pool: pos.pool_address,
      created_at: pos.created_at,
      closed_at: pos.closed_at,
      lower_bin_id: pos.lower_bin_id,
      upper_bin_id: pos.upper_bin_id,
      pnl_usd: pos.pnl,
      pnl_pct: pos.pnl_change_pct,
      total_deposits: pos.total_deposits,
      total_withdraws: pos.total_withdraws,
      total_claimed_fees: pos.total_claimed_fees,
      _source: "meteora_api",
    });

    enriched.push(enrichedPos);

    if (i < positions.length - 1) await sleep(delayMs);
  }

  log("meteora_api", `Enrichment complete: ${enriched.length} positions processed`);
  return enriched;
}

// ─── Helpers ───────────────────────────────────────────────────

function parseTimestamp(val) {
  if (!val) return null;
  if (typeof val === "number") {
    return val > 1e12 ? Math.floor(val / 1000) : val;
  }
  if (typeof val === "string") {
    const ms = new Date(val).getTime();
    return isNaN(ms) ? null : Math.floor(ms / 1000);
  }
  return null;
}

function isNum(n) {
  return typeof n === "number" && isFinite(n);
}

function round(n, decimals = 2) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}
