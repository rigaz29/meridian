/**
 * Technical indicator calculations from OHLCV candle arrays.
 *
 * All functions are pure — they take arrays and return numbers/strings.
 * No external dependencies. Used to enrich closed position records in lessons.json.
 *
 * Candle shape expected: { open, high, low, close, volume, timestamp }
 */

// ─── RSI(14) ───────────────────────────────────────────────────
// Wilder's smoothed RSI. Requires at least 15 candles (14 for first avg + 1 current).

export function calcRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;

  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? Math.abs(diff) : 0);
  }

  // Seed: simple average for first period
  let avgGain = gains.slice(0, period).reduce((s, v) => s + v, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((s, v) => s + v, 0) / period;

  // Wilder's smoothing for remaining candles
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

// ─── Bollinger Bands(20, 2) ────────────────────────────────────

export function calcBollingerBands(closes, period = 20, stdDevMultiplier = 2) {
  if (!Array.isArray(closes) || closes.length < period) return null;

  const window = closes.slice(-period);
  const sma = window.reduce((s, v) => s + v, 0) / period;
  const variance = window.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = sma + stdDevMultiplier * stdDev;
  const lower = sma - stdDevMultiplier * stdDev;
  const width_pct = sma > 0 ? Math.round(((upper - lower) / sma) * 100 * 10) / 10 : null;

  return { upper, lower, middle: sma, width_pct };
}

/**
 * Returns a human-readable position of price relative to Bollinger Bands.
 * @returns "outside_upper" | "near_upper" | "middle" | "near_lower" | "outside_lower"
 */
export function calcBBPosition(price, bb) {
  if (!bb || price == null) return null;
  const { upper, lower, middle } = bb;
  if (price > upper)                          return "outside_upper";
  if (price >= middle + (upper - middle) * 0.5) return "near_upper";
  if (price <= lower)                          return "outside_lower";
  if (price <= middle - (middle - lower) * 0.5) return "near_lower";
  return "middle";
}

// ─── VWAP ──────────────────────────────────────────────────────
// Cumulative VWAP over entire candle window.

export function calcVWAP(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;

  let cumTPV = 0;  // typical_price × volume
  let cumVol = 0;

  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    if (isFinite(tp) && isFinite(c.volume) && c.volume > 0) {
      cumTPV += tp * c.volume;
      cumVol += c.volume;
    }
  }

  return cumVol > 0 ? cumTPV / cumVol : null;
}

// ─── Volume Spike Detection ────────────────────────────────────
// Returns true if the last candle's volume is > multiplier × avg of prior candles.

export function isVolumeSpike(volumes, multiplier = 2.0) {
  if (!Array.isArray(volumes) || volumes.length < 2) return null;
  const prior = volumes.slice(0, -1);
  const avgPrior = prior.reduce((s, v) => s + v, 0) / prior.length;
  if (avgPrior <= 0) return null;
  return volumes[volumes.length - 1] > avgPrior * multiplier;
}

// ─── ATR(14) ───────────────────────────────────────────────────
// Average True Range as % of entry price.
// True Range = max(high-low, |high-prevClose|, |low-prevClose|)

export function calcATRPct(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    if (!isFinite(high) || !isFinite(low) || !isFinite(prevClose)) continue;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trs.length < period) return null;

  // Wilder's smoothed ATR
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  const entryPrice = candles[candles.length - 1].close;
  if (!entryPrice || entryPrice <= 0) return null;
  return Math.round((atr / entryPrice) * 100 * 100) / 100;  // as % of price, 2 decimals
}

// ─── EMA ───────────────────────────────────────────────────────

