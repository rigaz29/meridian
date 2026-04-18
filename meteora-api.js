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

// ─── Technical Indicators (Entry / Exit) ──────────────────────

/**
 * Find the nearest demand/support level below current price using swing lows.
 * A swing low = candle whose low is meaningfully below both neighbors.
 *
 * @param {Array}  candles          - OHLCV array (chronological)
 * @param {number} minAmplitudePct  - Min % gap from each neighbor to qualify as swing (default 2.0)
 * @returns {{ price, distance_pct, swing_count } | null}
 */
export function findNearestSupport(candles, { minAmplitudePct = 2.0 } = {}) {
  if (!Array.isArray(candles) || candles.length < 5) return null;

  const currentPrice = candles[candles.length - 1].close;
  if (!isNum(currentPrice) || currentPrice <= 0) return null;

  const minAmp = minAmplitudePct / 100;
  const swingLows = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const low  = candles[i].low;
    const prev = candles[i - 1].low;
    const next = candles[i + 1].low;
    if (!isNum(low) || !isNum(prev) || !isNum(next) || prev <= 0 || next <= 0) continue;

    const belowPrev = (prev - low) / prev;
    const belowNext = (next - low) / next;

    if (low < prev && low < next && belowPrev >= minAmp && belowNext >= minAmp) {
      swingLows.push(low);
    }
  }

  const below = swingLows.filter(p => p < currentPrice);
  if (!below.length) return null;

  const supportPrice = Math.max(...below); // nearest = highest swing low below price
  const distancePct  = (currentPrice - supportPrice) / currentPrice * 100;

  return {
    price:        round(supportPrice, 8),
    distance_pct: round(distancePct, 1),
    swing_count:  swingLows.length,
  };
}

/**
 * Compute TA indicators from already-fetched candle array.
 * Returns null if insufficient data (< 21 valid candles).
 */
export function computeIndicatorsFromCandles(raw) {
  if (!Array.isArray(raw) || raw.length < 21) return null;

  const c = raw.filter(x => isNum(x.open) && isNum(x.high) && isNum(x.low) && isNum(x.close) && isNum(x.volume));
  if (c.length < 21) return null;

  const closes  = c.map(x => x.close);
  const highs   = c.map(x => x.high);
  const lows    = c.map(x => x.low);
  const volumes = c.map(x => x.volume);
  const last    = closes[closes.length - 1];
  const bb      = _calcBB(closes);

  return {
    rsi_14:            _rsi(closes, 14),
    bb_position:       bb ? _bbPosition(last, bb) : null,
    bb_width_pct:      bb && bb.mid > 0 ? round((bb.upper - bb.lower) / bb.mid * 100, 1) : null,
    vwap_vs_price_pct: _vwapVsPrice(c, last),
    atr_14_pct:        last > 0 ? _atrPct(highs, lows, closes, 14, last) : null,
    ema_trend:         _emaTrend(closes),
    volume_spike:      _volSpike(volumes),
    consecutive_red:   _consecutiveRed(c),
  };
}

/**
 * Compute TA indicators from recent OHLCV for a pool (live — anchored to now).
 * Returns null if insufficient candle data.
 */
export async function computeTechnicalIndicators(poolAddress, { timeframe = "5m" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const raw = await fetchOHLCV(poolAddress, { startTime: now - 60 * 300, endTime: now, timeframe });
  return computeIndicatorsFromCandles(raw);
}

/**
 * Compute TA indicators anchored to a specific historical timestamp.
 * Tries 5m → 15m → 1h until enough candles are available.
 * Used for backfilling lessons.json records.
 */
export async function computeIndicatorsAt(poolAddress, atTime) {
  const ts = typeof atTime === "string"
    ? Math.floor(new Date(atTime).getTime() / 1000)
    : Math.floor(atTime);

  const attempts = [
    { tf: "5m",  lookback: 60 * 300  },  // 60 candles × 5m = 5h
    { tf: "15m", lookback: 40 * 900  },  // 40 candles × 15m = 10h
    { tf: "1h",  lookback: 30 * 3600 },  // 30 candles × 1h  = 30h
  ];

  for (const { tf, lookback } of attempts) {
    const candleSec = lookback / (tf === "5m" ? 60 : tf === "15m" ? 40 : 30);
    const raw = await fetchOHLCV(poolAddress, {
      startTime: ts - lookback,
      endTime:   ts + candleSec,
      timeframe: tf,
    });
    const result = computeIndicatorsFromCandles(raw);
    if (result) return { ...result, _timeframe: tf };
  }

  return null;
}

function _rsi(closes, period) {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += -d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return round(100 - 100 / (1 + avgGain / avgLoss), 1);
}

function _calcBB(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  return { upper: mid + 2 * sd, mid, lower: mid - 2 * sd, sd };
}

function _bbPosition(price, bb) {
  if (price > bb.upper)       return "outside_upper";
  if (price > bb.mid + bb.sd) return "near_upper";
  if (price < bb.lower)       return "outside_lower";
  if (price < bb.mid - bb.sd) return "near_lower";
  return "middle";
}

function _vwapVsPrice(candles, last) {
  let tpv = 0, vol = 0;
  for (const x of candles) {
    tpv += (x.high + x.low + x.close) / 3 * x.volume;
    vol += x.volume;
  }
  if (vol === 0) return null;
  const vwap = tpv / vol;
  return vwap > 0 ? round((last - vwap) / vwap * 100, 1) : null;
}

function _atrPct(highs, lows, closes, period, lastPrice) {
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return round(atr / lastPrice * 100, 2);
}

function _ema(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function _emaTrend(closes) {
  const e9 = _ema(closes, 9), e21 = _ema(closes, 21);
  if (!e9 || !e21 || e21 === 0) return null;
  const d = (e9 - e21) / e21;
  return d > 0.003 ? "uptrend" : d < -0.003 ? "downtrend" : "sideways";
}

function _volSpike(volumes) {
  if (volumes.length < 21) return false;
  const last = volumes[volumes.length - 1];
  const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 && last > avg * 2;
}

function _consecutiveRed(candles) {
  let n = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) n++; else break;
  }
  return n;
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
