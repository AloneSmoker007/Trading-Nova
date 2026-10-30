import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {startTestServer, fakeFetch, jsonResponse, ticker24hPayload} from "./ws-d-helpers.js";

function tickerFetch() {
  return fakeFetch([["/ticker/24hr", jsonResponse(200, ticker24hPayload())]]);
}

async function post(base, path, body) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body)
  });
  return {status: response.status, body: await response.json()};
}

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), "trading-nova-thesis-link-"));
  const stateFile = join(dir, "paper-state.json");
  const executionStateFile = join(dir, "paper-orders.json");
  const srv = await startTestServer({fetchImpl: tickerFetch(), stateFile, executionStateFile});
  try {
    await fn({srv, stateFile, executionStateFile});
  } finally {
    await srv.close();
    rmSync(dir, {recursive: true, force: true});
  }
}

async function journalEntry(base, overrides = {}) {
  const result = await post(base, "/api/journal/entry", {
    type: "thesis",
    symbol: "BTCUSDT",
    title: "Breakout with invalidation",
    text: "Enter only after confirmation; invalidate below support.",
    ...overrides
  });
  assert.equal(result.status, 200);
  return result.body.data.record;
}

function paperOrder(key, thesisHash) {
  return {
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quantity: 0.01,
    price: 42000,
    idempotencyKey: key,
    thesisHash
  };
}

test("a verified journal thesis is durably linked to its paper order and fill", async () => {
  await withServer(async ({srv}) => {
    const thesis = await journalEntry(srv.base);
    const placed = await post(srv.base, "/api/paper/orders", paperOrder("linked-thesis-order", thesis.hash));

    assert.equal(placed.status, 200);
    const expected = {
      hash: thesis.hash,
      index: thesis.index,
      timestamp: thesis.entry.timestamp,
      symbol: "BTCUSDT",
      title: "Breakout with invalidation"
    };
    assert.deepEqual(placed.body.data.order.thesisRef, expected);
    assert.deepEqual(placed.body.data.fill.thesisRef, expected);

    const orders = await fetch(srv.base + "/api/paper/orders").then((response) => response.json());
    const fills = await fetch(srv.base + "/api/orders").then((response) => response.json());
    assert.deepEqual(orders.data.orders[0].thesisRef, expected);
    assert.deepEqual(fills.data.fills[0].thesisRef, expected);
  });
});

test("paper order thesis references fail closed unless they identify a matching thesis", async () => {
  await withServer(async ({srv}) => {
    const note = await journalEntry(srv.base, {type: "note", title: "Not a thesis"});
    const otherSymbol = await journalEntry(srv.base, {symbol: "ETHUSDT", title: "ETH thesis"});

    const malformed = await post(srv.base, "/api/paper/orders", paperOrder("bad-hash", "not-a-hash"));
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, "invalid-thesis-hash");

    const missing = await post(srv.base, "/api/paper/orders", paperOrder("missing-hash", "0".repeat(64)));
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, "thesis-not-found");

    const wrongType = await post(srv.base, "/api/paper/orders", paperOrder("note-hash", note.hash));
    assert.equal(wrongType.status, 400);
    assert.equal(wrongType.body.error.code, "journal-record-not-thesis");

    const wrongSymbol = await post(srv.base, "/api/paper/orders", paperOrder("wrong-symbol", otherSymbol.hash));
    assert.equal(wrongSymbol.status, 400);
    assert.equal(wrongSymbol.body.error.code, "thesis-symbol-mismatch");

    const fills = await fetch(srv.base + "/api/orders").then((response) => response.json());
    assert.equal(fills.data.total, 0, "invalid provenance must never create a fill");
  });
});

test("an idempotency key cannot be replayed with a different thesis", async () => {
  await withServer(async ({srv}) => {
    const firstThesis = await journalEntry(srv.base, {title: "First thesis"});
    const secondThesis = await journalEntry(srv.base, {title: "Second thesis"});
    const key = "thesis-intent-conflict";

    const first = await post(srv.base, "/api/paper/orders", paperOrder(key, firstThesis.hash));
    assert.equal(first.status, 200);
    const replay = await post(srv.base, "/api/paper/orders", paperOrder(key, firstThesis.hash));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.state, "replayed");

    const changed = await post(srv.base, "/api/paper/orders", paperOrder(key, secondThesis.hash));
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, "idempotency-key-reused");
  });
});
