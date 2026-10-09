import test from "node:test";
import assert from "node:assert/strict";
import {existsSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createPaperExecution} from "../src/execution/paper.js";
import {appendJournalEntry} from "../src/journal/journal.js";
import {applyFill} from "../server/orders.js";
import {buildPortfolioState} from "../src/risk/portfolio.js";
import {DurableStore} from "../src/persistence/store.js";
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

function asyncStore({healthy = true} = {}) {
  const durable = new DurableStore();
  return {
    health: async () => healthy,
    get: async (...args) => durable.get(...args),
    put: async (...args) => durable.put(...args),
    list: async (namespace) => [...durable.state.entries()]
      .filter(([key]) => key.startsWith(`${namespace}:`))
      .map(([, value]) => value),
    transactIdempotent: (key, operation) => durable.transactIdempotent(key, (tx) => operation({
      get: async (...args) => tx.get(...args),
      put: async (...args) => tx.put(...args)
    }))
  };
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

test("unsupported non-market paper order types fail closed without creating fills", async () => {
  await withServer(async ({srv}) => {
    for (const type of ["LIMIT", "STOP_LOSS", "TAKE_PROFIT"]) {
      const result = await post(srv.base, {...validOrder("unsupported-" + type), type});
      assert.equal(result.status, 400, type);
      assert.equal(result.body.error.code, "unsupported-order-type", type);
    }

    const history = await fetch(srv.base + "/api/orders").then((res) => res.json());
    assert.equal(history.data.total, 0);
    assert.deepEqual(history.data.fills, []);
  });
});

test("market paper orders reject unused stop/take-profit trigger fields", async () => {
  await withServer(async ({srv}) => {
    for (const extra of [{stopPrice: 41000}, {takeProfitPrice: 43000}]) {
      const result = await post(srv.base, {...validOrder("unused-trigger-" + Object.keys(extra)[0]), ...extra});
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, "unsupported-order-trigger");
    }

    const history = await fetch(srv.base + "/api/orders").then((res) => res.json());
    assert.equal(history.data.total, 0);
    assert.deepEqual(history.data.fills, []);
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

    const priceChange = await post(srv.base, {...order, price: order.price + 1});
    assert.equal(priceChange.status, 200);
    assert.equal(priceChange.body.data.state, "replayed");
    assert.equal(priceChange.body.data.fill.orderId, first.body.data.fill.orderId);

    const conflict = await post(srv.base, {...order, quantity: order.quantity + 0.01});
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

test("async database store persists orders across service restart without local-file fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trading-nova-db-orders-"));
  const stateFile = join(dir, "paper-state.json");
  const executionStateFile = join(dir, "paper-orders.json");
  const store = asyncStore();
  let srv = await startTestServer({fetchImpl: tickerFetch(), stateFile, executionStateFile, store});
  try {
    const order = validOrder("database-restart-key");
    const first = await post(srv.base, order);
    assert.equal(first.status, 200);
    assert.equal(existsSync(executionStateFile), false);

    await srv.close();
    srv = await startTestServer({fetchImpl: tickerFetch(), stateFile, executionStateFile, store});
    const replay = await post(srv.base, order);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.state, "replayed");

    const portfolio = await fetch(srv.base + "/api/portfolio").then((r) => r.json());
    assert.equal(portfolio.data.portfolio.positions[0].quantity, 0.01);
  } finally {
    await srv.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test("order history supports bounded pages with stable totals and rejects invalid pagination", async () => {
  await withServer(async ({srv}) => {
    for (const key of ["page-order-a", "page-order-b", "page-order-c"]) {
      const res = await post(srv.base, validOrder(key));
      assert.equal(res.status, 200);
    }
    const first = await fetch(srv.base + "/api/orders?limit=2&offset=0").then((r) => r.json());
    assert.equal(first.ok, true);
    assert.equal(first.data.fills.length, 2);
    assert.equal(first.data.total, 3);
    assert.equal(first.data.limit, 2);
    assert.equal(first.data.offset, 0);
    assert.equal(first.data.hasMore, true);

    const second = await fetch(srv.base + "/api/orders?limit=2&offset=2").then((r) => r.json());
    assert.equal(second.data.fills.length, 1);
    assert.equal(second.data.total, 3);
    assert.equal(second.data.hasMore, false);

    const invalid = await fetch(srv.base + "/api/orders?limit=201");
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "invalid-order-page");
  });
});

test("unhealthy configured database fails closed instead of using local persistence", async () => {
  await withServer(async ({srv, executionStateFile}) => {
    const result = await post(srv.base, validOrder("database-down-key"));
    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, "paper-order-state-unavailable");
    assert.equal(existsSync(executionStateFile), false);
  }, {store: asyncStore({healthy: false})});
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

test("non-paper mode cannot start the web server", async () => {
  await assert.rejects(
    () => startTestServer({fetchImpl: tickerFetch(), tradingMode: "live"}),
    /paper-only; non-paper modes are blocked/
  );
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

test("paper fills at the live market last, not a client-chosen underpriced notional", async () => {
  await withServer(async ({srv}) => {
    const res = await post(srv.base, {...validOrder("client-underprice"), price: 1});
    assert.equal(res.status, 200);
    assert.equal(res.body.data.fill.price, 42000.5);
    assert.equal(res.body.data.order.price, 42000.5);
    assert.equal(res.body.data.verdict.orderNotional, 0.01 * 42000.5);
    const portfolio = await fetch(srv.base + "/api/portfolio").then((r) => r.json());
    assert.equal(portfolio.data.portfolio.positions[0].quantity, 0.01);
    assert.ok(portfolio.data.portfolio.cash < 10000);
  });
});

test("a buy that would spend more cash than the account has is refused", async () => {
  await withServer(async ({srv}) => {
    const res = await post(srv.base, {...validOrder("no-cash"), quantity: 0.3, price: 42000.5});
    assert.equal(res.status, 400);
    assert.equal(res.body.verdict.decision, "NO_TRADE");
    assert.ok(res.body.verdict.reasons.includes("INSUFFICIENT_CASH"));
    const portfolio = await fetch(srv.base + "/api/portfolio").then((r) => r.json());
    assert.deepEqual(portfolio.data.portfolio.positions, []);
  });
});

test("applyFill flattens a closed position even when quantity is float dust", () => {
  const opened = applyFill(
    buildPortfolioState({cash: 10000, startingEquity: 10000, positions: []}),
    {symbol: "BTCUSDT", side: "BUY", quantity: 0.1, price: 100}
  );
  const closed = applyFill(opened, {symbol: "BTCUSDT", side: "SELL", quantity: 0.1, price: 100});
  assert.deepEqual(closed.positions, []);
});
