import test from "node:test";
import assert from "node:assert/strict";
import {derivePaperOutcomes} from "../src/journal/outcomes.js";
import {DurableStore} from "../src/persistence/store.js";
import {startTestServer} from "./ws-d-helpers.js";

const opening = {orderId: "z-open", idempotencyKey: "z-open", status: "RECONCILED", symbol: "BTCUSDT",
  side: "BUY", quantity: 1, price: 100, fee: 1, timestamp: 1000,
  thesisRef: {hash: "a".repeat(64), index: 0, timestamp: 1, symbol: "BTCUSDT", title: "Opening thesis"}};
const closing = {orderId: "a-close", idempotencyKey: "a-close", status: "RECONCILED", symbol: "BTCUSDT",
  side: "SELL", quantity: 1, price: 90, fee: 1, timestamp: 1000};

test("same-symbol timestamp ties must not invent execution order from arbitrary fill IDs", () => {
  for (const rows of [[opening, closing], [closing, opening]]) {
    assert.throws(() => derivePaperOutcomes(rows), /ambiguous paper fill chronology/);
  }
});

test("distinct timestamps preserve actual opening thesis and independent symbols may share a timestamp", () => {
  const r = derivePaperOutcomes([opening, {...closing, timestamp: 1001}]);
  assert.equal(r.outcomes[0].direction, "LONG");
  assert.equal(r.outcomes[0].openingOrderId, "z-open");
  assert.equal(r.outcomes[0].thesisRef.hash, opening.thesisRef.hash);
  assert.equal(r.outcomes[0].netPnl, -12);
  const independent = {...closing, symbol: "ETHUSDT"};
  assert.equal(derivePaperOutcomes([opening, independent]).summary.openLotCount, 2);
});

test("ambiguous history makes HTTP learning/autopsy unavailable without writes or provider work", async () => {
  const store = new DurableStore();
  store.put("paper-fills", opening.idempotencyKey, opening);
  store.put("paper-fills", closing.idempotencyKey, closing);
  const before = JSON.stringify([...store.state]);
  let calls = 0;
  const srv = await startTestServer({store, fetchImpl: async () => {calls++; throw new Error("unexpected provider work");}});
  try {
    const report = await fetch(srv.base + "/api/learning/outcomes");
    assert.equal(report.status, 503);
    assert.equal((await report.json()).error.code, "paper-learning-unavailable");
    const review = await fetch(srv.base + "/api/journal/entry", {method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({type: "loss-autopsy", outcomeId: "b".repeat(64), title: "Ambiguous", text: "Do not invent execution provenance"})});
    assert.equal(review.status, 503);
    assert.equal((await review.json()).error.code, "paper-learning-unavailable");
    assert.equal(calls, 0);
    assert.equal(JSON.stringify([...store.state]), before);
  } finally {await srv.close();}
});
