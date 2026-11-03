import assert from "node:assert/strict";
import test from "node:test";
import {createMarketDepthService} from "../server/market-depth.js";
import {startTestServer, getJson, jsonResponse} from "./ws-d-helpers.js";

class FakeTimers {
  constructor() { this.now = 1000; this.nextId = 1; this.tasks = new Map(); }
  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.tasks.set(id, {callback, at: this.now + delay});
    return id;
  };
  clearTimeout = (id) => { this.tasks.delete(id); };
  advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const due = [...this.tasks.entries()].filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

test("depth service shares one session per symbol, bounds symbols and releases idle streams", () => {
  const timers = new FakeTimers();
  const created = [];
  const service = createMarketDepthService({
    now: () => timers.now,
    idleMs: 1000,
    maxSessions: 2,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    createStream(symbol) {
      const stream = {
        symbol, starts: 0, stops: 0,
        start() { this.starts++; },
        stop() { this.stops++; },
        getView() { return {symbol, executionEligible: false, transportState: "connecting"}; }
      };
      created.push(stream);
      return stream;
    }
  });

  assert.equal(service.read("BTCUSDT").ok, true);
  assert.equal(service.read("BTCUSDT").ok, true);
  assert.equal(created.length, 1, "same-symbol readers share one upstream session");
  assert.equal(created[0].starts, 1);
  assert.equal(service.read("ETHUSDT").ok, true);
  assert.equal(service.read("SOLUSDT").reason, "capacity");
  assert.equal(service.activeCount, 2);

  timers.advance(1000);
  assert.equal(created[0].stops, 1);
  assert.equal(created[1].stops, 1);
  assert.equal(service.activeCount, 0);
  assert.equal(service.read("SOLUSDT").ok, true);
  service.close();
  assert.equal(created[2].stops, 1);
  assert.equal(service.read("BTCUSDT").reason, "service-closed");
});

test("depth service rejects malformed symbols and views that violate analysis-only contract", () => {
  let creates = 0;
  const service = createMarketDepthService({
    createStream(symbol) {
      creates++;
      return {
        start() {},
        stop() {},
        getView() { return {symbol, executionEligible: true}; }
      };
    }
  });
  assert.equal(service.read("BTC/USDT").reason, "invalid-symbol");
  assert.equal(creates, 0);
  assert.equal(service.read("BTCUSDT").reason, "invalid-view");
  assert.equal(service.activeCount, 0);
  service.close();
});

class FakeSocket {
  constructor(url) { this.url = url; this.listeners = new Map(); this.closed = false; }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || new Set();
    handlers.add(handler);
    this.listeners.set(type, handlers);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  emit(type, value = {}) { for (const handler of [...(this.listeners.get(type) || [])]) handler(value); }
  open() { this.emit("open"); }
  message(data) { this.emit("message", {data}); }
  close() { this.closed = true; this.emit("close"); }
}

function snapshot() {
  return {lastUpdateId: 100, bids: [["99", "2"], ["98", "3"]], asks: [["101", "2"], ["102", "3"]]};
}
function depthEvent() {
  return {e: "depthUpdate", E: 990, s: "BTCUSDT", U: 99, u: 102, b: [["99", "2"]], a: []};
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

test("GET depth shares a public stream, returns honest sequence state and never enables execution", async () => {
  const sockets = [];
  class Socket extends FakeSocket {
    constructor(url) { super(url); sockets.push(this); }
  }
  const srv = await startTestServer({
    now: () => 1000,
    WebSocketImpl: Socket,
    fetchImpl: async (url) => String(url).includes("/api/v3/depth")
      ? jsonResponse(200, snapshot()) : jsonResponse(500, {})
  });
  try {
    const first = await getJson(srv.base, "/api/market/BTCUSDT/depth");
    assert.equal(first.status, 200);
    assert.equal(first.body.data.transportState, "connecting");
    assert.equal(first.body.data.executionEligible, false);
    assert.equal(sockets.length, 1);

    const shared = await getJson(srv.base, "/api/market/BTCUSDT/depth");
    assert.equal(shared.status, 200);
    assert.equal(sockets.length, 1, "a second reader must not open a duplicate socket");

    sockets[0].open();
    sockets[0].message(JSON.stringify(depthEvent()));
    await flush();

    const ready = await getJson(srv.base, "/api/market/BTCUSDT/depth");
    assert.equal(ready.status, 200);
    assert.equal(ready.body.data.state, "ok");
    assert.equal(ready.body.data.transportState, "ready");
    assert.equal(ready.body.data.isUsable, true);
    assert.equal(ready.body.data.executionEligible, false);
    assert.equal(ready.body.data.bestBid, 99);
    assert.equal(ready.body.data.bestAsk, 101);
    assert.equal(ready.body.data.ageMs, 10);
    assert.equal(ready.body.data.sourceEventTime, 990);
    assert.equal(ready.body.data.bids.length, 2);
    assert.equal(ready.body.data.asks.length, 2);

    const invalid = await getJson(srv.base, "/api/market/%2Fetc/depth");
    assert.equal(invalid.status, 400);
    assert.equal(sockets.length, 1);
    const head = await fetch(srv.base + "/api/market/BTCUSDT/depth", {method: "HEAD"});
    assert.equal(head.status, 405);
  } finally {
    await srv.close();
  }
  assert.equal(sockets[0].closed, true, "server close must stop the shared upstream stream");
});

test("missing WebSocket runtime returns unavailable without a REST snapshot request", async () => {
  let fetchCalls = 0;
  const srv = await startTestServer({
    WebSocketImpl: null,
    fetchImpl: async () => { fetchCalls++; return jsonResponse(500, {}); }
  });
  try {
    const result = await getJson(srv.base, "/api/market/BTCUSDT/depth");
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "depth-unavailable");
    assert.equal(fetchCalls, 0);
  } finally {
    await srv.close();
  }
});
