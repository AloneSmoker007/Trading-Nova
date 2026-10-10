import test from "node:test";
import assert from "node:assert/strict";
import {existsSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createPaperExecution} from "../src/execution/paper.js";
import {appendJournalEntry} from "../src/journal/journal.js";
import {applyFill, createPaperOrderService} from "../server/orders.js";
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

test("unsupported paper order types and unused triggers fail closed without creating fills", async () => {
  // A fake durable store keeps this validation regression deterministic and
  // records every mutation; rejected orders must return before any store write.
  const writes = [];
  let marketCalls = 0;
  const store = {
    health: async () => true,
    list: async () => [],
    get: async () => null,
    put: async (...args) => { writes.push(["put", ...args]); },
    transactIdempotent: async (...args) => { writes.push(["transactIdempotent", ...args]); }
  };
  const service = createPaperOrderService({
    market: {getTicker: async () => {
      marketCalls++;
      return {state: "ok", ageMs: 0, data: {last: 42000.5}};
    }},
    stateFile: "unused-paper-state.json",
    executionStateFile: "unused-paper-orders.json",
    store
  });

  for (const type of ["LIMIT", "STOP_LOSS", "TAKE_PROFIT"]) {
    const result = await service.submit({...validOrder("unsupported-" + type), type});
    assert.equal(result.status, 400, type);
    assert.equal(result.body.error.code, "unsupported-order-type", type);
  }
  for (const extra of [{stopPrice: 41000}, {takeProfitPrice: 43000}]) {
    const result = await service.submit({...validOrder("unused-trigger-" + Object.keys(extra)[0]), ...extra});
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "unsupported-order-trigger");
  }
  assert.deepEqual(writes, [], "rejected orders must never write a fill or portfolio");
  assert.equal(marketCalls, 0, "unsupported orders must be rejected before market-data I/O");
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
    assert.equal(replay.body.data.fill.fee, first.body.data.fill.fee);
    assert.equal(replay.body.data.fill.price, first.body.data.fill.price);
    assert.equal(replay.body.data.fill.quoteBid, first.body.data.fill.quoteBid);
    assert.equal(replay.body.data.fill.quoteAsk, first.body.data.fill.quoteAsk);

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

test("paper fills cross the ask, apply slippage and fees, and mark at the reference last", async () => {
  await withServer(async ({srv}) => {
    const res = await post(srv.base, {...validOrder("client-underprice"), price: 1});
    assert.equal(res.status, 200);
    const data = res.body.data;
    const expectedPrice = 42001 * (1 + 5 / 10000);
    const expectedFee = 0.01 * expectedPrice * 0.001;
    assert.ok(Math.abs(data.fill.price - expectedPrice) < 1e-8);
    assert.ok(Math.abs(data.order.price - expectedPrice) < 1e-8);
    assert.equal(data.fill.markPrice, 42000.5);
    assert.equal(data.fill.referencePrice, 42000.5);
    assert.ok(Math.abs(data.verdict.orderNotional - 0.01 * expectedPrice) < 1e-8);
    assert.ok(Math.abs(data.fill.fee - expectedFee) < 1e-9);
    assert.equal(data.fill.feeRate, 0.001);
    assert.equal(data.fill.quoteBid, 42000);
    assert.equal(data.fill.quoteAsk, 42001);
    assert.equal(data.fill.slippageBps, 5);
    assert.ok(data.fill.spreadBps > 0);
    assert.ok(data.executionCosts.fee > 0);
    assert.ok(Math.abs(data.executionCosts.referencePrice - 42000.5) < 1e-8);
    const portfolio = await fetch(srv.base + "/api/portfolio").then((r) => r.json());
    assert.equal(portfolio.data.portfolio.positions[0].quantity, 0.01);
    assert.equal(portfolio.data.portfolio.positions[0].markPrice, 42000.5);
    assert.ok(Math.abs(portfolio.data.portfolio.cash - (10000 - expectedPrice * 0.01 - expectedFee)) < 1e-8);
    assert.ok(portfolio.data.portfolio.equity < 10000, "spread, slippage and fees must reduce marked equity");
  });
});

test("paper round trip charges both sides and retains spread/slippage costs in cash", async () => {
  await withServer(async ({srv}) => {
    const buy = await post(srv.base, {...validOrder("cost-roundtrip-buy"), price: 1});
    assert.equal(buy.status, 200);
    const sell = await post(srv.base, {
      ...validOrder("cost-roundtrip-sell"),
      side: "SELL",
      quantity: 0.01,
      price: 999999
    });
    assert.equal(sell.status, 200);
    assert.ok(buy.body.data.fill.price > buy.body.data.fill.referencePrice);
    assert.ok(sell.body.data.fill.price < sell.body.data.fill.referencePrice);
    assert.ok(buy.body.data.fill.fee > 0);
    assert.ok(sell.body.data.fill.fee > 0);

    const portfolio = await fetch(srv.base + "/api/portfolio").then((r) => r.json());
    assert.deepEqual(portfolio.data.portfolio.positions, []);
    assert.ok(portfolio.data.portfolio.cash < 10000, "round trip must reflect spread, slippage and both fees");
    const expectedBuy = 42001 * (1 + 5 / 10000);
    const expectedSell = 42000 * (1 - 5 / 10000);
    const totalFees = 0.01 * expectedBuy * 0.001 + 0.01 * expectedSell * 0.001;
    const expectedCash = 10000 - 0.01 * expectedBuy + 0.01 * expectedSell - totalFees;
    assert.ok(Math.abs(portfolio.data.portfolio.cash - expectedCash) < 1e-7);
  });
});

test("paper buy is refused when fees make an otherwise affordable fill exceed cash", async () => {
  await withServer(async ({srv}) => {
    const executionPrice = 42001 * (1 + 5 / 10000);
    const quantity = 10000 / (executionPrice * 1.0005);
    const grossNotional = quantity * executionPrice;
    const estimatedFee = grossNotional * 0.001;
    assert.ok(grossNotional < 10000);
    assert.ok(grossNotional + estimatedFee > 10000);

    const res = await post(srv.base, {...validOrder("fee-aware-cash"), quantity});
    assert.equal(res.status, 400);
    assert.equal(res.body.verdict.decision, "NO_TRADE");
    assert.ok(res.body.verdict.reasons.includes("INSUFFICIENT_CASH"));
    const portfolio = await fetch(srv.base + "/api/portfolio").then((r) => r.json());
    assert.deepEqual(portfolio.data.portfolio.positions, []);
  });
});

test("paper order fails closed when the mark is fresh but its executable quote is missing", async () => {
  const mutations = [];
  const store = {
    health: async () => true,
    list: async () => [],
    get: async () => null,
    put: async (namespace, key, value) => { mutations.push({kind: "put", namespace, key, value}); },
    transactIdempotent: async (key, operation) => {
      mutations.push({kind: "transact", key});
      return operation({get: async () => null, put: async (namespace, itemKey, value) => {
        mutations.push({kind: "tx.put", namespace, key: itemKey, value});
      }});
    }
  };
  const service = createPaperOrderService({
    market: {getTicker: async () => ({state: "ok", ageMs: 0, data: {last: 42000.5}})},
    stateFile: "unused-state.json",
    executionStateFile: "unused-orders.json",
    store
  });
  const result = await service.submit(validOrder("missing-book-quote"));
  assert.equal(result.status, 503);
  assert.equal(result.body.state, "unavailable");
  assert.equal(result.body.error.code, "execution-quote-unavailable");
  assert.ok(!mutations.some(m => m.namespace === "paper-fills"), "a missing executable quote must never persist a fill");
  assert.ok(!mutations.some(m => m.kind === "transact"), "a missing executable quote must not enter the fill transaction");
});

test("configured paper fee and slippage settings change the simulated fill", async () => {
  await withServer(async ({srv}) => {
    const res = await post(srv.base, {...validOrder("configured-costs"), price: 1});
    assert.equal(res.status, 200);
    const fill = res.body.data.fill;
    const expectedPrice = 42001 * (1 + 10 / 10000);
    const expectedFee = 0.01 * expectedPrice * 0.002;
    assert.ok(Math.abs(fill.price - expectedPrice) < 1e-8);
    assert.ok(Math.abs(fill.fee - expectedFee) < 1e-9);
    assert.equal(fill.feeRate, 0.002);
    assert.equal(fill.slippageBps, 10);
  }, {paperFeeRate: 0.002, paperSlippageBps: 10});
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
