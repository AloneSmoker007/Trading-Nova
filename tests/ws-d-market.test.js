// tests/ws-d-market.test.js — WS-D web foundation: real-engine data endpoints
// (market / indicators / backtest) with a transport-injected fake upstream and
// an injected clock. No network, no timing flakiness.

import test from "node:test";
import assert from "node:assert/strict";
import {startTestServer, getJson, fakeFetch, jsonResponse, klineRows, ticker24hPayload, findSecretViolations} from "./ws-d-helpers.js";
import {createStrategy} from "../server/strategies.js";

// Mutable upstream state: handlers read it at call time so tests can flip the
// upstream from healthy to dead (for stale/unavailable transitions).
function upstream(state = {}) {
  return fakeFetch([
    ["/api/v3/ticker/24hr", () => (state.fail ? jsonResponse(500, {}) : jsonResponse(200, state.ticker || ticker24hPayload()))],
    ["/api/v3/klines", () => (state.fail ? jsonResponse(500, {}) : jsonResponse(200, state.klines || klineRows(200)))]
  ]);
}

test("/api/market/:symbol returns real ticker data with honest freshness", async () => {
  const srv = await startTestServer({fetchImpl: upstream(), stateFile: "/nonexistent/paper-state.json"});
  try {
    const res = await getJson(srv.base, "/api/market/BTCUSDT");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const d = res.body.data;
    assert.equal(d.state, "ok");
    assert.equal(d.symbol, "BTCUSDT");
    assert.equal(d.stale, false);
    assert.equal(d.ticker.last, 42000.5);
    assert.equal(d.ticker.bid, 42000);
    assert.equal(d.ticker.ask, 42001);
    assert.equal(d.ticker.changePct24h, 1.23);
    assert.equal(d.freshness.status, "fresh");
    assert.deepEqual(findSecretViolations(res.body, res.text), []);
  } finally {
    await srv.close();
  }
});

test("upstream failure gives an honest 503 unavailable (no fabricated numbers)", async () => {
  const srv = await startTestServer({fetchImpl: upstream({fail: true}), stateFile: "/nonexistent/paper-state.json"});
  try {
    const res = await getJson(srv.base, "/api/market/ETHUSDT");
    assert.equal(res.status, 503);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.state, "unavailable");
    assert.equal(res.body.error.code, "market-unavailable");
    assert.equal(res.body.data, undefined);
    assert.deepEqual(findSecretViolations(res.body, res.text), []);
  } finally {
    await srv.close();
  }
});

test("cached data is served as STALE (marked, aged) when upstream dies later", async () => {
  const clock = {t: 1700000000000};
  const up = {fail: false};
  const srv = await startTestServer({
    fetchImpl: upstream(up),
    now: () => clock.t,
    stateFile: "/nonexistent/paper-state.json"
  });
  try {
    const fresh = await getJson(srv.base, "/api/market/BTCUSDT");
    assert.equal(fresh.body.data.state, "ok");

    // 60s later the upstream is down: past the 5s TTL, inside the 5min stale window.
    clock.t += 60000;
    up.fail = true;
    const stale = await getJson(srv.base, "/api/market/BTCUSDT");
    assert.equal(stale.status, 200);
    assert.equal(stale.body.data.state, "stale");
    assert.equal(stale.body.data.stale, true);
    assert.equal(stale.body.data.ageMs, 60000);
    assert.equal(stale.body.data.freshness.status, "stale");
    assert.equal(stale.body.data.ticker.last, 42000.5, "stale value is the last known good one");
    assert.match(stale.body.data.note, /old/);

    // Far beyond the stale window: honest unavailable again.
    clock.t += 10 * 60000;
    const gone = await getJson(srv.base, "/api/market/BTCUSDT");
    assert.equal(gone.status, 503);
    assert.equal(gone.body.state, "unavailable");
  } finally {
    await srv.close();
  }
});

test("/api/indicators/:symbol computes real indicators over real candles", async () => {
  const srv = await startTestServer({fetchImpl: upstream(), stateFile: "/nonexistent/paper-state.json"});
  try {
    const res = await getJson(srv.base, "/api/indicators/BTCUSDT?interval=1h&limit=200");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const d = res.body.data;
    assert.equal(d.candleCount, 200);
    assert.equal(d.interval, "1h");
    assert.equal(d.candles.length, 200, "chart receives the actual OHLCV feed");
    assert.deepEqual(d.candles[0], {
      time: 1700000000,
      open: 100,
      high: 101.76,
      low: 99,
      close: 100.76,
      volume: 10.5
    }, "chart OHLCV values are mapped from the normalized upstream candle");
    const ind = d.indicators;
    // Synthetic sine series => these must be computable, finite engine outputs.
    assert.ok(Number.isFinite(ind.trend.sma20), "sma20 finite");
    assert.ok(Number.isFinite(ind.trend.sma50), "sma50 finite");
    assert.ok(Number.isFinite(ind.momentum.rsi14), "rsi14 finite");
    assert.ok(Number.isFinite(ind.momentum.atr14), "atr14 finite");
    assert.ok(["low", "normal", "high"].includes(ind.volatility.regime));
    // Unknowable values stay null — never NaN/Infinity in the JSON.
    assert.ok(!res.text.includes("NaN"), "no NaN leaked");
    assert.ok(!res.text.includes("Infinity"), "no Infinity leaked");
    assert.deepEqual(findSecretViolations(res.body, res.text), []);
  } finally {
    await srv.close();
  }
});

