import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {derivePaperOutcomes} from "../src/journal/outcomes.js";
import {DurableStore} from "../src/persistence/store.js";
import {startTestServer, fakeFetch, jsonResponse, ticker24hPayload} from "./ws-d-helpers.js";

const thesis = (hash = "a".repeat(64), title = "Verified thesis") => ({
  hash, index: 0, timestamp: 1, symbol: "BTCUSDT", title
});

const fill = ({id, side, quantity, price, fee, timestamp, thesisRef}) => ({
  orderId: id,
  idempotencyKey: id,
  status: "RECONCILED",
  symbol: "BTCUSDT",
  side,
  quantity,
  price,
  fee,
  timestamp,
  ...(thesisRef ? {thesisRef} : {})
});

test("FIFO outcomes derive fee-adjusted long and short realized paper PnL", () => {
  const long = derivePaperOutcomes([
    fill({id: "long-open", side: "BUY", quantity: 2, price: 100, fee: 2, timestamp: 1, thesisRef: thesis()}),
    fill({id: "long-close", side: "SELL", quantity: 1, price: 120, fee: 1, timestamp: 2})
  ]);
  assert.equal(long.outcomes.length, 1);
  assert.deepEqual({...long.outcomes[0], outcomeId: "stable"}, {
    outcomeId: "stable",
    status: "REALIZED",
    source: "paper-fill-fifo-v1",
    symbol: "BTCUSDT",
    direction: "LONG",
    quantity: 1,
    openedAt: 1,
    closedAt: 2,
    openingOrderId: "long-open",
    closingOrderId: "long-close",
    openPrice: 100,
    closePrice: 120,
    grossPnl: 20,
    fees: 2,
    netPnl: 18,
    result: "WIN",
    thesisRef: thesis()
  });
  assert.equal(long.summary.openLotCount, 1, "the unclosed half must remain open, not become an outcome");

  const short = derivePaperOutcomes([
    fill({id: "short-open", side: "SELL", quantity: 1, price: 100, fee: 1, timestamp: 1, thesisRef: thesis("b".repeat(64))}),
    fill({id: "short-close", side: "BUY", quantity: 0.5, price: 80, fee: 0.5, timestamp: 2})
  ]);
  assert.equal(short.outcomes[0].direction, "SHORT");
  assert.equal(short.outcomes[0].grossPnl, 10);
  assert.equal(short.outcomes[0].fees, 1);
  assert.equal(short.outcomes[0].netPnl, 9);
  assert.equal(short.summary.openLotCount, 1);
});

test("FIFO matching attributes each partial close to its actual opening thesis", () => {
  const first = thesis("c".repeat(64), "First lot");
  const second = thesis("d".repeat(64), "Second lot");
  const fills = [
    fill({id: "close", side: "SELL", quantity: 1.5, price: 130, fee: 1.5, timestamp: 3}),
    fill({id: "second", side: "BUY", quantity: 1, price: 120, fee: 1, timestamp: 2, thesisRef: second}),
    fill({id: "first", side: "BUY", quantity: 1, price: 100, fee: 1, timestamp: 1, thesisRef: first})
  ];
  const report = derivePaperOutcomes(fills);
  assert.equal(report.outcomes.length, 2);
  assert.deepEqual(report.outcomes.map((item) => item.thesisRef.hash), [first.hash, second.hash]);
  assert.deepEqual(report.outcomes.map((item) => item.quantity), [1, 0.5]);
  assert.deepEqual(report.outcomes.map((item) => item.netPnl), [28, 4]);
  assert.equal(report.summary.realizedNetPnl, 32);
  assert.equal(report.summary.linkedOutcomeCount, 2);
  assert.equal(report.summary.unlinkedOutcomeCount, 0);
  assert.equal(report.summary.openLotCount, 1);

  const replay = derivePaperOutcomes([...fills]);
  assert.deepEqual(replay, report, "the same fill facts must produce a byte-stable report");
});

