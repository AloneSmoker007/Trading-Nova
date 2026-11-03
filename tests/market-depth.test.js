import test from "node:test";
import assert from "node:assert/strict";
import {BinanceSpotDepthBook, normalizeDepthSnapshot} from "../src/market-data/order-book.js";
import {createCryptoProvider} from "../src/market-data/providers/crypto.js";
import {BinancePublicConnector} from "../src/market-data/connectors/binance.js";

const okJson = (payload) => ({ok: true, status: 200, json: async () => payload});
const snapshot = (lastUpdateId = 100, extra = {}) => ({
  lastUpdateId,
  bids: [["99", "1"], ["98", "2"]],
  asks: [["101", "1"], ["102", "2"]],
  ...extra
});
const event = (U, u, extra = {}) => ({
  e: "depthUpdate",
  E: 900,
  s: "BTCUSDT",
  U,
  u,
  b: [],
  a: [],
  ...extra
});

test("depth snapshot normalization preserves sequence and receipt metadata without inventing event time", () => {
  const result = normalizeDepthSnapshot(snapshot(), {symbol: "btcusdt", receivedAt: 1000, snapshotLimit: 100});
  assert.equal(result.symbol, "BTCUSDT");
  assert.equal(result.lastUpdateId, 100);
  assert.equal(result.snapshotLimit, 100);
  assert.equal(result.timestamp, null);
  assert.equal(result.timestampStatus, "not-provided");
  assert.equal(result.receivedAt, 1000);
  assert.equal(Object.isFrozen(result.bids[0]), true);
});

test("depth snapshot rejects crossed, unsorted, duplicate and unsafe sequence data", () => {
  assert.throws(() => normalizeDepthSnapshot(snapshot(100, {bids: [["101", "1"]], asks: [["101", "1"]]}), {symbol: "BTCUSDT"}));
  assert.throws(() => normalizeDepthSnapshot(snapshot(100, {bids: [["98", "1"], ["99", "1"]]}), {symbol: "BTCUSDT"}));
  assert.throws(() => normalizeDepthSnapshot(snapshot(100, {bids: [["99", "1"], ["99.0", "2"]]}), {symbol: "BTCUSDT"}));
  assert.throws(() => normalizeDepthSnapshot(snapshot(Number.MAX_SAFE_INTEGER + 1), {symbol: "BTCUSDT"}));
});

test("provider exposes a bounded Binance depth snapshot and the official diff stream URL", async () => {
  const payload = snapshot();
  const calls = [];
  const provider = createCryptoProvider({
    fetchImpl: async (url) => { calls.push(String(url)); return okJson(payload); },
    now: () => 1000,
    http: {retries: 0}
  });
  const result = await provider.getDepthSnapshot("btcusdt");
  assert.equal(result.ok, true);
  assert.equal(calls[0], "https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=100");
  assert.equal(result.data.lastUpdateId, 100);
  assert.equal(result.data.timestamp, null);
  assert.equal(result.data.receivedAt, 1000);
  assert.deepEqual(provider.getDepthStreamUrl("BTCUSDT"), {
    ok: true,
    data: "wss://stream.binance.com:9443/ws/btcusdt@depth@100ms"
  });
  assert.deepEqual(provider.getDepthStreamUrl("BTCUSDT", {speed: "1000ms"}), {
    ok: true,
    data: "wss://stream.binance.com:9443/ws/btcusdt@depth"
  });
});

test("provider rejects invalid depth symbols, limits and stream speeds without network access", async () => {
  let calls = 0;
  const provider = createCryptoProvider({
    fetchImpl: async () => { calls++; return okJson(snapshot()); },
    http: {retries: 0}
  });
  assert.deepEqual(await provider.getDepthSnapshot("BTC/USDT"), {ok: false, reason: "invalid-symbol"});
  assert.deepEqual(await provider.getDepthSnapshot("BTCUSDT", {limit: 2000}), {ok: false, reason: "invalid-limit"});
  assert.deepEqual(provider.getDepthStreamUrl("BTC/USDT"), {ok: false, reason: "invalid-symbol"});
  assert.deepEqual(provider.getDepthStreamUrl("BTCUSDT", {speed: "25ms"}), {ok: false, reason: "invalid-speed"});
  assert.equal(calls, 0);
});

