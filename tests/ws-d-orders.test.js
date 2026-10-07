import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createPaperExecution} from "../src/execution/paper.js";
import {appendJournalEntry} from "../src/journal/journal.js";
import {fakeFetch, jsonResponse, startTestServer, ticker24hPayload} from "./ws-d-helpers.js";

const validOrder = (key = "paper-order-test") => ({
  symbol: "BTCUSDT",
  side: "BUY",
  quantity: 0.01,
  price: 42000.5,
  idempotencyKey: key
});

function tickerFetch() {
  return fakeFetch([["/ticker/24hr", jsonResponse(200, ticker24hPayload())]]);
}

async function withServer(fn, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trading-nova-orders-"));
  const stateFile = join(dir, "paper-state.json");
  const executionStateFile = join(dir, "paper-orders.json");
  const srv = await startTestServer({
    fetchImpl: tickerFetch(),
    stateFile,
    executionStateFile,
    ...options
  });
  try {
    await fn({srv, dir, stateFile, executionStateFile});
  } finally {
    await srv.close();
    rmSync(dir, {recursive: true, force: true});
  }
}

async function post(base, body, raw = false) {
  const response = await fetch(base + "/api/paper/orders", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: raw ? body : JSON.stringify(body)
  });
  return {status: response.status, body: await response.json()};
}

test("valid paper order requires ALLOW and persists a reconciled fill", async () => {
  await withServer(async ({srv}) => {
    const res = await post(srv.base, validOrder());
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.verdict.decision, "ALLOW");
    assert.equal(res.body.data.fill.status, "RECONCILED");
    assert.equal(res.body.data.fill.tier, "paper");
    assert.equal(res.body.data.reconciliation.state, "reconciled");
    assert.match(res.body.data.note, /No real-money order was placed/);
  });
});

test("Risk Gate NO_TRADE returns reasons and does not create a fill", async () => {
  await withServer(async ({srv}) => {
    const res = await post(srv.base, {...validOrder("too-large"), quantity: 0.2});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "risk-gate-rejected");
    assert.equal(res.body.verdict.decision, "NO_TRADE");
    assert.ok(res.body.verdict.reasons.includes("MAX_POSITION"));
    const portfolio = await fetch(srv.base + "/api/portfolio").then((r) => r.json());
    assert.equal(portfolio.data.state, "ok");
    assert.deepEqual(portfolio.data.portfolio.positions, []);
  });
});

test("missing idempotency key is rejected", async () => {
  await withServer(async ({srv}) => {
    const {idempotencyKey, ...order} = validOrder();
    const res = await post(srv.base, order);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "missing-idempotency-key");
  });
});

test("invalid symbol and side are rejected", async () => {
  await withServer(async ({srv}) => {
    const symbol = await post(srv.base, {...validOrder("bad-symbol"), symbol: "BTC/USDT"});
    assert.equal(symbol.status, 400);
    assert.equal(symbol.body.error.code, "invalid-symbol");

    const side = await post(srv.base, {...validOrder("bad-side"), side: "HOLD"});
    assert.equal(side.status, 400);
    assert.equal(side.body.error.code, "invalid-side");
  });
});

test("invalid quantity and price are rejected", async () => {
  await withServer(async ({srv}) => {
    const quantity = await post(srv.base, {...validOrder("bad-quantity"), quantity: 0});
    assert.equal(quantity.status, 400);
    assert.equal(quantity.body.error.code, "invalid-quantity");

    const price = await post(srv.base, {...validOrder("bad-price"), price: Infinity});
    assert.equal(price.status, 400);
    assert.equal(price.body.error.code, "invalid-price");
  });
});

test("duplicate idempotency key replays the same fill and rejects changed intent", async () => {
  await withServer(async ({srv}) => {
    const order = validOrder("duplicate-key");
    const first = await post(srv.base, order);
    const replay = await post(srv.base, order);
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.state, "replayed");
    assert.equal(replay.body.data.fill.orderId, first.body.data.fill.orderId);

    const conflict = await post(srv.base, {...order, price: order.price + 1});
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "idempotency-key-reused");
  });
});

