import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {derivePaperOutcomes} from "../src/journal/outcomes.js";
import {appendJournalEntry} from "../src/journal/journal.js";
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

test("USDT learning accounting rejects every legacy non-USDT fill without filtering history", () => {
  const supported = fill({id: "supported", side: "BUY", quantity: 1, price: 100, fee: 1, timestamp: 1});
  for (const symbol of ["ETHBTC", "BTCUSDC", "BTCUSD", "USDT", "BTCUSDTX"]) {
    const legacy = {...supported, orderId: "legacy", idempotencyKey: "legacy", symbol};
    assert.throws(() => derivePaperOutcomes([supported, legacy]), /invalid paper fill/i, symbol);
  }
  assert.equal(derivePaperOutcomes([supported]).summary.openLotCount, 1);
});

test("legacy quote-currency history cannot become USDT learning results or loss-autopsy facts", async () => {
  const store = new DurableStore();
  const legacyFills = [
    {...fill({id: "legacy-open", side: "BUY", quantity: 1, price: 0.05, fee: 0.001, timestamp: 1}), symbol: "ETHBTC"},
    {...fill({id: "legacy-close", side: "SELL", quantity: 1, price: 0.04, fee: 0.001, timestamp: 2}), symbol: "ETHBTC"},
    fill({id: "valid-usdt", side: "BUY", quantity: 1, price: 100, fee: 1, timestamp: 3})
  ];
  for (const item of legacyFills) store.put("paper-fills", item.idempotencyKey, item);
  let providerCalls = 0;
  const srv = await startTestServer({store, fetchImpl: async () => {providerCalls++; throw new Error("no provider call expected");}});
  try {
    const response = await fetch(srv.base + "/api/learning/outcomes");
    assert.equal(response.status, 503, "BTC-denominated P&L must not be labelled USDT");
    const body = await response.json();
    assert.equal(body.error.code, "paper-learning-unavailable");
    assert.equal(body.data, undefined, "do not publish a filtered partial USDT report");
    const review = await post(srv.base, "/api/journal/entry", {
      type: "loss-autopsy", outcomeId: "a".repeat(64), title: "Legacy loss", text: "Must stay unverified"
    });
    assert.equal(review.status, 503);
    assert.equal(review.body.error.code, "paper-learning-unavailable");
    assert.equal(store.get("paper-journal", "main"), null);
    for (const item of legacyFills) assert.deepEqual(store.get("paper-fills", item.idempotencyKey), item);
    assert.equal(providerCalls, 0);
  } finally {
    await srv.close();
  }
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

test("loss autopsy must bind to an existing server-derived realized loss", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trading-nova-autopsy-"));
  const stateFile = join(dir, "paper-state.json");
  const executionStateFile = join(dir, "paper-orders.json");
  const srv = await startTestServer({fetchImpl: tickerFetchAt(42000, 41999, 42001), stateFile, executionStateFile});
  try {
    const savedThesis = await post(srv.base, "/api/journal/entry", {
      type: "thesis", symbol: "BTCUSDT", title: "Autopsy thesis", text: "Paper-only test"
    });
    const thesisHash = savedThesis.body.data.record.hash;
    assert.equal((await post(srv.base, "/api/paper/orders", {
      symbol: "BTCUSDT", side: "BUY", quantity: 0.01, price: 42000,
      idempotencyKey: "autopsy-open", thesisHash
    })).status, 200);
    assert.equal((await post(srv.base, "/api/paper/orders", {
      symbol: "BTCUSDT", side: "SELL", quantity: 0.01, price: 42000,
      idempotencyKey: "autopsy-close", reduceOnly: true
    })).status, 200);

    const before = await fetch(srv.base + "/api/learning/outcomes").then(response => response.json());
    const loss = before.data.outcomes[0];
    assert.equal(loss.result, "LOSS");
    assert.equal(before.data.reviewState, "verified");
    assert.equal(before.data.summary.reviewedLossCount, 0);
    assert.equal(before.data.summary.unreviewedLossCount, 1);

    const fake = await post(srv.base, "/api/journal/entry", {
      type: "loss-autopsy", outcomeId: "f".repeat(64), title: "Fake", text: "Must reject"
    });
    assert.equal(fake.status, 400);
    assert.equal(fake.body.error.code, "learning-outcome-not-found");

    const oversized = await post(srv.base, "/api/journal/entry", {
      type: "loss-autopsy", outcomeId: loss.outcomeId, title: "Too long", text: "x".repeat(2001)
    });
    assert.equal(oversized.status, 400);
    assert.equal(oversized.body.error.code, "loss-autopsy-too-long");

    const review = await post(srv.base, "/api/journal/entry", {
      type: "loss-autopsy", outcomeId: loss.outcomeId, symbol: "ETHUSDT",
      title: "Waited too long", text: "I ignored the invalidation level.", tags: ["late-exit"]
    });
    assert.equal(review.status, 200);
    assert.deepEqual(review.body.data.record.entry.reviewOf, {
      outcomeId: loss.outcomeId,
      thesisHash,
      symbol: "BTCUSDT",
      result: "LOSS",
      netPnl: loss.netPnl,
      closedAt: loss.closedAt,
      source: "paper-fill-fifo-v1"
    });
    assert.equal(review.body.data.record.entry.symbol, "BTCUSDT", "server outcome symbol wins over user input");

    const journal = await fetch(srv.base + "/api/journal").then(response => response.json());
    assert.equal(journal.data.verified, true);
    assert.equal(journal.data.entries.at(-1).hash, review.body.data.record.hash);

    const after = await fetch(srv.base + "/api/learning/outcomes").then(response => response.json());
    assert.equal(after.data.reviewState, "verified");
    assert.equal(after.data.summary.reviewedLossCount, 1);
    assert.equal(after.data.summary.unreviewedLossCount, 0);
    assert.equal(after.data.summary.lossAutopsyCount, 1);
    assert.deepEqual(after.data.lossAutopsies, [{
      recordHash: review.body.data.record.hash,
      recordIndex: review.body.data.record.index,
      timestamp: review.body.data.record.entry.timestamp,
      outcomeId: loss.outcomeId,
      thesisHash,
      symbol: "BTCUSDT",
      title: "Waited too long",
      text: "I ignored the invalidation level.",
      tags: ["late-exit"],
      source: "user-authored-loss-autopsy"
    }]);
  } finally {
    await srv.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test("loss autopsy rejects a realized win and hides semantically forged review links", async () => {
  const winningStore = new DurableStore();
  const opening = fill({id: "win-open", side: "BUY", quantity: 1, price: 100, fee: 1,
    timestamp: 1, thesisRef: thesis("e".repeat(64))});
  const closing = fill({id: "win-close", side: "SELL", quantity: 1, price: 120, fee: 1, timestamp: 2});
  winningStore.put("paper-fills", opening.orderId, opening);
  winningStore.put("paper-fills", closing.orderId, closing);
  const win = derivePaperOutcomes([opening, closing]).outcomes[0];
  const winServer = await startTestServer({fetchImpl: tickerFetchAt(120, 119, 121), store: winningStore});
  try {
    const rejected = await post(winServer.base, "/api/journal/entry", {
      type: "loss-autopsy", outcomeId: win.outcomeId, title: "Not a loss", text: "Must reject"
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, "loss-autopsy-requires-loss");
  } finally {
    await winServer.close();
  }

  const forgedStore = new DurableStore();
  const lossOpen = fill({id: "loss-open", side: "BUY", quantity: 1, price: 100, fee: 1,
    timestamp: 1, thesisRef: thesis("f".repeat(64))});
  const lossClose = fill({id: "loss-close", side: "SELL", quantity: 1, price: 90, fee: 1, timestamp: 2});
  forgedStore.put("paper-fills", lossOpen.orderId, lossOpen);
  forgedStore.put("paper-fills", lossClose.orderId, lossClose);
  const loss = derivePaperOutcomes([lossOpen, lossClose]).outcomes[0];
  const chain = [];
  appendJournalEntry(chain, {
    timestamp: 3, type: "loss-autopsy", symbol: loss.symbol, title: "Forged projection",
    text: "Hash-valid text with mismatched execution facts", tags: [],
    reviewOf: {outcomeId: loss.outcomeId, thesisHash: loss.thesisRef.hash, symbol: loss.symbol,
      result: "LOSS", netPnl: loss.netPnl + 1, closedAt: loss.closedAt, source: loss.source}
  });
  forgedStore.put("paper-journal", "main", {payload: JSON.stringify({version: 1, updatedAt: 3, entries: chain})});
  const forgedServer = await startTestServer({fetchImpl: tickerFetchAt(90, 89, 91), store: forgedStore});
  try {
    const response = await fetch(forgedServer.base + "/api/learning/outcomes");
    assert.equal(response.status, 200, "execution outcomes remain available independently");
    const data = (await response.json()).data;
    assert.equal(data.outcomes.length, 1);
    assert.equal(data.reviewState, "unavailable");
    assert.deepEqual(data.lossAutopsies, []);
    assert.equal(data.summary.reviewedLossCount, null);
    assert.equal(data.summary.unreviewedLossCount, null);
  } finally {
    await forgedServer.close();
  }

  const boundedStore = new DurableStore();
  boundedStore.put("paper-fills", lossOpen.orderId, lossOpen);
  boundedStore.put("paper-fills", lossClose.orderId, lossClose);
  const longChain = [];
  appendJournalEntry(longChain, {
    timestamp: 3, type: "loss-autopsy", symbol: loss.symbol, title: "Valid but outside read window",
    text: "Must not be silently omitted from coverage counts", tags: [],
    reviewOf: {outcomeId: loss.outcomeId, thesisHash: loss.thesisRef.hash, symbol: loss.symbol,
      result: loss.result, netPnl: loss.netPnl, closedAt: loss.closedAt, source: loss.source}
  });
  for (let index = 0; index < 200; index++) {
    appendJournalEntry(longChain, {timestamp: 4 + index, type: "notes", symbol: "GENERAL",
      title: "Bounded note", text: String(index), tags: []});
  }
  boundedStore.put("paper-journal", "main", {payload: JSON.stringify({version: 1, updatedAt: 204, entries: longChain})});
  const boundedServer = await startTestServer({fetchImpl: tickerFetchAt(90, 89, 91), store: boundedStore});
  try {
    const data = await fetch(boundedServer.base + "/api/learning/outcomes").then(response => response.json()).then(body => body.data);
    assert.equal(data.reviewState, "unavailable", "an incomplete journal window must not under-count older reviews");
    assert.equal(data.summary.reviewedLossCount, null);
  } finally {
    await boundedServer.close();
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
