// WS-B: backtest metric semantics (H3 + M4).
// * summarize().sharpe must be a per-period Sharpe (N-independent), not the
//   t-statistic mean/std*sqrt(N) that grows with sample length.
// * OUT_OF_SAMPLE_DRAWDOWN must be measured on the OOS equity curve itself —
//   never as a cross-run equity comparison that flags profitable OOS runs.
import test from "node:test";
import assert from "node:assert/strict";
import {summarize, returns, maxDrawdown} from "../src/backtest/statistics.js";
import {validateBacktest} from "../src/backtest/validation.js";
import {runBacktestV2} from "../src/backtest/engine-v2.js";

// Seam-free equity curve from per-period returns (so repeated blocks have
// identical return samples and the Sharpe comparison is exact).
function equityFrom(periodReturns, start = 1000) {
  const out = [start];
  let e = start;
  for (const r of periodReturns) {
    e *= 1 + r;
    out.push(e);
  }
  return out;
}

const BLOCK = [0.01, -0.005, 0.002, -0.001, 0.004, -0.003, 0.002, 0.001, -0.002, 0.003];

test("WS-B H3: summarize().sharpe is per-period (N-independent), not a t-statistic", () => {
  const short = summarize(equityFrom(BLOCK));
  const long = summarize(equityFrom([...BLOCK, ...BLOCK, ...BLOCK, ...BLOCK]));
  // the old t-statistic would grow by ~sqrt(4)=2x with 4x the samples
  assert.ok(Math.abs(short.sharpe - long.sharpe) < 0.05, `short=${short.sharpe} long=${long.sharpe}`);
});

test("WS-B H3: sharpe equals mean/sample-std exactly (metrics.js semantics)", () => {
  const eq = equityFrom(BLOCK);
  const r = returns(eq);
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const s = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  const sum = summarize(eq);
  assert.ok(Math.abs(sum.sharpe - m / s) < 1e-12);
  assert.ok(Math.abs(sum.meanReturn - m) < 1e-12);
  assert.ok(Math.abs(sum.volatility - s) < 1e-12);
});

test("WS-B H3: annualization requires an explicit periodsPerYear", () => {
  const eq = equityFrom(BLOCK);
  const perPeriod = summarize(eq);
  assert.equal(perPeriod.sharpeAnnualized, null);
  const ann = summarize(eq, {periodsPerYear: 252});
  assert.ok(Math.abs(ann.sharpeAnnualized - ann.sharpe * Math.sqrt(252)) < 1e-12);
  assert.throws(() => summarize(eq, {periodsPerYear: 0}), TypeError);
  assert.throws(() => summarize(eq, {periodsPerYear: NaN}), TypeError);
});

test("WS-B L5: statistics never leak NaN from corrupt equity points", () => {
  const s = summarize([100, NaN, 110]);
  assert.equal(s.samples, 0);
  assert.equal(s.sharpe, null);
  assert.ok(Number.isFinite(s.maxDrawdown));
  const partial = summarize([100, 110, NaN, 120]);
  assert.equal(partial.samples, 1);
  assert.equal(partial.sharpe, null); // fewer than 2 observations -> undefined, not 0
  assert.ok(Number.isFinite(partial.meanReturn));
  assert.equal(maxDrawdown([100, NaN, 80]), 80 / 100 - 1);
});

test("WS-B M4: OUT_OF_SAMPLE_DRAWDOWN is measured on the OOS equity curve", () => {
  // profitable OOS run with a much better IS run: must NOT be flagged invalid
  const good = validateBacktest({
    inSample: {trades: 100, equity: 50000, returnPct: 4, equityCurve: [10000, 50000]},
    outOfSample: {trades: 100, equity: 12000, returnPct: 0.2, equityCurve: [10000, 11500, 10800, 12000]}
  });
  assert.equal(good.valid, true);
  assert.deepEqual(good.reasons, []);

  // deep drawdown inside the OOS curve IS flagged (35% peak-to-trough)
  const bad = validateBacktest({
    inSample: {trades: 100, equity: 5000, returnPct: -0.8, equityCurve: [10000, 5000]},
    outOfSample: {trades: 100, equity: 9000, returnPct: -0.1, equityCurve: [10000, 6500, 9000]}
  });
  assert.deepEqual(bad.reasons, ["OUT_OF_SAMPLE_DRAWDOWN"]);

  // a catastrophic IS run must not mask an intact OOS run
  const is = validateBacktest({
    inSample: {trades: 100, equity: 2000, returnPct: -0.8, equityCurve: [10000, 2000]},
    outOfSample: {trades: 100, equity: 11000, returnPct: 0.1, equityCurve: [10000, 11000]}
  });
  assert.equal(is.valid, true);
});

