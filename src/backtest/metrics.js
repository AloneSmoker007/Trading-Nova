// Backtest performance metrics (NOVA-FEATURES §7).
// Pure and deterministic: no clocks, no randomness, no I/O — same input => same output.
//
// Inputs:
//   * trade   = {pnl, risk} — pnl in account units; risk = initial risk in account units
//               (used for R-multiples = pnl/risk).
//   * returns = array of period returns as decimals (0.01 = 1%).
//   * equity  = array of equity values (account units).
//
// Fail-safe policy (documented choices, never throws, never returns Infinity/NaN):
//   * Non-finite trades/returns are dropped before computation. `maxDrawdownSeries` keeps the
//     input length: non-finite equity slots carry no signal and yield a drawdown of 0 there.
//   * Scalars that are mathematically undefined return `null`: empty sample, zero denominator
//     (e.g. profitFactor over an all-winning set has zero gross loss; sortino with no downside
//     observations has zero downside deviation), no-drawdown ratios (calmar/recoveryFactor).
//   * `maxDrawdown`/`maxDrawdownSeries` return 0/[] instead — "no observed drawdown" — matching
//     src/backtest/statistics.js `maxDrawdown` (which also reports 0 when nothing is drawn down).
//   * sharpe/sortino are per-period (not annualized): their signatures carry no periodsPerYear.
//
// R-multiples require a strictly positive finite risk; such trades are excluded from
// rMultiples/expectancy/averageWinLoss (a zero or missing initial risk cannot form an R).

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const finiteTrades = trades => (Array.isArray(trades) ? trades.filter(t => t && Number.isFinite(t.pnl)) : []);
const finiteReturns = returns => (Array.isArray(returns) ? returns.filter(Number.isFinite) : []);

// R-multiples (pnl / initial risk) for every trade with finite pnl and positive finite risk.
// Invalid trades are excluded (dropped) rather than fabricating a multiple; [] on empty input.
export function rMultiples(trades) {
  if (!Array.isArray(trades)) return [];
  return trades
    .filter(t => t && Number.isFinite(t.pnl) && Number.isFinite(t.risk) && t.risk > 0)
    .map(t => t.pnl / t.risk);
}

// Expectancy = mean R-multiple per trade (risk-normalized edge per trade).
// Returns null when no trade has a usable risk (mean of an empty sample is undefined).
export function expectancy(trades) {
  const r = rMultiples(trades);
  return r.length ? mean(r) : null;
}

// Profit factor = gross profit / gross loss, in pnl units.
// null on empty input or when gross loss is 0 (all-winning/flat set: ratio undefined —
// we return null rather than Infinity). All losses => 0 (0/losses is defined).
export function profitFactor(trades) {
  const t = finiteTrades(trades);
  if (!t.length) return null;
  let grossProfit = 0;
  let grossLoss = 0;
  for (const x of t) {
    if (x.pnl > 0) grossProfit += x.pnl;
    else if (x.pnl < 0) grossLoss -= x.pnl;
  }
  return grossLoss === 0 ? null : grossProfit / grossLoss;
}

// Win rate = winning trades / trades with finite pnl. A pnl of exactly 0 counts as not-a-win.
// Returns null on empty input (win rate of "no trades" is unknown, not 0).
export function winRate(trades) {
  const t = finiteTrades(trades);
  if (!t.length) return null;
  return t.filter(x => x.pnl > 0).length / t.length;
}

// Average win / average loss in R-multiples (signed: `averageLoss` is negative).
// Flat trades (pnl === 0) belong to neither side. A side with no trades yields null
// for that field (average of an empty sample is undefined); empty input => both null.
export function averageWinLoss(trades) {
  const r = rMultiples(trades);
  const wins = r.filter(x => x > 0);
  const losses = r.filter(x => x < 0);
  return {
    averageWin: wins.length ? mean(wins) : null,
    averageLoss: losses.length ? mean(losses) : null
  };
}

