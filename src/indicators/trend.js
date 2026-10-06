// Trend indicators. Pure and deterministic: no clocks, no randomness, no I/O.
// Same input => same output, always.
// Every output array aligns with the input index i: slot i is the value computed
// from values[0..i] only (no look-ahead), and the warm-up window is padded with
// null. When the real answer is unknowable (bad input, empty window, division by
// zero) the result is null instead of a guess. Nothing here throws on bad data.

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// Simple moving average: mean of values[i-period+1..i] once the window is full
// and every entry in it is a finite number; null before that or on bad windows.
export function sma(values, period) {
  if (!Array.isArray(values)) return [];
  const out = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || period > values.length) return out;
  let sum = 0, bad = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isNum(v)) sum += v; else bad++;
    if (i >= period) {
      const old = values[i - period];
      if (isNum(old)) sum -= old; else bad--;
    }
    if (i >= period - 1 && bad === 0) out[i] = sum / period;
  }
  return out;
}

// Exponential moving average, alpha = 2/(period+1). Seeded with the SMA of the
// first `period` values at index period-1. EMA is recursive, so a single
// non-finite input makes every index from that point on unknowable => null.
export function ema(values, period) {
  if (!Array.isArray(values)) return [];
  const out = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || period > values.length) return out;
  const alpha = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isNum(v)) return out;
    sum += v;
    if (i === period - 1) out[i] = sum / period;
    else if (i > period - 1) out[i] = alpha * v + (1 - alpha) * out[i - 1];
  }
  return out;
}

// Cumulative volume-weighted average price using the typical price
// (high+low+close)/3: vwap[i] = sum(tp[0..i]*volume)/sum(volume[0..i]).
// Null while cumulative volume is zero (division by zero) and from the first
// invalid candle onward (cumulative sums would silently absorb garbage).
export function vwap(candles) {
  if (!Array.isArray(candles)) return [];
  const out = new Array(candles.length).fill(null);
  let pv = 0, vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || !isNum(c.high) || !isNum(c.low) || !isNum(c.close) || !isNum(c.volume) || c.volume < 0) return out;
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    vol += c.volume;
    if (vol > 0) out[i] = pv / vol;
  }
  return out;
}

// MACD line = ema(values, fast) - ema(values, slow); signal = ema(line, signal)
// seeded from the first non-null run of the line; histogram = line - signal.
// All three arrays align with the input index i. Invalid parameters (including
// fast >= slow) fail safe to null arrays rather than throwing.
export function macd(values, fast = 12, slow = 26, signal = 9) {
  const empty = () => Array.isArray(values) ? new Array(values.length).fill(null) : [];
  const line = empty(), sig = empty(), hist = empty();
  if (!Array.isArray(values)) return {macd: line, signal: sig, histogram: hist};
  if (!Number.isInteger(fast) || fast < 1 || !Number.isInteger(slow) || slow < 1 || fast >= slow || !Number.isInteger(signal) || signal < 1) return {macd: line, signal: sig, histogram: hist};
  const f = ema(values, fast), s = ema(values, slow);
  let start = -1;
  for (let i = 0; i < values.length; i++) {
    if (f[i] !== null && s[i] !== null) {
      line[i] = f[i] - s[i];
      if (start < 0) start = i;
    }
  }
  if (start >= 0) {
    const sub = line.slice(start);
    const sigSub = ema(sub, signal);
    for (let i = 0; i < sub.length; i++) sig[start + i] = sigSub[i];
  }
  for (let i = 0; i < values.length; i++) if (line[i] !== null && sig[i] !== null) hist[i] = line[i] - sig[i];
  return {macd: line, signal: sig, histogram: hist};
}

// Bollinger bands. middle = sma(values, period); upper/lower = middle +/- mult
// * population standard deviation of the same window (divide by period).
export function bollinger(values, period = 20, mult = 2) {
  const n = Array.isArray(values) ? values.length : 0;
  const upper = new Array(n).fill(null), middle = new Array(n).fill(null), lower = new Array(n).fill(null);
  if (!Array.isArray(values)) return {upper, middle, lower};
  if (!Number.isInteger(period) || period < 1 || !isNum(mult) || mult < 0) return {upper, middle, lower};
  const mid = sma(values, period);
  for (let i = 0; i < n; i++) {
    if (mid[i] === null) continue;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(acc / period);
    middle[i] = mid[i];
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return {upper, middle, lower};
}

// Trailing support/resistance over the last `lookback` candles:
// support = min(low), resistance = max(high) of that window.
// Null when the window is unavailable or contains an invalid candle.
export function supportResistance(candles, lookback = 20) {
  const empty = {support: null, resistance: null};
  if (!Array.isArray(candles) || !Number.isInteger(lookback) || lookback < 1) return empty;
  if (candles.length < lookback) return empty;
  let support = Infinity, resistance = -Infinity;
  for (let i = candles.length - lookback; i < candles.length; i++) {
    const c = candles[i];
    if (!c || !isNum(c.high) || !isNum(c.low) || c.high < c.low) return empty;
    support = Math.min(support, c.low);
    resistance = Math.max(resistance, c.high);
  }
  return {support, resistance};
}