test("WS-B M4: legacy OOS results without a curve use OOS-only evidence", () => {
  // profitable OOS run (previously flagged whenever IS earned more)
  const legacyGood = validateBacktest({inSample: {trades: 100, equity: 30000, returnPct: 2}, outOfSample: {trades: 100, equity: 20000, returnPct: 0.01}});
  assert.deepEqual(legacyGood.reasons, []);
  // losing OOS run: drawdown is at least its total loss
  const legacyBad = validateBacktest({inSample: {trades: 100, equity: 30000, returnPct: 2}, outOfSample: {trades: 100, equity: 7000, returnPct: -0.3}});
  assert.deepEqual(legacyBad.reasons, ["OUT_OF_SAMPLE_DRAWDOWN"]);
  // missing/invalid metrics still fail closed
  assert.deepEqual(validateBacktest({inSample: {trades: 100}, outOfSample: {trades: 100, equity: 1}}).reasons, ["INVALID_RETURN"]);
  assert.deepEqual(validateBacktest({inSample: {trades: 100, returnPct: 0}, outOfSample: {trades: 2, returnPct: 0}}).reasons, ["INSUFFICIENT_TRADES"]);
});


test("WS-B: candle-close signals fill only at the following candle open", () => {
  const candles = [
    {open: 100, close: 110},
    {open: 200, close: 220},
    {open: 300, close: 310}
  ];
  const result = runBacktestV2({
    candles,
    startingCash: 1000,
    strategy: (candle) => candle.close === 110 ? {side: "BUY", quantity: 1} : null
  });

  assert.equal(result.inSample.trades, 1);
  // The fill is 200 at bar two's open (not 110 at the signal bar's close).
  assert.equal(result.inSample.equityCurve[0], 1000);
  assert.equal(result.inSample.equityCurve[1], 1020);
  assert.equal(result.inSample.equity, 1110);
});

test("WS-B: signal on the final candle is not fabricated into a fill", () => {
  const result = runBacktestV2({
    candles: [{open: 100, close: 101}],
    startingCash: 1000,
    strategy: () => ({side: "BUY", quantity: 1})
  });
  assert.equal(result.inSample.trades, 0);
  assert.equal(result.inSample.equity, 1000);
});

test("WS-B: slippage is applied to the next candle open, not signal close", () => {
  const result = runBacktestV2({
    candles: [{open: 100, close: 110}, {open: 200, close: 220}],
    startingCash: 1000,
    feeRate: 0,
    slippageBps: 100,
    strategy: (candle) => candle.close === 110 ? {side: "BUY", quantity: 1} : null
  });
  // Next-open 200 plus 1% slippage = 202; equity at close = 1000 - 202 + 220.
  assert.equal(result.inSample.trades, 1);
  assert.equal(result.inSample.equity, 1018);
});

test("WS-B: backtest rejects close-only candles rather than silently faking a fill price", () => {
  assert.throws(() => runBacktestV2({
    candles: [{close: 100}],
    strategy: () => ({side: "BUY", quantity: 1})
  }), /open and close prices/);
});

test("WS-B: runBacktestV2 exposes a finite OOS equity curve for drawdown measurement", () => {
  const candles = Array.from({length: 20}, (_, i) => ({open: 99 + i, close: 100 + i}));
  const r = runBacktestV2({candles, strategy: () => ({side: "BUY", quantity: 0.01}), walkForward: 10, feeRate: 0.001, slippageBps: 5});
  assert.equal(r.outOfSample.equityCurve.length, 10);
  assert.ok(r.outOfSample.equityCurve.every(Number.isFinite));
  assert.ok(Number.isFinite(r.outOfSample.maxDrawdown));
  const v = validateBacktest(r);
  assert.deepEqual(v.reasons, ["INSUFFICIENT_TRADES"]); // 10 trades < 30, and no fake cross-run drawdown
  assert.ok(Number.isFinite(v.metrics.outOfSampleDrawdown));
});