test("paper fills survive restart and update the portfolio", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trading-nova-restart-"));
  const stateFile = join(dir, "paper-state.json");
  const executionStateFile = join(dir, "paper-orders.json");
  let srv = await startTestServer({fetchImpl: tickerFetch(), stateFile, executionStateFile});
  try {
    const order = validOrder("restart-key");
    const first = await post(srv.base, order);
    await srv.close();
    srv = await startTestServer({fetchImpl: tickerFetch(), stateFile, executionStateFile});

    const replay = await post(srv.base, order);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.state, "replayed");
    assert.equal(replay.body.data.fill.orderId, first.body.data.fill.orderId);

    const portfolio = await fetch(srv.base + "/api/portfolio").then((r) => r.json());
    assert.equal(portfolio.data.state, "ok");
    assert.equal(portfolio.data.portfolio.positions[0].quantity, 0.01);
  } finally {
    await srv.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test("cumulative exposure is gated across distinct orders", async () => {
  await withServer(async ({srv}) => {
    const results = await Promise.all([
      post(srv.base, {...validOrder("exposure-1"), quantity: 0.05}),
      post(srv.base, {...validOrder("exposure-2"), quantity: 0.05}),
      post(srv.base, {...validOrder("exposure-3"), quantity: 0.05})
    ]);
    const [first, second, third] = results;
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 400);
    assert.equal(third.body.verdict.decision, "NO_TRADE");
    assert.ok(third.body.verdict.reasons.includes("MAX_POSITION"));
  });
});

test("unavailable market data fails closed with NO_TRADE", async () => {
  await withServer(async ({srv}) => {
    const res = await post(srv.base, validOrder("stale-market"));
    assert.equal(res.status, 400);
    assert.equal(res.body.verdict.decision, "NO_TRADE");
    assert.ok(res.body.verdict.reasons.includes("STALE_CRITICAL_DATA"));
  }, {fetchImpl: async () => jsonResponse(503, {})});
});

test("persisted risk breach and broken journal stop order submission", async () => {
  await withServer(async ({srv, stateFile}) => {
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      portfolio: {cash: 10000, startingEquity: 10000, positions: []},
      limits: {
        daily: {realizedPnl: -500, startingEquity: 10000, dailyLossLimitPct: 2},
        weekly: {realizedPnl: -500, startingEquity: 10000, weeklyLossLimitPct: 5},
        drawdown: {peakEquity: 11000, currentEquity: 11000, maxDrawdownPct: 10}
      }
    }));
    const res = await post(srv.base, validOrder("blocked-limits"));
    assert.equal(res.status, 400);
    assert.ok(res.body.verdict.reasons.includes("EMERGENCY_KILL_SWITCH"));
  });

  await withServer(async ({srv, stateFile}) => {
    const journal = [];
    appendJournalEntry(journal, {kind: "paper-order", mode: "paper"});
    journal[0] = {...journal[0], entry: {...journal[0].entry, mode: "live"}};
    writeFileSync(stateFile, JSON.stringify({version: 1, journal}));
    const res = await post(srv.base, validOrder("blocked-journal"));
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, "paper-journal-integrity-broken");
  });
});

test("client-supplied gate artifacts are rejected and engine refuses missing artifacts", async () => {
  await withServer(async ({srv}) => {
    const res = await post(srv.base, {...validOrder("forged-gate"), gateArtifact: {decision: "ALLOW"}});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "unexpected-field");
  });
  const engine = createPaperExecution();
  assert.throws(() => engine.submit({
    symbol: "BTCUSDT", side: "BUY", quantity: 0.01, price: 42000, idempotencyKey: "no-artifact"
  }), /risk gate artifact required/);
});

test("non-paper mode cannot submit orders", async () => {
  await withServer(async ({srv}) => {
    const res = await post(srv.base, validOrder("non-paper"));
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "trading-mode-not-paper");
  }, {tradingMode: "live"});
});

test("malformed JSON is rejected before reaching execution", async () => {
  await withServer(async ({srv}) => {
    const res = await post(srv.base, "{", true);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "invalid-json");
  });
});

test("state errors return 500 without authorizing an order", async () => {
  await withServer(async ({srv, stateFile}) => {
    writeFileSync(stateFile, "{not json");
    const order = validOrder("state-error-key");
    const failed = await post(srv.base, order);
    assert.equal(failed.status, 500);
    assert.equal(failed.body.error.code, "paper-state-error");

    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      portfolio: {cash: 10000, startingEquity: 10000, positions: []}
    }));
    const retry = await post(srv.base, order);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.data.state, "ok");
  });
});

test("oversized request bodies are rejected without parsing or execution", async () => {
  await withServer(async ({srv}) => {
    const res = await post(srv.base, " ".repeat(16 * 1024 + 1), true);
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, "body-too-large");
  });
});