export function calcEMA(closes, period) {
  if (!Array.isArray(closes) || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * EMA trend direction from 9/21 crossover.
 * @returns "uptrend" | "downtrend" | "sideways"
 */
export function calcEMATrend(closes) {
  if (!Array.isArray(closes) || closes.length < 22) return null;
  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  if (ema9 == null || ema21 == null) return null;

  const diff = (ema9 - ema21) / ema21;   // relative gap
  if (diff > 0.003)  return "uptrend";   // EMA9 > EMA21 by >0.3%
  if (diff < -0.003) return "downtrend"; // EMA9 < EMA21 by >0.3%
  return "sideways";
}

// ─── Consecutive Bearish Candles ───────────────────────────────
// Count how many red candles appear before (and including) the entry candle.

export function calcConsecutiveRed(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const { open, close } = candles[i];
    if (!isFinite(open) || !isFinite(close)) break;
    if (close < open) count++;
    else break;
  }
  return count;
}

// ─── Nearest Support (Swing Low) ──────────────────────────────
/**
 * Find the nearest demand/support level below current price using swing lows.
 * A swing low is a candle where low[i] < low[i-1] AND low[i] < low[i+1].
 *
 * @param {Array}  candles          - OHLCV candle array (chronological order)
 * @param {number} minSwings        - Minimum swing lows required (default 2)
 * @param {number} minAmplitudePct  - Min % gap from each neighbor for a swing to count (default 0).
 *                                    Use 1.5 for 15m candles, 3.0 for 5m candles to filter noise.
 * @returns {{ price, distance_pct, swing_count, timeframe } | null}
 */
export function findNearestSupport(candles, minSwings = 2, minAmplitudePct = 0) {
  if (!Array.isArray(candles) || candles.length < 5) return null;

  const currentPrice = candles[candles.length - 1].close;
  if (!isFinite(currentPrice) || currentPrice <= 0) return null;

  const minAmp = minAmplitudePct / 100;

  // Collect swing lows that pass amplitude filter
  const swingLows = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const { low } = candles[i];
    if (!isFinite(low)) continue;
    const prevLow = candles[i - 1].low;
    const nextLow = candles[i + 1].low;
    if (!isFinite(prevLow) || !isFinite(nextLow)) continue;

    const belowPrev = (prevLow - low) / prevLow;  // how much lower than left neighbor
    const belowNext = (nextLow - low) / nextLow;  // how much lower than right neighbor

    if (low < prevLow && low < nextLow && belowPrev >= minAmp && belowNext >= minAmp) {
      swingLows.push(low);
    }
  }

  if (swingLows.length < minSwings) return null;

  // Only consider swing lows strictly below current price
  const below = swingLows.filter(p => p < currentPrice);
  if (!below.length) return null;

  // Nearest support = highest swing low below current price
  const supportPrice = Math.max(...below);
  const distancePct  = (currentPrice - supportPrice) / currentPrice * 100;

  return {
    price:        Math.round(supportPrice * 1e8) / 1e8,
    distance_pct: Math.round(distancePct * 10) / 10,
    swing_count:  swingLows.length,
  };
}

// ─── Composite: all indicators at a single point in time ───────

/**
 * Compute all indicators for a set of candles and return a compact object.
 * The last candle is treated as "now" (the entry point).
 *
 * @param {Array} candles - Array of candles up to and including entry candle
 * @returns {Object|null}
 */
export function computeIndicators(candles) {
  if (!Array.isArray(candles) || candles.length < 5) return null;

  const closes  = candles.map(c => c.close).filter(v => isFinite(v));
  const volumes = candles.map(c => c.volume).filter(v => isFinite(v));
  const entryCandle = candles[candles.length - 1];

  const rsi   = calcRSI(closes);
  const bb    = calcBollingerBands(closes);
  const bbPos = bb && entryCandle ? calcBBPosition(entryCandle.close, bb) : null;
  const vwap  = calcVWAP(candles);
  const vwapVsPricePct = (vwap && entryCandle?.close)
    ? Math.round(((entryCandle.close - vwap) / vwap) * 100 * 10) / 10
    : null;
  const volSpike      = isVolumeSpike(volumes);
  const atrPct        = calcATRPct(candles);
  const emaTrend      = calcEMATrend(closes);
  const consecutiveRed = calcConsecutiveRed(candles);

  const result = {};
  if (rsi             != null) result.rsi_14             = rsi;
  if (bbPos           != null) result.bb_position        = bbPos;
  if (bb?.width_pct   != null) result.bb_width_pct       = bb.width_pct;
  if (vwapVsPricePct  != null) result.vwap_vs_price_pct  = vwapVsPricePct;
  if (volSpike        != null) result.volume_spike        = volSpike;
  if (atrPct          != null) result.atr_14_pct          = atrPct;
  if (emaTrend        != null) result.ema_trend           = emaTrend;
  if (consecutiveRed  != null) result.consecutive_red     = consecutiveRed;

  return Object.keys(result).length > 0 ? result : null;
}
