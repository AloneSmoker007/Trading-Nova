// Volatility indicators (NOVA-FEATURES §3).
// Pure and deterministic: no clocks, no randomness, no I/O — same input => same output.
//
// Missing-data policy (applies to every function here):
//   * Non-finite entries (NaN/null/undefined/Infinity) are dropped before computation.
//   * When fewer valid observations than `period` remain the result is `null` — the metric is
//     mathematically undefined on a short sample and we never guess partial windows or throw.
//   * Scalar ratios with a zero denominator also return `null` (never Infinity/NaN).
//
// Returns are simple returns (v[i]/v[i-1]-1), matching src/backtest/statistics.js; a zero
// base value yields a 0 return there and we keep that convention.

const finite = values => (Array.isArray(values) ? values.filter(Number.isFinite) : []);
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
// Sample standard deviation (n-1 denominator), matching statistics.js `summarize`.
const sampleStd = a => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const simpleReturns = v => {
  const r = [];
  for (let i = 1; i < v.length; i++) r.push(v[i - 1] === 0 ? 0 : v[i] / v[i - 1] - 1);
  return r;
};
const validCandle = c => Boolean(c) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close);

// Sample standard deviation of the trailing `period` values.
// Returns null when period < 2 (a sample std needs >= 2 points) or the input is short.
export function stdDev(values, period = 20) {
  if (!Number.isInteger(period) || period < 2) return null;
  const w = finite(values).slice(-period);
  return w.length < period ? null : sampleStd(w);
}

// Bollinger bandwidth of the trailing window: (upper-lower)/middle = 2*mult*std/mean.
// Normalized (scale-free). Returns null when mean is 0 (zero division) or data is short.
export function bollingerWidth(values, period = 20, mult = 2) {
  if (!Number.isInteger(period) || period < 2 || !Number.isFinite(mult)) return null;
  const w = finite(values).slice(-period);
  if (w.length < period) return null;
  const m = mean(w);
  return m === 0 ? null : (2 * mult * sampleStd(w)) / m;
}

// Classifies recent volatility against the full-sample volatility of the series.
// ratio = std(last `lookback` simple returns) / std(all simple returns):
//   ratio >= 1.5 -> "high", ratio <= 0.5 -> "low", otherwise "normal".
// Fail-safe defaults (documented choices, never throws):
//   * fewer than 2 returns, an invalid lookback, or a lookback window of < 2 returns
//     cannot support a measurement -> "normal" (neutral regime),
//   * zero volatility everywhere (perfectly flat series) -> "low" (there is no volatility).
export function volatilityRegime(values, lookback = 20) {
  if (!Number.isInteger(lookback) || lookback < 1) return "normal";
  const r = simpleReturns(finite(values));
  if (r.length < 2) return "normal";
  const recent = r.slice(-lookback);
  if (recent.length < 2) return "normal";
  const base = sampleStd(r);
  if (!(base > 0)) return "low";
  const ratio = sampleStd(recent) / base;
  return ratio >= 1.5 ? "high" : ratio <= 0.5 ? "low" : "normal";
}

// Annualized historical volatility: sample std of the trailing `period` simple returns
// scaled by sqrt(periodsPerYear). Simple (not log) returns for consistency with
// statistics.js and to stay defined for zero/negative prices.
// Returns null when period < 2, periodsPerYear <= 0, or fewer than period+1 values.
export function historicalVolatility(values, period = 20, periodsPerYear = 252) {
  if (!Number.isInteger(period) || period < 2 || !Number.isFinite(periodsPerYear) || periodsPerYear <= 0) return null;
  const v = finite(values);
  if (v.length < period + 1) return null;
  return sampleStd(simpleReturns(v).slice(-period)) * Math.sqrt(periodsPerYear);
}

// Keltner channel over the trailing `period` candles:
//   middle = SMA(typical price = (high+low+close)/3), bands = middle ± mult * ATR,
//   ATR = SMA(true range), TR = max(high-low, |high-prevClose|, |low-prevClose|);
//   the very first candle has no previous close so its TR is high-low (past-only, no look-ahead).
// Invalid candles are dropped first (previous close = previous valid candle's close).
// Returns {upper, middle, lower} or null when candles/period are invalid or too short.
export function keltner(candles, period = 20, mult = 2) {
  if (!Array.isArray(candles) || !Number.isInteger(period) || period < 1 || !Number.isFinite(mult)) return null;
  const cs = candles.filter(validCandle);
  if (cs.length < period) return null;
  const tp = cs.map(c => (c.high + c.low + c.close) / 3);
  const tr = cs.map((c, i) =>
    i === 0
      ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - cs[i - 1].close), Math.abs(c.low - cs[i - 1].close))
  );
  const m = mean(tp.slice(-period));
  const a = mean(tr.slice(-period));
  return { upper: m + mult * a, middle: m, lower: m - mult * a };
}

// Donchian channel over the trailing `period` candles: {upper: max high, lower: min low}.
// Returns null when candles/period are invalid or fewer than `period` valid candles exist.
export function donchian(candles, period = 20) {
  if (!Array.isArray(candles) || !Number.isInteger(period) || period < 1) return null;
  const cs = candles.filter(validCandle);
  if (cs.length < period) return null;
  let upper = -Infinity;
  let lower = Infinity;
  for (const c of cs.slice(-period)) {
    if (c.high > upper) upper = c.high;
    if (c.low < lower) lower = c.low;
  }
  return { upper, lower };
}