test("BinancePublicConnector exposes a validated snapshot and diff-depth URL", async () => {
  const calls = [];
  const connector = new BinancePublicConnector({
    fetchImpl: async (url) => { calls.push(String(url)); return okJson(snapshot()); },
    now: () => 2000
  });
  const result = await connector.getDepthSnapshot("btcusdt");
  assert.equal(result.lastUpdateId, 100);
  assert.equal(result.snapshotLimit, 100);
  assert.equal(result.receivedAt, 2000);
  assert.equal(calls[0], "https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=100");
  const deeper = await connector.getDepthSnapshot("BTCUSDT", {limit: 50});
  assert.equal(deeper.snapshotLimit, 50);
  assert.equal(calls[1], "https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=50");
  assert.equal(connector.depthWebsocketUrl("BTCUSDT"), "wss://stream.binance.com:9443/ws/btcusdt@depth@100ms");
  assert.equal(connector.depthWebsocketUrl("BTCUSDT", "1000ms"), "wss://stream.binance.com:9443/ws/btcusdt@depth");
  assert.throws(() => connector.depthWebsocketUrl("BTC/USDT"), /symbol/);
});

test("depth book buffers stream events before snapshot and applies the first bridging sequence", () => {
  let clock = 1000;
  const book = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => clock});
  assert.equal(book.getView().executionEligible, false);
  book.ingest(event(99, 102, {E: 900, b: [["99", "2"]]}));
  book.ingest(event(103, 104, {E: 950, a: [["101", "3"]]}));
  const view = book.setSnapshot(snapshot(100, {snapshotLimit: 100}));
  assert.equal(view.status, "ready");
  assert.equal(view.updateId, 104);
  assert.equal(view.bestBid, 99);
  assert.equal(view.bestAsk, 101);
  assert.equal(view.ageMs, 50);
  assert.equal(view.eventReceivedAt, 1000);
  assert.equal(view.isUsable, true);
  assert.equal(view.executionEligible, false);
});

test("depth book ignores updates already covered by snapshot and duplicate sequence events", () => {
  const book = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => 1000});
  book.setSnapshot(snapshot());
  book.ingest(event(90, 100, {E: 850, b: [["99", "9"]]}));
  assert.equal(book.getView().status, "syncing");
  book.ingest(event(100, 101, {E: 900, b: [["99", "2"]]}));
  book.ingest(event(100, 101, {E: 901, b: [["99", "8"]]}));
  const view = book.getView();
  assert.equal(view.status, "ready");
  assert.equal(view.updateId, 101);
  assert.equal(view.bids[0].quantity, 2);
});
test("depth book rejects a snapshot that is behind the first buffered stream event", () => {
  const book = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => 1000});
  book.ingest(event(101, 102, {E: 900}));
  const view = book.setSnapshot(snapshot(100));
  assert.equal(view.status, "invalid");
  assert.equal(view.reason, "snapshot-behind-stream");
  assert.equal(view.snapshotLimit, null);
  assert.equal(view.snapshotReceivedAt, null);
  assert.equal(view.executionEligible, false);
});


test("depth book invalidates and clears on a missing sequence range after the initial bridge", () => {
  const book = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => 1000});
  book.setSnapshot(snapshot());
  book.ingest(event(100, 101, {E: 890}));
  const view = book.ingest(event(103, 103, {E: 900, b: [["99", "4"]]}));
  assert.equal(view.status, "invalid");
  assert.equal(view.reason, "sequence-gap");
  assert.equal(view.snapshotLimit, null);
  assert.equal(view.snapshotReceivedAt, null);
  assert.equal(view.isUsable, false);
  assert.deepEqual(view.bids, []);
  assert.deepEqual(view.asks, []);
});

test("depth book applies absolute quantities and zero-quantity deletions", () => {
  const book = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => 1000});
  book.setSnapshot(snapshot());
  const view = book.ingest(event(100, 101, {
    E: 950,
    b: [["99", "3"], ["97", "4"]],
    a: [["101", "0"], ["100", "5"]]
  }));
  assert.equal(view.status, "ready");
  assert.equal(view.bestBid, 99);
  assert.equal(view.bestAsk, 100);
  assert.deepEqual(view.bids.slice(0, 2), [{price: 99, quantity: 3}, {price: 98, quantity: 2}]);
  assert.deepEqual(view.asks.slice(0, 2), [{price: 100, quantity: 5}, {price: 102, quantity: 2}]);
});

