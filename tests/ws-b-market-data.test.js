// WS-B: outbound HTTP hardening for src/market-data/* (H-sec-1 partial).
// Every request must be bounded by a hard deadline (AbortSignal.timeout + timer
// race), transient failures retry under a total deadline, rate limits are never
// hammered, and continuity gaps surface instead of silently compressing history.
import test from "node:test";
import assert from "node:assert/strict";
import {requestJson, createHyperliquidClient} from "../src/market-data/providers/hyperliquid.js";
import {createCryptoProvider} from "../src/market-data/providers/crypto.js";
import {BinancePublicConnector} from "../src/market-data/connectors/binance.js";
import {normalizeCandle, normalizeQuote} from "../src/market-data/connectors/interface.js";
import {withBackoff} from "../src/market-data/resilience.js";

// A transport that never settles: without a deadline this hangs the pipeline.
const hang = () => new Promise(() => {});

function okJson(payload) {
  return {ok: true, status: 200, json: async () => payload};
}

test("WS-B H-sec-1: requestJson times out a stalled upstream instead of hanging", async () => {
  assert.deepEqual(await requestJson(hang, "https://x.test", {}, {timeoutMs: 25}), {ok: false, reason: "timeout"});
});

test("WS-B H-sec-1: requestJson attaches an AbortSignal and preserves caller init", async () => {
  let seen = null;
  const res = await requestJson(async (_url, init) => {
    seen = init;
    return okJson({v: 1});
  }, "https://x.test", {method: "GET", headers: {"X-Test": "1"}}, {timeoutMs: 25});
  assert.deepEqual(res, {ok: true, data: {v: 1}});
  assert.ok(seen.signal instanceof globalThis.AbortSignal);
  assert.equal(seen.method, "GET");
  assert.deepEqual(seen.headers, {"X-Test": "1"});
});

test("WS-B: requestJson retries transient failures under a deadline, never 429", async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw new Error("boom");
    return okJson({v: 1});
  };
  assert.deepEqual(await requestJson(flaky, "https://x.test", {}, {retries: 2, sleep: async () => {}}), {ok: true, data: {v: 1}});
  assert.equal(calls, 3);

  let limited = 0;
  const res = await requestJson(async () => {
    limited++;
    return {ok: false, status: 429, json: async () => ({})};
  }, "https://x.test", {}, {retries: 3, sleep: async () => {}});
  assert.deepEqual(res, {ok: false, reason: "rate-limited", status: 429});
  assert.equal(limited, 1);
});

test("WS-B: requestJson deadline budget stops retries", async () => {
  let calls = 0;
  const res = await requestJson(() => {
    calls++;
    return hang();
  }, "https://x.test", {}, {timeoutMs: 20, retries: 5, retryDelayMs: 50, deadlineMs: 60});
  assert.deepEqual(res, {ok: false, reason: "timeout"});
  assert.equal(calls, 1);
});

test("WS-B: Hyperliquid and crypto clients are bounded end to end", async () => {
  const client = createHyperliquidClient({fetchImpl: hang, http: {timeoutMs: 20, retries: 0}});
  assert.deepEqual(await client.getTopTraders(), {ok: false, reason: "timeout"});
  assert.deepEqual(await client.getWalletPositions("0x" + "a".repeat(40)), {ok: false, reason: "timeout"});

  const provider = createCryptoProvider({fetchImpl: hang, http: {timeoutMs: 20, retries: 0}});
  assert.deepEqual(await provider.getQuote("BTCUSDT"), {ok: false, reason: "timeout"});
  assert.deepEqual(await provider.getKlines({symbol: "BTCUSDT"}), {ok: false, reason: "timeout"});
});

test("WS-B: BinancePublicConnector request rejects with a timeout error on stall", async () => {
  const c = new BinancePublicConnector({fetchImpl: hang, now: () => 1000, timeoutMs: 20});
  await assert.rejects(() => c.getQuote("btcusdt"), /timeout/);
  await assert.rejects(() => c.getCandles("BTCUSDT", {limit: 1}), /timeout/);
});

test("WS-B: withBackoff is deadline-aware and never sleeps past the budget", async () => {
  let calls = 0;
  let slept = 0;
  await assert.rejects(
    () => withBackoff(async () => {
      calls++;
      throw new Error("x");
    }, {retries: 5, baseMs: 100, deadlineMs: 150, sleep: async (ms) => { slept += ms; }, now: () => 1000}),
    /x/
  );
  assert.equal(calls, 2);
  assert.equal(slept, 100);
});

test("WS-B M5: normalizeCandle enforces schema parity (OHLC bounds, finite times)", () => {
  const base = {source: "t", symbol: "btcusdt", openTime: 0, closeTime: 60000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, receivedAt: 60000};
  const good = normalizeCandle(base);
  assert.equal(good.ageMs, 0);
  assert.equal(good.symbol, "BTCUSDT");
  assert.throws(() => normalizeCandle({...base, open: 3}), Error); // open > high
  assert.throws(() => normalizeCandle({...base, close: 0.25}), Error); // close < low
  assert.throws(() => normalizeCandle({...base, open: 100, high: 50, low: 40, close: 45}), Error);
  assert.throws(() => normalizeCandle({...base, openTime: NaN}), Error);
  assert.throws(() => normalizeCandle({...base, closeTime: NaN}), Error);
  assert.throws(() => normalizeCandle({...base, openTime: Infinity}), Error);
  assert.throws(() => normalizeCandle({...base, closeTime: -1}), Error); // closeTime < openTime
  assert.throws(() => normalizeQuote({source: "t", symbol: "BTCUSDT", bid: 1, ask: 2, timestamp: NaN, receivedAt: 100}), Error);
});

test("WS-B: getKlines flags continuity gaps instead of hiding them", async () => {
  const rows = [
    ["1700000060000", "105", "115", "100", "110", "20", "1700000119999"],
    ["1700000000000", "100", "110", "90", "105", "12", "1700000059999"],
    ["1700000300000", "110", "120", "105", "115", "30", "1700000359999"] // 3 missing 1m bars
  ];
  const provider = createCryptoProvider({fetchImpl: async () => okJson(rows), http: {retries: 0}});
  const res = await provider.getKlines({symbol: "BTCUSDT", interval: "1m", limit: 3});
  assert.equal(res.ok, true);
  assert.deepEqual(res.gaps, [{fromTs: 1700000060000, toTs: 1700000300000, missingBars: 3}]);

  const continuous = [
    ["1700000000000", "100", "110", "90", "105", "12", "1700000059999"],
    ["1700000060000", "105", "115", "100", "110", "20", "1700000119999"],
    ["1700000120000", "110", "120", "105", "115", "30", "1700000179999"]
  ];
  const clean = await createCryptoProvider({fetchImpl: async () => okJson(continuous), http: {retries: 0}}).getKlines({symbol: "BTCUSDT", interval: "1m", limit: 3});
  assert.deepEqual(clean.gaps, []);
});
