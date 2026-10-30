import test from "node:test";
import assert from "node:assert/strict";
import {rollingBacktest} from "../server/backtest-comparison.js";
import {runBacktestV2} from "../src/backtest/engine-v2.js";
import {createStrategy} from "../server/strategies.js";
import {startTestServer, klineRows, jsonResponse} from "./ws-d-helpers.js";

const candles = n => Array.from({length: n}, (_, i) => {
  const close = 100 + Math.sin(i / 7) * 10 + i / 10;
  return {openTime: 1700000000000 + i * 3600000, open: close - 0.2, close, high: close + 1, low: close - 1};
});
const run = (rows, strategyName = "momentum") => rollingBacktest({candles: rows, strategyName,
  startingCash: 10000, feeRate: 0.001, slippageBps: 5});

test("rolling checks require two complete windows and valid ordered source dates", () => {
  for (const n of [0, 70, 105, 139]) {
    const r = run(candles(n));
    assert.equal(r.state, "insufficient-data");
    assert.equal(r.summary, null);
    assert.deepEqual(r.folds, []);
  }
  for (const rows of [[{open: 100, close: 100}], [...candles(140)].reverse(),
    candles(140).map((c, i) => i === 2 ? {...c, openTime: 1700000000000} : c)]) {
    assert.equal(run(rows).state, "unavailable");
    assert.equal(run(rows).reason, "ordered-source-timestamps-required");
  }
  assert.equal(run(candles(140)).summary.foldCount, 2);
});

test("latest-aligned rolling checks have bounded disjoint OOS windows and exact disclosed coverage", () => {
  for (const n of [140, 200, 1000]) {
    const r = run(candles(n));
    assert.equal(r.state, "ok");
    assert.ok(r.folds.length >= 2 && r.folds.length <= 6);
    assert.equal(r.folds.at(-1).test.end, n);
    assert.equal(r.excludedPrefixCandles, r.folds[0].reference.start);
    for (const [i, fold] of r.folds.entries()) {
      assert.equal(fold.reference.end, fold.test.start);
      assert.equal(fold.reference.end - fold.reference.start, 70);
      assert.equal(fold.test.end - fold.test.start, 35);
      if (i) assert.equal(r.folds[i - 1].test.end, fold.test.start);
      assert.ok(fold.test.firstTimestamp <= fold.test.lastTimestamp);
    }
    assert.equal(r.summary.testCandleCount, 35 * r.folds.length);
    assert.equal(r.policy.parametersFitted, false);
    const returns = r.folds.map(f => f.returnPct);
    assert.equal(r.summary.meanReturn, returns.reduce((a, b) => a + b, 0) / returns.length);
    assert.equal(r.summary.minReturn, Math.min(...returns));
    assert.equal(r.summary.positiveFolds, returns.filter(x => x > 0).length);
  }
});

test("each rolling fold matches an isolated fresh-factory engine run for all declared strategies", () => {
  const rows = candles(200);
  for (const name of ["sma-cross", "momentum", "famous-turtle"]) {
    const r = run(rows, name);
    assert.deepEqual(run(rows, name), r);
    for (const fold of r.folds) {
      const expected = runBacktestV2({candles: rows.slice(fold.reference.start, fold.test.end),
        strategy: createStrategy(name), startingCash: 10000, feeRate: 0.001, slippageBps: 5, walkForward: 70}).outOfSample;
      assert.equal(fold.equity, expected.equity);
      assert.equal(fold.trades, expected.trades);
      assert.equal(fold.returnPct, expected.returnPct);
      assert.equal(fold.maxDrawdown, expected.maxDrawdown);
    }
  }
});

test("future candles and excluded prefix cannot influence an earlier rolling fold", () => {
  const rows = candles(200), before = run(rows);
  const end = before.folds[0].test.end;
  const changed = rows.map((c, i) => i >= end || i < before.excludedPrefixCandles
    ? {...c, open: 1000, close: 1000, high: 1001, low: 999} : c);
  assert.deepEqual(run(changed).folds[0], before.folds[0]);
  const flat = run(candles(140).map(c => ({...c, open: 100, close: 100})));
  assert.equal(flat.summary.zeroFillFolds, 2);
  assert.equal(flat.summary.meanReturn, 0, "zero fills is an observed cash result, not strategy validation");
});

test("HTTP rolling report uses the same cached historical response and keeps short data honest", async () => {
  for (const n of [100, 200]) {
    let calls = 0;
    const srv = await startTestServer({fetchImpl: async () => {calls++; return jsonResponse(200, klineRows(n));}});
    try {
      const response = await fetch(srv.base + "/api/backtest?symbol=BTCUSDT&limit=200&strategy=momentum");
      assert.equal(response.status, 200);
      const d = (await response.json()).data;
      assert.equal(d.rolling.state, n < 140 ? "insufficient-data" : "ok");
      assert.equal(d.rolling.summary?.foldCount ?? 0, n < 140 ? 0 : 3);
      assert.equal(calls, 1);
      assert.equal(d.rolling.policy.testCandles, 35);
    } finally {await srv.close();}
  }
});