// Sharpe ratio per period = mean(excess return) / sample std(excess return).
// excess = return - riskFreeRate (per-period MAR). Returns null when fewer than 2 returns
// (sample std undefined) or when the excess std is 0 (zero volatility: ratio undefined —
// null, not Infinity).
export function sharpe(returns, riskFreeRate = 0) {
  const r = finiteReturns(returns);
  if (r.length < 2 || !Number.isFinite(riskFreeRate)) return null;
  const ex = r.map(x => x - riskFreeRate);
  const m = mean(ex);
  const v = ex.reduce((s, x) => s + (x - m) ** 2, 0) / (ex.length - 1);
  return v > 0 ? m / Math.sqrt(v) : null;
}

// Sortino ratio per period = mean(excess return) / downside deviation.
// Downside deviation = sqrt(sum of squared negative excess returns / total observations)
// (only returns below the MAR contribute, denominator is the full sample — standard Sortino).
// Returns null when there are no negative excess returns: downside deviation is 0 and the
// ratio is undefined — explicitly null, never Infinity.
export function sortino(returns, riskFreeRate = 0) {
  const r = finiteReturns(returns);
  if (!r.length || !Number.isFinite(riskFreeRate)) return null;
  const ex = r.map(x => x - riskFreeRate);
  let sq = 0;
  let downs = 0;
  for (const x of ex) {
    if (x < 0) {
      sq += x * x;
      downs++;
    }
  }
  if (!downs) return null;
  const dd = Math.sqrt(sq / ex.length);
  return dd > 0 ? mean(ex) / dd : null;
}

// Drawdown series: for each equity point, equity/running-peak - 1 (values <= 0), same
// length as the input. The running peak only tracks finite values; non-finite slots get 0.
// While the running peak is <= 0 the ratio is undefined and the point is reported as 0.
export function maxDrawdownSeries(equity) {
  if (!Array.isArray(equity)) return [];
  let peak = -Infinity;
  return equity.map(v => {
    if (!Number.isFinite(v)) return 0;
    peak = Math.max(peak, v);
    return peak > 0 ? Math.min(0, v / peak - 1) : 0;
  });
}

// Scalar maximum drawdown (<= 0). 0 on empty input = no observed drawdown,
// matching src/backtest/statistics.js `maxDrawdown`.
export function maxDrawdown(equity) {
  let d = 0;
  for (const v of maxDrawdownSeries(equity)) if (v < d) d = v;
  return d;
}

// Calmar ratio = CAGR / |max drawdown| over the compounded equity curve
// (curve starts at 1, growth factor = prod(1 + return)). Returns null when:
//   * there are no returns or periodsPerYear <= 0 (cannot annualize),
//   * the final growth factor is <= 0 (CAGR has no real value — wealth wiped out or worse),
//   * there is no drawdown at all (ratio would be Infinity).
export function calmar(returns, periodsPerYear = 252) {
  const r = finiteReturns(returns);
  if (!r.length || !Number.isFinite(periodsPerYear) || periodsPerYear <= 0) return null;
  let growth = 1;
  const equity = [1];
  for (const x of r) {
    growth *= 1 + x;
    equity.push(growth);
  }
  if (!(growth > 0)) return null;
  const dd = maxDrawdown(equity);
  return dd < 0 ? (growth ** (periodsPerYear / r.length) - 1) / -dd : null;
}

// Recovery factor = net pnl / max absolute drawdown of the cumulative pnl path
// (drawdown in account units against the running peak, which starts at 0 before the first
// trade). Returns null on empty input or when the path never dips below its peak
// (no drawdown: ratio would be Infinity). Negative results (losing systems) are kept as-is.
export function recoveryFactor(trades) {
  const t = finiteTrades(trades);
  if (!t.length) return null;
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const x of t) {
    cum += x.pnl;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return dd > 0 ? cum / dd : null;
}
