import test from "node:test";
import assert from "node:assert/strict";
import {URLSearchParams} from "node:url";
import {createApi} from "../server/api.js";
import {startTestServer, getJson, fakeFetch, jsonResponse, klineRows, ticker24hPayload} from "./ws-d-helpers.js";

const candles = Array.from({length: 80}, (_, i) => ({
  openTime: 1700000000000 + i * 3600000,
  open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 100
}));
const ticker = {symbol: "BTCUSDT", last: 180, quoteVolume24h: 50000000, changePct24h: 6};

function apiFor(tickerPatch = {}, candlePatch = {}) {
  return createApi({
    now: () => 1700000000000,
    stateFile: "/nonexistent/council-freshness-state.json",
    executionStateFile: "/nonexistent/council-freshness-orders.json",
    market: {
      getTicker: async () => ({state: "ok", stale: false, ageMs: 0, data: ticker, ...tickerPatch}),
      getCandles: async () => ({state: "ok", stale: false, ageMs: 0, data: candles, ...candlePatch})
    }
  });
}

test("council exposes fresh snapshot ages and retains advisory scores at the freshness boundary", async () => {
  const out = await apiFor({ageMs: 10000}).aiCouncil(new URLSearchParams(), "BTCUSDT");
  assert.equal(out.status, 200);
  assert.equal(out.body.data.state, "ok");
  assert.equal(out.body.data.freshness.ticker.ageMs, 10000);
  assert.equal(out.body.data.freshness.candles.ageMs, 0);
  assert.ok(Number.isFinite(out.body.data.council.opportunityScore));
});

test("a quote that ages while waiting for candles cannot become fresh council evidence", async () => {
  const clock = {t: 1700000000000};
  const api = createApi({
    now: () => clock.t,
    stateFile: "/nonexistent/council-freshness-state.json",
    market: {
      getTicker: async () => ({state: "ok", stale: false, ageMs: 0, data: ticker}),
      getCandles: async () => {
        clock.t += 20000;
        return {state: "ok", stale: false, ageMs: 0, data: candles};
      }
    }
  });
  const out = await api.aiCouncil(new URLSearchParams(), "BTCUSDT");
  assert.equal(out.body.data.state, "stale");
  assert.equal(out.body.data.freshness.ticker.ageMs, 20000);
  assert.equal(out.body.data.freshness.candles.ageMs, 0);
  assert.equal(out.body.data.council.decision, "WAIT");
});

test("either stale input forces WAIT without a current opportunity score", async (t) => {
  for (const field of ["ticker", "candles"]) {
    await t.test(field, async () => {
      const patch = {state: "stale", stale: true, ageMs: 60000};
      const api = field === "ticker" ? apiFor(patch) : apiFor({}, patch);
      const out = await api.aiCouncil(new URLSearchParams(), "BTCUSDT");
      assert.equal(out.status, 200);
      assert.equal(out.body.data.state, "stale");
      assert.equal(out.body.data.freshness[field].ageMs, 60000);
      assert.equal(out.body.data.council.decision, "WAIT");
      assert.equal(out.body.data.council.opportunityScore, null);
      assert.equal(out.body.data.council.uncertainty.toLowerCase(), "high");
      assert.match(out.body.data.council.explanation, /stale|freshness unknown/i);
    });
  }
});

test("unknown, negative and excessive snapshot ages are not fresh evidence", async (t) => {
  for (const ageMs of [undefined, Number.NaN, -1, 10001]) {
    await t.test(String(ageMs), async () => {
      const out = await apiFor({ageMs}).aiCouncil(new URLSearchParams(), "BTCUSDT");
      assert.equal(out.body.data.state, "stale");
      assert.equal(out.body.data.council.decision, "WAIT");
      assert.equal(out.body.data.council.opportunityScore, null);
    });
  }
});

test("missing ticker or insufficient candle history returns unavailable without synthetic analysis", async (t) => {
  for (const [name, api] of [
    ["ticker unavailable", apiFor({state: "unavailable", data: undefined})],
    ["candles unavailable", apiFor({}, {state: "unavailable", data: undefined})],
    ["empty history", apiFor({}, {data: []})],
    ["insufficient history", apiFor({}, {data: candles.slice(0, 19)})]
  ]) {
    await t.test(name, async () => {
      const out = await api.aiCouncil(new URLSearchParams(), "BTCUSDT");
      assert.equal(out.status, 503);
      assert.equal(out.body.state, "unavailable");
      assert.equal(out.body.error.code, "council-data-unavailable");
      assert.equal(out.body.data, undefined);
    });
  }
});

test("HTTP council changes from fresh to cached stale to unavailable and recovers", async () => {
  const clock = {t: 1700000000000};
  const up = {fail: false};
  const srv = await startTestServer({
    stateFile: "/nonexistent/council-freshness-state.json",
    now: () => clock.t,
    fetchImpl: fakeFetch([
      ["/api/v3/ticker/24hr", () => up.fail ? jsonResponse(503, {}) : jsonResponse(200, ticker24hPayload())],
      ["/api/v3/klines", () => up.fail ? jsonResponse(503, {}) : jsonResponse(200, klineRows(100))]
    ])
  });
  try {
    const path = "/api/ai/council/BTCUSDT";
    const fresh = await getJson(srv.base, path);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.data.state, "ok");
    clock.t += 60000;
    up.fail = true;
    const stale = await getJson(srv.base, path);
    assert.equal(stale.body.data.state, "stale");
    assert.equal(stale.body.data.council.decision, "WAIT");
    assert.equal(stale.body.data.council.opportunityScore, null);
    clock.t += 600000;
    const unavailable = await getJson(srv.base, path);
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.data, undefined);
    up.fail = false;
    const recovered = await getJson(srv.base, path);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.data.state, "ok");
    assert.ok(Number.isFinite(recovered.body.data.council.opportunityScore));
  } finally {
    srv.server.closeAllConnections?.();
    await srv.close();
  }
});
