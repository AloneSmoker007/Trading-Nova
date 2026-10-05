// Controlled fault-injection harness for the proposed WS feed + NO-TRADE gate.
// NOTE: frames here are synthetic TEST FIXTURE data on localhost. They prove
// control-flow correctness only and are NOT market-feed evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { WsFeed, parseBinanceDepthFrame } from "../src/market-data/ws-feed.js";
import { evaluateMarketGate, withMarketGate } from "../src/market-data/guard.js";
import { createPaperExecution } from "../src/execution/paper.js";
import { startWsFixture } from "./helpers/ws-fixture.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeoutMs = 3000, label = "") {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(10);
  }
  throw new Error("condition not met within " + timeoutMs + "ms: " + label);
}

function frameFactory(start = 1000) {
  let cursor = start;
  return {
    next() {
      const U = cursor + 1, u = cursor + 10; cursor = u;
      return JSON.stringify({ e: "depthUpdate", E: Date.now(), s: "BTCUSDT", U, u, b: [["100", "1"]], a: [["101", "1"]] });
    },
    jump() { cursor += 1000; return this.next(); }
  };
}

async function withFeed(options, body) {
  const fixture = await startWsFixture();
  const feed = new WsFeed({ url: fixture.url, backoffBaseMs: 20, ...options });
  try {
    await body(feed, fixture);
  } finally {
    feed.close();
    await fixture.stop();
  }
}

test("feed accepts valid frames and reaches tradable state only after fresh continuity", async () => {
  await withFeed({}, async (feed, fixture) => {
    const frames = frameFactory();
    feed.connect();
    await waitUntil(() => fixture.clientCount === 1);
    fixture.send(frames.next());
    fixture.send(frames.next());
    assert.equal(feed.canTrade(), false, "still resyncing");
    fixture.send(frames.next());
    await waitUntil(() => feed.canTrade());
    assert.equal(feed.malformedCount, 0);
    assert.equal(feed.qualityState().validCount, 3);
  });
});

test("garbage frames never throw and deterministically block trading until resync", async () => {
  await withFeed({}, async (feed, fixture) => {
    const frames = frameFactory();
    feed.connect();
    await waitUntil(() => fixture.clientCount === 1);
    for (let i = 0; i < 3; i++) fixture.send(frames.next());
    await waitUntil(() => feed.canTrade());
    fixture.send("this is not json {{{");
    fixture.send(JSON.stringify({ E: "bad", U: "x", u: null }));
    fixture.send(JSON.stringify({ e: "depthUpdate", E: Date.now(), s: "BTCUSDT", U: 1, u: 2, b: [["-5", "1"]], a: [] }));
    await waitUntil(() => feed.malformedCount === 3);
    assert.equal(feed.canTrade(), false, "NO-TRADE after corruption");
    const gate = evaluateMarketGate(feed.qualityState());
    assert.equal(gate.allowed, false);
    for (let i = 0; i < 3; i++) fixture.send(frames.next());
    await waitUntil(() => feed.canTrade(), 3000, "recovers after re-proven continuity");
  });
});

test("sequence gap is detected and blocks trading until resync", async () => {
  await withFeed({}, async (feed, fixture) => {
    const frames = frameFactory();
    feed.connect();
    await waitUntil(() => fixture.clientCount === 1);
    for (let i = 0; i < 3; i++) fixture.send(frames.next());
    await waitUntil(() => feed.canTrade());
    fixture.send(frames.jump());
    await waitUntil(() => feed.gapCount === 1);
    assert.equal(feed.canTrade(), false, "NO-TRADE on gap");
    assert.ok(evaluateMarketGate(feed.qualityState()).reasons.includes("SEQUENCE_GAP"));
    for (let i = 0; i < 3; i++) fixture.send(frames.next());
    await waitUntil(() => feed.canTrade(), 3000, "gap recovered after resync events");
  });
});

