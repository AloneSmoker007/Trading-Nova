// Momentum indicators. Pure and deterministic: no clocks, no randomness, no I/O.
// Same input => same output, always. Output arrays align with the input index i
// (warm-up padded with null, no look-ahead). Unknowable answers (bad input,
// empty windows, division by zero) are null, never a guess, and nothing throws.
// Candles are {open, high, low, close, volume, ts} objects (src/market-data/schema.js).

import {sma} from "./trend.js";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const validHLC = (c) => Boolean(c) && isNum(c.high) && isNum(c.low) && isNum(c.close) && c.high >= c.low;

// Relative Strength Index (Wilder smoothing, period=14 by default).
// First value at index `period`; averages seeded with the mean of the first
// `period` changes, then avg = (avg*(period-1) + current)/period.
// RSI is 100 when there are gains and zero losses, 0 when there are losses and
// zero gains, and null when both are zero (flat series: ratio undefined).
export function rsi(values, period = 14) {
  if (!Array.isArray(values)) return [];
  const out = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || values.length <= period) return out;
  const fromAvg = (gain, loss) => {
    if (loss === 0) return gain === 0 ? null : 100;
    return 100 - 100 / (1 + gain / loss);
  };
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    if (!isNum(values[i]) || !isNum(values[i - 1])) return out;
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = fromAvg(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    if (!isNum(values[i]) || !isNum(values[i - 1])) return out;
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = fromAvg(avgGain, avgLoss);
  }
  return out;
}

// Stochastic oscillator. %K[i] = (close-lowest(low))/((highest(high)-lowest(low))
// * 100 over the trailing kPeriod window; %D = sma(%K, dPeriod).
// %K is null before the window is full, on invalid windows, and when the window
// range is zero (division by zero).
export function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  const n = Array.isArray(candles) ? candles.length : 0;
  const k = new Array(n).fill(null), d = new Array(n).fill(null);
  if (!Array.isArray(candles) || !Number.isInteger(kPeriod) || kPeriod < 1 || !Number.isInteger(dPeriod) || dPeriod < 1) return {k, d};
  for (let i = kPeriod - 1; i < n; i++) {
    let lo = Infinity, hi = -Infinity, ok = true;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      const c = candles[j];
      if (!validHLC(c)) { ok = false; break; }
      lo = Math.min(lo, c.low);
      hi = Math.max(hi, c.high);
    }
    if (!ok || hi === lo) continue;
    k[i] = (candles[i].close - lo) / (hi - lo) * 100;
  }
  const dArr = sma(k, dPeriod);
  for (let i = 0; i < n; i++) d[i] = dArr[i];
  return {k, d};
}

// Average True Range (Wilder). TR[0] = high-low; for i>0
// TR[i] = max(high-low, |high-prevClose|, |low-prevClose|).
// First ATR at index period-1 = mean of the first `period` TR values, then
// atr = (atr*(period-1) + tr)/period. Recursive => first bad candle nulls the rest.
export function atr(candles, period = 14) {
  if (!Array.isArray(candles)) return [];
  const out = new Array(candles.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || candles.length < period) return out;
  const tr = (i) => {
    const c = candles[i];
    if (!validHLC(c)) return null;
    if (i === 0) return c.high - c.low;
    const p = candles[i - 1];
    if (!validHLC(p)) return null;
    return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  };
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const t = tr(i);
    if (t === null) return out;
    sum += t;
    if (i === period - 1) out[i] = sum / period;
    else if (i > period - 1) out[i] = (out[i - 1] * (period - 1) + t) / period;
  }
  return out;
}

// Average Directional Index (Wilder). +DM/-DM from consecutive highs/lows,
// smoothed as running Wilder sums (first at index `period`). DX = |+DI - -DI| /
// (+DI + -DI); the smoothed TR cancels out of that ratio, so only the smoothed
// DM sums are needed. First ADX at index 2*period-1 = mean of the first `period`
// DX values, then adx = (adx*(period-1) + dx)/period. DX is null when both DM
// sums are zero (flat market); that nulls ADX as unknowable.
export function adx(candles, period = 14) {
  if (!Array.isArray(candles)) return [];
  const out = new Array(candles.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || candles.length < 2 * period) return out;
  const dx = new Array(candles.length).fill(null);
  let plus = 0, minus = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    if (!validHLC(c) || !validHLC(p)) return out;
    const up = c.high - p.high, down = p.low - c.low;
    const pdm = up > down && up > 0 ? up : 0;
    const mdm = down > up && down > 0 ? down : 0;
    if (i <= period) {
      plus += pdm;
      minus += mdm;
    } else {
      plus = plus - plus / period + pdm;
      minus = minus - minus / period + mdm;
    }
    if (i >= period && plus + minus > 0) dx[i] = 100 * Math.abs(plus - minus) / (plus + minus);
  }
  let sum = 0;
  for (let i = period; i <= 2 * period - 1; i++) {
    if (dx[i] === null) return out;
    sum += dx[i];
  }
  out[2 * period - 1] = sum / period;
  for (let i = 2 * period; i < candles.length; i++) {
    if (dx[i] === null) return out;
    out[i] = (out[i - 1] * (period - 1) + dx[i]) / period;
  }
  return out;
}

// On-Balance Volume. obv[0] = 0; obv[i] = obv[i-1] +/- volume[i] depending on
// whether close[i] rose or fell versus close[i-1] (unchanged close keeps OBV).
// Recursive => first invalid candle nulls the rest.
export function obv(candles) {
  if (!Array.isArray(candles)) return [];
  const out = new Array(candles.length).fill(null);
  const validCO = (c) => Boolean(c) && isNum(c.close) && isNum(c.volume) && c.volume >= 0;
  if (candles.length === 0 || !validCO(candles[0])) return out;
  let sum = 0;
  out[0] = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    if (!validCO(c)) return out;
    if (c.close > p.close) sum += c.volume;
    else if (c.close < p.close) sum -= c.volume;
    out[i] = sum;
  }
  return out;
}

// Divergence scan between an oscillator `values` and `price` (aligned arrays).
// Looks at the last `lookback` entries: a bullish divergence is the two most
// recent strict pivot lows making a lower price low but a higher oscillator low;
// bearish is the mirror image on pivot highs. Returns booleans when the scan is
// possible and {null, null} when it is not (misaligned/short/invalid input).
export function divergence(values, price, lookback = 14) {
  const none = {bullish: null, bearish: null};
  if (!Array.isArray(values) || !Array.isArray(price) || values.length !== price.length) return none;
  if (!Number.isInteger(lookback) || lookback < 3 || price.length < lookback) return none;
  const v = values.slice(values.length - lookback), p = price.slice(price.length - lookback);
  for (let i = 0; i < lookback; i++) if (!isNum(v[i]) || !isNum(p[i])) return none;
  const lows = [], highs = [];
  for (let j = 1; j < lookback - 1; j++) {
    if (p[j] < p[j - 1] && p[j] < p[j + 1]) lows.push(j);
    if (p[j] > p[j - 1] && p[j] > p[j + 1]) highs.push(j);
  }
  let bullish = false, bearish = false;
  if (lows.length >= 2) {
    const [a, b] = lows.slice(-2);
    bullish = p[b] < p[a] && v[b] > v[a];
  }
  if (highs.length >= 2) {
    const [a, b] = highs.slice(-2);
    bearish = p[b] > p[a] && v[b] < v[a];
  }
  return {bullish, bearish};
}