test("depth book invalidates malformed events and symbol mismatches", () => {
  const wrongSymbol = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => 1000});
  wrongSymbol.setSnapshot(snapshot());
  assert.equal(wrongSymbol.ingest(event(100, 101, {s: "ETHUSDT"})).reason, "invalid-event");

  const malformed = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => 1000});
  malformed.setSnapshot(snapshot());
  assert.equal(malformed.ingest(event(100, 101, {b: [["99", "-1"]]})).reason, "invalid-event");
});

test("depth book invalidates crossed updates without publishing a partially changed book", () => {
  const book = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => 1000});
  book.setSnapshot(snapshot());
  const view = book.ingest(event(100, 101, {E: 950, b: [["101", "2"]]}));
  assert.equal(view.status, "invalid");
  assert.equal(view.reason, "crossed-book");
  assert.deepEqual(view.bids, []);
});

test("depth book bounds pre-snapshot buffering and requires explicit reset after invalidation", () => {
  const book = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => 1000, maxBufferedEvents: 1});
  book.ingest(event(100, 101));
  assert.equal(book.ingest(event(102, 102)).reason, "buffer-overflow");
  assert.equal(book.setSnapshot(snapshot()).status, "invalid");
  book.reset();
  book.ingest(event(100, 101));
  assert.equal(book.setSnapshot(snapshot()).status, "ready");
});

test("depth freshness uses exchange event time, not local receipt time", () => {
  let clock = 1000;
  const book = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => clock});
  book.setSnapshot(snapshot());
  const first = book.ingest(event(100, 101, {E: 900}));
  assert.equal(first.ageMs, 100);
  assert.equal(first.eventReceivedAt, 1000);
  assert.equal(first.freshness, "fresh");
  clock = 2100;
  const stale = book.getView();
  assert.equal(stale.ageMs, 1200);
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.isUsable, false);
  assert.equal(stale.executionEligible, false);
});

test("future event timestamps and one-sided books are never usable", () => {
  const future = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => 1000});
  future.setSnapshot(snapshot());
  const futureView = future.ingest(event(100, 101, {E: 1100}));
  assert.equal(futureView.freshness, "future");
  assert.equal(futureView.ageMs, null);
  assert.equal(futureView.isUsable, false);

  const oneSided = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => 1000});
  oneSided.setSnapshot({lastUpdateId: 100, bids: [["99", "1"]], asks: []});
  const oneSidedView = oneSided.ingest(event(100, 101, {E: 950}));
  assert.equal(oneSidedView.reason, "one-sided-book");
  assert.equal(oneSidedView.isUsable, false);
});

test("depth book caps retained levels while preserving the best prices", () => {
  const book = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => 1000, maxLevels: 2});
  book.setSnapshot({
    lastUpdateId: 100,
    snapshotLimit: 2,
    bids: [["99", "1"], ["98", "2"]],
    asks: [["101", "1"], ["102", "2"]]
  });
  const view = book.ingest(event(100, 101, {
    E: 950,
    b: [["100", "1"], ["97", "5"]],
    a: [["103", "1"]]
  }));
  assert.deepEqual(view.bids, [{price: 100, quantity: 1}, {price: 99, quantity: 1}]);
  assert.deepEqual(view.asks, [{price: 101, quantity: 1}, {price: 102, quantity: 2}]);
  assert.equal(view.executionEligible, false);
});


test("depth book accepts the next contiguous update when the snapshot covers every pre-snapshot event", () => {
  const book = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => 1000});
  book.ingest(event(90, 100, {E: 850, b: [["99", "2"]]}));
  const snapshotView = book.setSnapshot(snapshot(100));
  assert.equal(snapshotView.status, "syncing");
  assert.equal(snapshotView.updateId, 100);

  const view = book.ingest(event(101, 101, {E: 950, b: [["99", "3"]]}));
  assert.equal(view.status, "ready");
  assert.equal(view.updateId, 101);
  assert.equal(view.bestBid, 99);
  assert.equal(view.bids[0].quantity, 3);
  assert.equal(view.executionEligible, false);
});

test("depth book still rejects a first post-snapshot event when no pre-snapshot stream event was buffered", () => {
  const book = new BinanceSpotDepthBook({symbol: "BTCUSDT", now: () => 1000});
  book.setSnapshot(snapshot(100));
  const view = book.ingest(event(101, 101, {E: 950}));
  assert.equal(view.status, "invalid");
  assert.equal(view.reason, "snapshot-behind-stream");
  assert.equal(view.executionEligible, false);
});