test("outcome derivation fails closed on malformed, duplicate or excessive fill history", () => {
  const valid = fill({id: "one", side: "BUY", quantity: 1, price: 100, fee: 1, timestamp: 1});
  assert.throws(() => derivePaperOutcomes([{...valid, fee: -1}]), /invalid paper fill/i);
  assert.throws(() => derivePaperOutcomes([valid, {...valid}]), /duplicate paper fill/i);
  assert.throws(() => derivePaperOutcomes([valid], {maxFills: 0}), /invalid outcome history limit/i);
  assert.throws(() => derivePaperOutcomes([valid, {...valid, orderId: "two", idempotencyKey: "two"}], {maxFills: 1}), /history exceeds/i);
});

function tickerFetchAt(last, bid, ask) {
  return fakeFetch([["/ticker/24hr", jsonResponse(200, {
    ...ticker24hPayload(), lastPrice: String(last), bidPrice: String(bid), askPrice: String(ask)
  })]]);
}

async function post(base, path, body) {
  const response = await fetch(base + path, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
  return {status: response.status, body: await response.json()};
}

test("HTTP learning report links an actual closed paper fill to its verified thesis", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trading-nova-outcomes-"));
  const stateFile = join(dir, "paper-state.json");
  const executionStateFile = join(dir, "paper-orders.json");
  let srv = await startTestServer({fetchImpl: tickerFetchAt(42000, 41999, 42001), stateFile, executionStateFile});
  try {
    const journal = await post(srv.base, "/api/journal/entry", {
      type: "thesis", symbol: "BTCUSDT", title: "Round-trip thesis", text: "Paper-only test"
    });
    assert.equal(journal.status, 200);
    const hash = journal.body.data.record.hash;
    const opened = await post(srv.base, "/api/paper/orders", {
      symbol: "BTCUSDT", side: "BUY", quantity: 0.01, price: 42000,
      idempotencyKey: "outcome-open", thesisHash: hash
    });
    assert.equal(opened.status, 200);
    const stillOpen = await fetch(srv.base + "/api/learning/outcomes").then((response) => response.json());
    assert.equal(stillOpen.data.state, "empty");
    assert.equal(stillOpen.data.outcomes.length, 0, "an open position must never be presented as a realized outcome");
    assert.equal(stillOpen.data.summary.openLotCount, 1);

    await srv.close();
    srv = await startTestServer({fetchImpl: tickerFetchAt(43000, 42999, 43001), stateFile, executionStateFile});
    const closed = await post(srv.base, "/api/paper/orders", {
      symbol: "BTCUSDT", side: "SELL", quantity: 0.01, price: 43000,
      idempotencyKey: "outcome-close", reduceOnly: true
    });
    assert.equal(closed.status, 200);

    const response = await fetch(srv.base + "/api/learning/outcomes");
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.state, "ok");
    assert.equal(data.outcomes.length, 1);
    assert.equal(data.outcomes[0].thesisRef.hash, hash);
    assert.equal(data.outcomes[0].direction, "LONG");
    assert.ok(data.outcomes[0].grossPnl > 0);
    assert.ok(data.outcomes[0].fees > 0);
    assert.ok(Math.abs(data.outcomes[0].netPnl - (data.outcomes[0].grossPnl - data.outcomes[0].fees)) < 1e-10);
    assert.equal(data.summary.linkedOutcomeCount, 1);
    assert.equal(data.summary.openLotCount, 0);
    assert.match(data.note, /server-derived/i);
    assert.match(data.note, /paper/i);
  } finally {
    await srv.close().catch(() => {});
    rmSync(dir, {recursive: true, force: true});
  }
});

test("HTTP learning report fails closed instead of skipping a malformed persisted fill", async () => {
  const store = new DurableStore();
  store.put("paper-fills", "bad-fill", {
    orderId: "bad-fill", idempotencyKey: "bad-fill", status: "RECONCILED",
    symbol: "BTCUSDT", side: "BUY", quantity: 1, price: 100,
    fee: "unknown", timestamp: 1
  });
  const srv = await startTestServer({fetchImpl: tickerFetchAt(100, 99, 101), store});
  try {
    const response = await fetch(srv.base + "/api/learning/outcomes");
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, "paper-learning-unavailable");
    assert.equal(JSON.stringify(body).includes("bad-fill"), false, "persisted internals must not leak");
  } finally {
    await srv.close();
  }
});
