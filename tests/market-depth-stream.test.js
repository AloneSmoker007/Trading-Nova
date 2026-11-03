import assert from "node:assert/strict";
import test from "node:test";
import {BinanceSpotDepthStream} from "../src/market-data/depth-stream.js";
import {createCryptoProvider} from "../src/market-data/providers/crypto.js";

function snapshot(lastUpdateId = 100) {
  return {
    symbol: "BTCUSDT",
    lastUpdateId,
    snapshotLimit: 100,
    bids: [["99", "2"], ["98", "3"]],
    asks: [["101", "2"], ["102", "3"]]
  };
}

function event(firstUpdateId, finalUpdateId, eventTime = 990) {
  return {
    e: "depthUpdate",
    E: eventTime,
    s: "BTCUSDT",
    U: firstUpdateId,
    u: finalUpdateId,
    b: [["99", "2"]],
    a: []
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

async function flush() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

class FakeTimers {
  constructor() {
    this.now = 1000;
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.tasks.set(id, {callback, at: this.now + delay});
    return id;
  };

  clearTimeout = (id) => {
    this.tasks.delete(id);
  };

  nextDelay() {
    const next = [...this.tasks.values()].sort((a, b) => a.at - b.at)[0];
    return next ? next.at - this.now : null;
  }

  advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.closed = false;
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || new Set();
    handlers.add(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type, eventValue = {}) {
    for (const handler of [...(this.listeners.get(type) || [])]) handler(eventValue);
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  message(data) {
    this.emit("message", {data});
  }

  serverClose() {
    this.readyState = 3;
    this.emit("close");
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }
}

function socketFactory(sockets) {
  return class extends FakeSocket {
    constructor(url) {
      super(url);
      sockets.push(this);
    }
  };
}

function providerStub(getDepthSnapshot) {
  return {
    getDepthStreamUrl(symbol, {speed} = {}) {
      const suffix = speed === "100ms" ? "@100ms" : "";
      return {ok: true, data: "wss://stream.binance.com:9443/ws/" + symbol.toLowerCase() + "@depth" + suffix};
    },
    getDepthSnapshot
  };
}

function createSession({provider, timers = new FakeTimers(), sockets = [], options = {}}) {
  const Socket = socketFactory(sockets);
  const session = new BinanceSpotDepthStream({
    symbol: "BTCUSDT",
    provider,
    WebSocketImpl: Socket,
    now: () => timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    random: () => 0.5,
    reconnectMinMs: 100,
    reconnectMaxMs: 400,
    snapshotTimeoutMs: 500,
    connectTimeoutMs: 500,
    idleTimeoutMs: 5000,
    ...options
  });
  return {session, timers, sockets};
}

test("connection handshake timeout reconnects when a socket never opens", () => {
  const provider = providerStub(async () => ({ok: true, data: snapshot(100)}));
  const {session, timers, sockets} = createSession({provider});
  session.start();
  assert.equal(session.getView().transportState, "connecting");
  timers.advance(500);
  assert.equal(session.getView().transportState, "reconnecting");
  assert.equal(session.getView().lastError, "connect-timeout");
  assert.equal(sockets[0].closed, true);
  assert.equal(timers.nextDelay(), 100);
  session.stop();
});

test("depth stream opens before snapshot fetch and bridges the first buffered event", async () => {
  const pending = deferred();
  let snapshotCalls = 0;
  const provider = providerStub(() => {
    snapshotCalls++;
    return pending.promise;
  });
  const updates = [];
  const {session, sockets} = createSession({provider, options: {onUpdate: (view) => updates.push(view)}});
  session.start();

  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, "wss://stream.binance.com:9443/ws/btcusdt@depth@100ms");
  assert.equal(snapshotCalls, 0);
  sockets[0].open();
  assert.equal(snapshotCalls, 0);

  sockets[0].message(JSON.stringify(event(99, 102)));
  await flush();
  assert.equal(snapshotCalls, 1);
  assert.equal(session.getView().transportState, "syncing");

  pending.resolve({ok: true, data: snapshot(100)});
  await flush();
  const view = session.getView();
  assert.equal(view.transportState, "ready");
  assert.equal(view.status, "ready");
  assert.equal(view.updateId, 102);
  assert.equal(view.isUsable, true);
  assert.equal(view.executionEligible, false);
  assert.ok(updates.length >= 3);
});

test("sequence gap invalidates the book, closes the socket and reconnects with a fresh snapshot", async () => {
  let snapshotCalls = 0;
  const provider = providerStub(async () => {
    snapshotCalls++;
    return {ok: true, data: snapshot(snapshotCalls === 1 ? 100 : 200)};
  });
  const {session, timers, sockets} = createSession({provider});
  session.start();
  sockets[0].open();
  sockets[0].message(JSON.stringify(event(90, 100)));
  await flush();
  assert.equal(session.getView().transportState, "syncing");

  sockets[0].message(JSON.stringify(event(101, 101)));
  assert.equal(session.getView().transportState, "ready");
  assert.equal(session.getView().updateId, 101);

  sockets[0].message(JSON.stringify(event(103, 103)));
  assert.equal(session.getView().transportState, "reconnecting");
  assert.equal(session.getView().lastError, "depth-sequence-gap");
  assert.equal(sockets[0].closed, true);
  const afterGap = session.getView();
  sockets[0].message(JSON.stringify(event(102, 102)));
  assert.equal(session.getView().transportState, afterGap.transportState);
  assert.equal(snapshotCalls, 1);

  assert.equal(timers.nextDelay(), 100);
  timers.advance(100);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  sockets[1].message(JSON.stringify(event(199, 202)));
  await flush();
  assert.equal(snapshotCalls, 2);
  assert.equal(session.getView().transportState, "ready");
  assert.equal(session.getView().updateId, 202);
  assert.equal(session.getView().executionEligible, false);
});

test("snapshot timeout ignores a late response and schedules only one reconnect", async () => {
  const pending = deferred();
  const provider = providerStub(() => pending.promise);
  const {session, timers, sockets} = createSession({provider});
  session.start();
  sockets[0].open();
  sockets[0].message(JSON.stringify(event(99, 102)));
  assert.equal(session.getView().transportState, "syncing");

  timers.advance(500);
  await flush();
  assert.equal(session.getView().transportState, "reconnecting");
  assert.equal(session.getView().lastError, "snapshot-timeout");
  assert.equal(timers.nextDelay(), 100);

  pending.resolve({ok: true, data: snapshot(100)});
  await flush();
  assert.equal(session.getView().transportState, "reconnecting");
  assert.notEqual(session.getView().status, "ready");
  timers.advance(100);
  assert.equal(sockets.length, 2);
});

test("idle stream reconnects, and stop cancels the pending reconnect", async () => {
  const provider = providerStub(async () => ({ok: true, data: snapshot(100)}));
  const {session, timers, sockets} = createSession({provider, options: {idleTimeoutMs: 1000}});
  session.start();
  sockets[0].open();
  sockets[0].message(JSON.stringify(event(90, 100)));
  await flush();
  assert.equal(session.getView().transportState, "syncing");

  timers.advance(1000);
  assert.equal(session.getView().transportState, "reconnecting");
  assert.equal(session.getView().lastError, "stream-idle");
  assert.equal(sockets[0].closed, true);
  session.stop();
  timers.advance(10000);
  assert.equal(sockets.length, 1);
  assert.equal(session.getView().transportState, "stopped");
});

test("oversized and malformed WebSocket messages fail closed", () => {
  const provider = providerStub(async () => ({ok: true, data: snapshot(100)}));
  const {session: oversized, sockets: oversizedSockets} = createSession({
    provider,
    options: {maxMessageBytes: 256}
  });
  oversized.start();
  oversizedSockets[0].open();
  oversizedSockets[0].message("x".repeat(257));
  assert.equal(oversized.getView().transportState, "reconnecting");
  assert.equal(oversized.getView().lastError, "message-too-large");

  const {session: malformed, sockets: malformedSockets} = createSession({provider});
  malformed.start();
  malformedSockets[0].open();
  malformedSockets[0].message("{not-json");
  assert.equal(malformed.getView().transportState, "reconnecting");
  assert.equal(malformed.getView().lastError, "invalid-message");
});

test("pre-snapshot event buffer overflow invalidates and reconnects without applying a partial book", async () => {
  const pending = deferred();
  const provider = providerStub(() => pending.promise);
  const {session, sockets} = createSession({provider, options: {maxBufferedEvents: 1}});
  session.start();
  sockets[0].open();
  sockets[0].message(JSON.stringify(event(90, 100)));
  await flush();
  sockets[0].message(JSON.stringify(event(101, 101)));
  assert.equal(session.getView().transportState, "reconnecting");
  assert.equal(session.getView().lastError, "depth-buffer-overflow");
  assert.equal(sockets[0].closed, true);

  pending.resolve({ok: true, data: snapshot(100)});
  await flush();
  assert.notEqual(session.getView().status, "ready");
  session.stop();
});

test("socket error and close share one reconnect attempt", () => {
  const provider = providerStub(async () => ({ok: true, data: snapshot(100)}));
  const {session, timers, sockets} = createSession({provider});
  session.start();
  sockets[0].open();
  sockets[0].emit("error");
  assert.equal(session.getView().transportState, "reconnecting");
  assert.equal(session.getView().lastError, "stream-error");
  assert.equal(session.reconnectAttempt, 1);
  assert.equal(timers.nextDelay(), 100);

  sockets[0].serverClose();
  assert.equal(session.reconnectAttempt, 1);
  assert.equal(timers.nextDelay(), 100);
  session.stop();
});

test("repeated snapshot failures use bounded exponential backoff and one reconnect timer", async () => {
  const provider = providerStub(async () => ({ok: false, reason: "unavailable"}));
  const {session, timers, sockets} = createSession({provider});
  session.start();

  for (const expectedDelay of [100, 200, 400, 400]) {
    const socket = sockets[sockets.length - 1];
    socket.open();
    socket.message(JSON.stringify(event(99, 102)));
    await flush();
    assert.equal(session.getView().transportState, "reconnecting");
    assert.equal(timers.nextDelay(), expectedDelay);
    assert.equal(session.reconnectAttempt >= 1, true);
    timers.advance(expectedDelay);
  }
  assert.equal(sockets.length, 5);
  session.stop();
});

test("crypto provider exposes an inert depth-session factory without adding network work", () => {
  const provider = createCryptoProvider({
    fetchImpl: async () => ({ok: true, json: async () => snapshot(100)}),
    now: () => 1000,
    http: {retries: 0}
  });
  const session = provider.createDepthStream("BTCUSDT", {WebSocketImpl: FakeSocket});
  assert.ok(session instanceof BinanceSpotDepthStream);
  assert.equal(session.getView().transportState, "idle");
  assert.throws(() => provider.createDepthStream("BTC/USDT", {WebSocketImpl: FakeSocket}), /symbol/);
});
