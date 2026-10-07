// src/backtest/statistics.js
//
// Basic series statistics over equity curves. Fail-safe policy (aligned with
// src/backtest/metrics.js): non-finite observations are dropped, undefined
// scalars return `null`, and nothing ever emits NaN/Infinity.
//
// Sharpe semantics: `sharpe` is the PER-PERIOD Sharpe ratio (mean return /
// sample std of returns) — it is N-independent, exactly like
// src/backtest/metrics.js `sharpe`. It is NOT mean/std*sqrt(N) (that quantity is
// the t-statistic of the mean and grows with sample length, making "sharpe"
// incomparable across backtests of different sizes). When an explicit
// `periodsPerYear` is supplied, `sharpeAnnualized` = sharpe * sqrt(periodsPerYear).

function mean(a) {
  return a.reduce((s, x) => s + x, 0) / a.length;
}

// Period returns from an equity series. Pairs touching a non-finite equity point
// carry no signal and are DROPPED (never NaN); the zero-base convention is kept:
// equity[i] === 0 yields a 0 return for that period instead of +/-Infinity.
export function returns(e) {
  if (!Array.isArray(e) || e.length < 2) throw new Error("equity series required");
  const r = [];
  for (let i = 1; i < e.length; i++) {
    const prev = e[i - 1];
    const cur = e[i];
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) continue;
    r.push(prev === 0 ? 0 : cur / prev - 1);
  }
  return r;
}

// Maximum drawdown (<= 0) against the running peak. Non-finite points are
// skipped; while the running peak is <= 0 the ratio is undefined and reported
// as 0 (same convention as src/backtest/metrics.js `maxDrawdownSeries`).
export function maxDrawdown(e) {
  let p = -Infinity;
  let d = 0;
  for (const v of e) {
    if (!Number.isFinite(v)) continue;
    p = Math.max(p, v);
    if (p > 0) d = Math.min(d, v / p - 1);
  }
  return d;
}

export function summarize(e, {periodsPerYear = null} = {}) {
  if (periodsPerYear !== null && (!Number.isFinite(periodsPerYear) || periodsPerYear <= 0)) {
    throw new TypeError("periodsPerYear must be a positive finite number");
  }
  const r = returns(e).filter(Number.isFinite);
  const finalEquity = e.at(-1);
  const dd = maxDrawdown(e);
  if (!r.length) {
    return {samples: 0, meanReturn: null, volatility: null, sharpe: null, sharpeAnnualized: null, winRate: null, maxDrawdown: dd, finalEquity};
  }
  const m = mean(r);
  const v = r.length > 1 ? r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1) : 0;
  const s = Math.sqrt(v);
  const sharpe = r.length > 1 && s > 0 ? m / s : null;
  return {
    samples: r.length,
    meanReturn: m,
    volatility: s,
    sharpe,
    sharpeAnnualized: sharpe !== null && periodsPerYear !== null ? sharpe * Math.sqrt(periodsPerYear) : null,
    winRate: r.filter((x) => x > 0).length / r.length,
    maxDrawdown: dd,
    finalEquity
  };
}

export function bootstrapMean(r, {iterations = 1000, seed = 42} = {}) {
  if (!r.length) throw new Error("returns required");
  let s = seed >>> 0;
  const a = [];
  const rnd = () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < iterations; i++) {
    let m = 0;
    for (let j = 0; j < r.length; j++) m += r[Math.floor(rnd() * r.length)];
    a.push(m / r.length);
  }
  a.sort((x, y) => x - y);
  return {low: a[Math.floor(iterations * 0.025)], high: a[Math.floor(iterations * 0.975)], iterations};
}
