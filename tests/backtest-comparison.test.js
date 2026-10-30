import test from "node:test";
import assert from "node:assert/strict";
import {runBacktestV2} from "../src/backtest/engine-v2.js";
import {backtestComparison} from "../server/backtest-comparison.js";
import {createStrategy} from "../server/strategies.js";
import {startTestServer, klineRows, jsonResponse} from "./ws-d-helpers.js";
import {DurableStore} from "../src/persistence/store.js";

function report(candles, {walkForward = candles.length / 2, strategyName = "momentum", startingCash = 1000} = {}) {
  const base = runBacktestV2({candles, startingCash, walkForward, strategy: createStrategy(strategyName), feeRate: 0.001, slippageBps: 5});
  return {base, comparison: backtestComparison({candles, startingCash, walkForward, strategyName, base})};
}

test("cash and hold benchmarks use independent windows, causal next-open fills and explicit cost-adjusted arithmetic", () => {
  const candles = Array.from({length: 6}, () => ({open: 100, close: 100}));
  candles[2].close = 110;
  candles[5].close = 90;
  const {base, comparison: c} = report(candles);
  // Each sample sizes 9.5 units from its own first close, fills at 100.05,
  // charges entry fees, and marks the position (without an invented exit).
  const expected = 1000 - 9.5 * 100.05 * 1.001 + 9.5 * 110;
  assert.ok(Math.abs(c.benchmarks.buyHold.inSample.equity - expected) < 1e-9);
  assert.ok(Math.abs(c.benchmarks.buyHold.outOfSample.equity - (expected - 190)) < 1e-9);
  assert.equal(c.benchmarks.buyHold.outOfSample.trades, 1);
  assert.equal(c.benchmarks.cash.outOfSample.equity, 1000);
  assert.equal(c.benchmarks.cash.outOfSample.strategyExcessReturn, base.outOfSample.returnPct);
  assert.equal(c.benchmarks.buyHold.outOfSample.strategyExcessReturn,
    base.outOfSample.returnPct - c.benchmarks.buyHold.outOfSample.returnPct);
});

test("hold entry gaps do not fake a filled passive benchmark or excess-return claim", () => {
  const candles = [{open: 100, close: 100}, {open: 200, close: 200}, {open: 200, close: 200},
    {open: 100, close: 100}, {open: 200, close: 200}, {open: 200, close: 200}];
  const {comparison: c} = report(candles);
  for (const sample of Object.values(c.benchmarks.buyHold)) {
    assert.equal(sample.state, "not-filled");
    assert.equal(sample.trades, 0);
    assert.equal(sample.equity, 1000);
    assert.equal(sample.strategyExcessReturn, null);
  }
});

test("cost scenarios retain exact dataset and split but reset state between scenarios and calls", () => {
  const candles = Array.from({length: 200}, (_, i) => {
    const close = 100 + Math.sin(i / 7) * 10 + i / 10;
    return {open: close - 0.2, close, high: close + 1, low: close - 1};
  });
  for (const strategyName of ["sma-cross", "momentum", "famous-turtle"]) {
    const {base, comparison: c} = report(candles, {walkForward: 140, strategyName});
    assert.deepEqual(c, report(candles, {walkForward: 140, strategyName}).comparison);
    assert.equal(c.costSensitivity.scenarios.length, 3);
    assert.equal(c.costSensitivity.state, "descriptive-only");
    assert.deepEqual(c.costSensitivity.scenarios[0].outOfSample, {
      equity: base.outOfSample.equity, returnPct: base.outOfSample.returnPct,
      trades: base.outOfSample.trades, maxDrawdown: base.outOfSample.maxDrawdown
    });
    for (const scenario of c.costSensitivity.scenarios) {
      const independent = runBacktestV2({candles, walkForward: 140, startingCash: 1000,
        strategy: createStrategy(strategyName), feeRate: scenario.feeRate, slippageBps: scenario.slippageBps});
      assert.equal(scenario.outOfSample.equity, independent.outOfSample.equity);
      assert.equal(scenario.inSample.equity, independent.inSample.equity);
    }
    const values = c.costSensitivity.scenarios.map(x => x.outOfSample.returnPct);
    assert.equal(c.costSensitivity.outOfSampleReturnRange.min, Math.min(...values));
    assert.equal(c.costSensitivity.outOfSampleReturnRange.max, Math.max(...values));
  }
});

test("HTTP Strategy Lab accepts all three declared strategies with comparisons and no execution writes or extra data requests", async () => {
  const store = new DurableStore();
  let calls = 0;
  const srv = await startTestServer({store, fetchImpl: async () => {calls++; return jsonResponse(200, klineRows(200));}});
  try {
    for (const strategy of ["sma-cross", "momentum", "famous-turtle"]) {
      const response = await fetch(srv.base + "/api/backtest?symbol=BTCUSDT&limit=200&walkForward=150&strategy=" + strategy);
      assert.equal(response.status, 200, strategy);
      const d = (await response.json()).data;
      assert.equal(d.strategy.name, strategy);
      assert.equal(d.evaluationSplit.outOfSampleCandles, 50);
      assert.equal(d.comparison.benchmarks.buyHold.outOfSample.state, "filled");
      assert.equal(d.comparison.costSensitivity.scenarios[0].outOfSample.equity, d.outOfSample.equity);
      assert.equal(d.comparison.costSensitivity.scenarios[2].slippageBps, 20);
    }
    assert.equal(calls, 1, "same cached candle response; comparisons perform no provider work");
    const invalid = await fetch(srv.base + "/api/backtest?symbol=BTCUSDT&strategy=untrusted-strategy");
    assert.equal(invalid.status, 400);
    assert.equal(calls, 1);
    assert.equal(store.state.size, 0);
  } finally {await srv.close();}
});
