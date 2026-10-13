// tests/terminal-v2.test.js — integration tests for upgraded paper trading terminal API.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNovaServer } from "../server/app.js";

function mockFetch(url) {
  const target = String(url);
  if (target.includes("/ticker/24hr") || target.includes("/api/v3/ticker")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        symbol: "BTCUSDT",
        lastPrice: "50000.00",
        bidPrice: "49990.00",
        askPrice: "50010.00",
        highPrice: "51000.00",
        lowPrice: "48000.00",
        volume: "100.5",
        quoteVolume: "5025000.00",
        priceChangePercent: "2.50"
      })
    });
  }
  if (target.includes("/klines") || target.includes("candles")) {
    const candles = [];
    const now = Date.now();
    for (let i = 100; i >= 0; i--) {
      const close = 50000 + (100 - i) * 10;
      candles.push([
        now - i * 3600000,
        String(close - 5),
        String(close + 15),
        String(close - 15),
        String(close),
        "10.0"
      ]);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(candles)
    });
  }
  return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
}

test("GET /api/markets returns watchlist market summaries", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "nova-test-"));
  const stateFile = join(tmp, "paper-state.json");
  const executionStateFile = join(tmp, "paper-orders.json");

  try {
    const server = createNovaServer({ fetchImpl: mockFetch, stateFile, executionStateFile });
    const port = 7820;
    await new Promise((res) => server.listen(port, "127.0.0.1", res));

    const res = await fetch(`http://127.0.0.1:${port}/api/markets`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.data.markets));
    assert.ok(body.data.count > 0);

    server.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("GET /api/ai/council/:symbol returns 7-role AI research analysis", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "nova-test-"));
  const stateFile = join(tmp, "paper-state.json");
  const executionStateFile = join(tmp, "paper-orders.json");

  try {
    const server = createNovaServer({ fetchImpl: mockFetch, stateFile, executionStateFile });
    const port = 7821;
    await new Promise((res) => server.listen(port, "127.0.0.1", res));

    const res = await fetch(`http://127.0.0.1:${port}/api/ai/council/BTCUSDT`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    const council = body.data.council;
    assert.ok(Number.isFinite(council.opportunityScore));
    assert.ok(["WAIT", "RESEARCH", "RESEARCH_READY", "NO_TRADE"].includes(council.decision));
    assert.equal(council.roles.length, 7);

    const liquidity = council.roles.find((role) => role.legacyRole === "Fundamental");
    const momentum = council.roles.find((role) => role.legacyRole === "News");
    const volatility = council.roles.find((role) => role.legacyRole === "Sentiment");
    assert.equal(liquidity.role, "Liquidity proxy");
    assert.equal(liquidity.displayName, "Liquidity proxy");
    assert.match(liquidity.basis, /24-hour quote volume only/i);
    assert.match(liquidity.basis, /no company financial statements/i);
    assert.equal(momentum.role, "24h momentum proxy");
    assert.match(momentum.basis, /24-hour price change only/i);
    assert.match(momentum.basis, /no public-news feed/i);
    assert.equal(volatility.role, "Volatility-regime proxy");
    assert.match(volatility.basis, /candle-volatility regime only/i);
    assert.match(volatility.basis, /no social, survey, or news-sentiment feed/i);
    assert.equal(council.dataCoverage.companyFundamentals, "not-connected");
    assert.equal(council.dataCoverage.publicNews, "not-connected");
    assert.equal(council.dataCoverage.socialSentiment, "not-connected");
    assert.match(council.dataCoverage.note, /feeds are not connected/i);

    server.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("GET /api/risk/status returns active risk limits and kill switch state", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "nova-test-"));
  const stateFile = join(tmp, "paper-state.json");
  const executionStateFile = join(tmp, "paper-orders.json");

  try {
    const server = createNovaServer({ fetchImpl: mockFetch, stateFile, executionStateFile });
    const port = 7822;
    await new Promise((res) => server.listen(port, "127.0.0.1", res));

    const res = await fetch(`http://127.0.0.1:${port}/api/risk/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.data.riskConfig);
    assert.equal(body.data.killSwitchActive, false);

    server.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("GET /api/strategy/lab returns strategy comparison results", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "nova-test-"));
  const stateFile = join(tmp, "paper-state.json");
  const executionStateFile = join(tmp, "paper-orders.json");

  try {
    const server = createNovaServer({ fetchImpl: mockFetch, stateFile, executionStateFile });
    const port = 7823;
    await new Promise((res) => server.listen(port, "127.0.0.1", res));

    const res = await fetch(`http://127.0.0.1:${port}/api/strategy/lab?symbol=BTCUSDT&interval=1h&limit=100`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.data.strategies));
    assert.ok(body.data.strategies.length >= 2);

    server.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("POST /api/journal/entry appends a new entry with sha256 hash chain verification", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "nova-test-"));
  const stateFile = join(tmp, "paper-state.json");
  const executionStateFile = join(tmp, "paper-orders.json");

  try {
    const server = createNovaServer({ fetchImpl: mockFetch, stateFile, executionStateFile });
    const port = 7824;
    await new Promise((res) => server.listen(port, "127.0.0.1", res));

    const res = await fetch(`http://127.0.0.1:${port}/api/journal/entry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Test Breakout Thesis",
        text: "Testing BTCUSDT breakout setup with 1% risk allocation.",
        type: "thesis",
        symbol: "BTCUSDT"
      })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.data.record);
    assert.ok(body.data.record.hash);

    const journalRes = await fetch(`http://127.0.0.1:${port}/api/journal`);
    const journalBody = await journalRes.json();
    assert.equal(journalBody.data.integrity, "verified");

    server.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("POST /api/paper/orders rejects LIMIT until pending-order lifecycle is implemented", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "nova-test-"));
  const stateFile = join(tmp, "paper-state.json");
  const executionStateFile = join(tmp, "paper-orders.json");
  let server;

  try {
    server = createNovaServer({ fetchImpl: mockFetch, stateFile, executionStateFile });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const {port} = server.address();

    const res = await fetch(`http://127.0.0.1:${port}/api/paper/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "BTCUSDT",
        side: "BUY",
        type: "LIMIT",
        quantity: 0.01,
        price: 50000,
        idempotencyKey: "test-limit-order-1"
      })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "unsupported-order-type");

    const ordersRes = await fetch(`http://127.0.0.1:${port}/api/orders`);
    const ordersBody = await ordersRes.json();
    assert.equal(ordersBody.data.total, 0);
    assert.equal(existsSync(executionStateFile), false, "rejected LIMIT orders must not persist a fill");
  } finally {
    if (server?.listening) {
      const closing = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections?.();
      await closing;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});