test("connection drop blocks trading and automatic reconnect recovers", async () => {
  await withFeed({}, async (feed, fixture) => {
    const frames = frameFactory();
    feed.connect();
    await waitUntil(() => fixture.clientCount === 1);
    for (let i = 0; i < 3; i++) fixture.send(frames.next());
    await waitUntil(() => feed.canTrade());
    fixture.drop(); // abrupt transport failure
    await waitUntil(() => !feed.canTrade());
    assert.equal(feed.qualityState().connected, false);
    await waitUntil(() => fixture.clientCount === 1, 3000, "auto-reconnect established");
    assert.ok(feed.reconnectCount >= 1);
    const f2 = frameFactory(5000);
    for (let i = 0; i < 3; i++) fixture.send(f2.next());
    await waitUntil(() => feed.canTrade(), 3000, "tradable after reconnect + resync");
  });
});

test("stale data blocks trading past maxAgeMs", async () => {
  const clock = { t: 1_000_000 };
  await withFeed({ now: () => clock.t, maxAgeMs: 500 }, async (feed, fixture) => {
    const frames = frameFactory();
    feed.connect();
    await waitUntil(() => fixture.clientCount === 1);
    for (let i = 0; i < 3; i++) fixture.send(frames.next());
    await waitUntil(() => feed.canTrade());
    clock.t += 400;
    assert.equal(feed.canTrade(), true, "still fresh");
    clock.t += 200;
    assert.equal(feed.canTrade(), false, "NO-TRADE when stale");
    assert.ok(evaluateMarketGate(feed.qualityState(), { now: clock.t }).reasons.includes("STALE_DATA"));
  });
});

test("latency is measured against exchange timestamps", async () => {
  await withFeed({}, async (feed, fixture) => {
    feed.connect();
    await waitUntil(() => fixture.clientCount === 1);
    const E = Date.now() - 50;
    fixture.send(JSON.stringify({ e: "depthUpdate", E, s: "BTCUSDT", U: 1, u: 2, b: [["100", "1"]], a: [["101", "1"]] }));
    await waitUntil(() => feed.validCount === 1);
    const summary = feed.latencySummary();
    assert.equal(summary.samples, 1);
    assert.ok(summary.p50Ms >= 50 && summary.p50Ms < 500, "exchange->receive latency " + summary.p50Ms + "ms");
    assert.equal(feed.qualityState().lastExchangeTime, E);
  });
});

test("withMarketGate refuses to execute on any unhealthy market state (fail-closed)", () => {
  let clock = 10_000;
  const execution = createPaperExecution();
  const state = { state: "CONNECTED", connected: true, gapOpen: false, invalidData: false, lastValidAt: 10_000 };
  const gated = withMarketGate(execution, () => state, { now: () => clock, maxAgeMs: 500 });
  const order = { symbol: "BTCUSDT", side: "BUY", quantity: 1, price: 100 };
  assert.equal(gated.submit(order).status, "FILLED", "healthy data permits paper trade");

  const blockedCases = [
    { ...state, state: "DISCONNECTED", connected: false },
    { ...state, gapOpen: true },
    { ...state, invalidData: true },
    { ...state, lastValidAt: 1 },
    null,
    { state: "WEIRD" }
  ];
  for (const s of blockedCases) {
    const g = withMarketGate(execution, () => s, { now: () => clock, maxAgeMs: 500 });
    const r = g.submit(order);
    assert.equal(r.status, "NO_TRADE");
    assert.equal(r.blocked, true);
    assert.ok(r.reasons.length >= 1, "deterministic refusal reason recorded: " + JSON.stringify(r.reasons));
  }
  clock = 10_000;
  assert.equal(gated.submit(order).status, "FILLED", "recovers when state healthy again");
});

test("depth frame parser rejects malformed payloads explicitly", () => {
  assert.throws(() => parseBinanceDepthFrame("nope"));
  assert.throws(() => parseBinanceDepthFrame(JSON.stringify({})));
  assert.throws(() => parseBinanceDepthFrame(JSON.stringify({ E: 1, U: 1, u: 0, s: "X", b: [], a: [] })));
  assert.equal(parseBinanceDepthFrame(JSON.stringify({ E: Date.now(), U: 1, u: 2, s: "btcusdt", b: [["1", "1"]], a: [["2", "1"]] })).symbol, "BTCUSDT");
});