test("/api/indicators short window stays honest (nulls, not guesses)", async () => {
  const srv = await startTestServer({fetchImpl: upstream({klines: klineRows(10)}), stateFile: "/nonexistent/paper-state.json"});
  try {
    const res = await getJson(srv.base, "/api/indicators/BTCUSDT?interval=1h&limit=10");
    assert.equal(res.status, 200);
    const ind = res.body.data.indicators;
    assert.equal(ind.trend.sma20, null, "SMA(20) over 10 candles is unknowable");
    assert.equal(ind.momentum.rsi14, null);
    assert.equal(res.body.data.candleCount, 10);
  } finally {
    await srv.close();
  }
});

test("/api/backtest runs the real engine and stays paper-only honest", async () => {
  const srv = await startTestServer({fetchImpl: upstream(), stateFile: "/nonexistent/paper-state.json"});
  try {
    const res = await getJson(srv.base, "/api/backtest?symbol=BTCUSDT&interval=1h&limit=200");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const d = res.body.data;
    assert.equal(d.strategy.name, "sma-cross");
    assert.equal(d.startingCash, 10000);
    assert.ok(Number.isFinite(d.inSample.equity), "final in-sample equity finite");
    assert.ok(Number.isFinite(d.inSample.returnPct), "in-sample return finite");
    assert.ok(Number.isInteger(d.inSample.trades), "in-sample trade count integer");
    assert.equal(d.parameters.feeRate, 0.001);
    assert.equal(d.parameters.slippageBps, 5);
    assert.equal(d.parameters.walkForward, 140);
    assert.equal(d.evaluationSplit.mode, "automatic");
    assert.equal(d.evaluationSplit.inSampleCandles, 140);
    assert.equal(d.evaluationSplit.outOfSampleCandles, 60);
    assert.equal(d.inSample.equityCurve.length, 140);
    assert.ok(d.outOfSample, "out-of-sample metrics are included by default");
    assert.equal(d.outOfSample.equityCurve.length, 60);
    assert.ok(Number.isFinite(d.outOfSample.equity), "final out-of-sample equity finite");
    assert.equal(d.reproducible, true);
    assert.match(d.note, /[Pp]aper/);
    assert.match(d.note, /not a prediction|Past performance/);
    assert.deepEqual(findSecretViolations(res.body, res.text), []);
  } finally {
    await srv.close();
  }
});

test("backtest accepts a valid explicit walk-forward split", async () => {
  const srv = await startTestServer({fetchImpl: upstream(), stateFile: "/nonexistent/paper-state.json"});
  try {
    const res = await getJson(srv.base, "/api/backtest?symbol=BTCUSDT&interval=1h&limit=200&walkForward=150");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.parameters.walkForward, 150);
    assert.deepEqual(res.body.data.evaluationSplit, {
      mode: "explicit",
      inSampleCandles: 150,
      outOfSampleCandles: 50
    });
    assert.equal(res.body.data.inSample.equityCurve.length, 150);
    assert.equal(res.body.data.outOfSample.equityCurve.length, 50);
  } finally {
    await srv.close();
  }
});

test("backtest rejects malformed and impossible walk-forward splits", async () => {
  const srv = await startTestServer({fetchImpl: upstream(), stateFile: "/nonexistent/paper-state.json"});
  try {
    for (const value of ["abc", "1.5", "34", "166"]) {
      const res = await getJson(srv.base, `/api/backtest?symbol=BTCUSDT&limit=200&walkForward=${value}`);
      assert.equal(res.status, 400, `walkForward=${value}`);
      assert.equal(res.body.error.code, "invalid-walk-forward");
    }
  } finally {
    await srv.close();
  }
});

test("backtest refuses an undersized candle history for two honest samples", async () => {
  const srv = await startTestServer({
    fetchImpl: upstream({klines: klineRows(60)}),
    stateFile: "/nonexistent/paper-state.json"
  });
  try {
    const res = await getJson(srv.base, "/api/backtest?symbol=BTCUSDT&limit=200");
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "insufficient-data");
  } finally {
    await srv.close();
  }
});

test("sma-cross sizes fractional BTC instead of flooring to zero", () => {
  const strategy = createStrategy("sma-cross");
  let signal = null;
  for (let i = 0; i < 40; i++) {
    const close = i < 31 ? 42000 : 50000;
    signal = strategy({close}, {cash: 10000, position: 0}) || signal;
  }
  assert.ok(signal);
  assert.equal(signal.side, "BUY");
  assert.ok(signal.quantity > 0);
  assert.ok(signal.quantity < 1);
  assert.ok(signal.quantity * 50000 <= 10000 * 0.95 + 1e-9);
});

test("backtest refuses unknown strategy and unavailable data honestly", async () => {
  const srv = await startTestServer({fetchImpl: upstream({fail: true}), stateFile: "/nonexistent/paper-state.json"});
  try {
    const bad = await getJson(srv.base, "/api/backtest?symbol=BTCUSDT&strategy=coin-flip");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "invalid-strategy");

    const down = await getJson(srv.base, "/api/backtest?symbol=BTCUSDT");
    assert.equal(down.status, 503);
    assert.equal(down.body.state, "unavailable");
  } finally {
    await srv.close();
  }
});
