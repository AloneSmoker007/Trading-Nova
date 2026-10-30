import test from "node:test";
import assert from "node:assert/strict";
import {derivePaperOutcomes} from "../src/journal/outcomes.js";
import {DurableStore} from "../src/persistence/store.js";
import {startTestServer} from "./ws-d-helpers.js";

const ref = (hash, symbol) => ({hash: hash.repeat(64), index: 0, timestamp: 0, symbol, title: "Thesis " + hash});
const fill = (id, symbol, side, quantity, price, fee, timestamp, thesisRef) => ({orderId: id, idempotencyKey: id,
  status: "RECONCILED", symbol, side, quantity, price, fee, timestamp, ...(thesisRef ? {thesisRef} : {})});
const history = () => [
  fill("open-a", "BTCUSDT", "BUY", 2, 100, 2, 1, ref("a", "BTCUSDT")),
  fill("close-a", "BTCUSDT", "SELL", 0.5, 120, 0.5, 2),
  fill("close-b", "BTCUSDT", "SELL", 0.5, 90, 0.5, 3),
  fill("unlinked-open", "SOLUSDT", "BUY", 1, 10, 0.1, 4),
  fill("unlinked-close", "SOLUSDT", "SELL", 1, 12, 0.1, 5),
  fill("open-b", "ETHUSDT", "BUY", 1, 30, 0.1, 6, ref("b", "ETHUSDT"))
];

test("thesis summaries aggregate partial FIFO matches and separate open-only/unlinked groups", () => {
  const r = derivePaperOutcomes(history());
  assert.equal(r.thesisSummaries.length, 3);
  const a = r.thesisSummaries.find(g => g.thesisHash === "a".repeat(64));
  assert.deepEqual({fragments: a.matchedFragments, wins: a.wins, losses: a.losses, fees: a.fees,
    gross: a.grossPnl, net: a.netPnl, open: a.openLotCount, mean: a.meanNetPnlPerFragment},
  {fragments: 2, wins: 1, losses: 1, fees: 2, gross: 5, net: 3, open: 1, mean: 1.5});
  assert.equal(a.unit, "matched-fifo-fragments-not-whole-trades");
  const b = r.thesisSummaries.find(g => g.thesisHash === "b".repeat(64));
  assert.equal(b.matchedFragments, 0);
  assert.equal(b.meanNetPnlPerFragment, null);
  assert.equal(b.openLotCount, 1);
  assert.equal(b.netPnl, 0, "open-only lots do not invent realized profit or charge unrealized fees");
  const unlinked = r.thesisSummaries.find(g => g.thesisHash === null);
  assert.equal(unlinked.netPnl, 1.8);
  assert.equal(r.thesisSummaries.reduce((n, g) => n + g.matchedFragments, 0), r.summary.outcomeCount);
  assert.equal(r.thesisSummaries.reduce((n, g) => n + g.openLotCount, 0), r.summary.openLotCount);
  assert.ok(Math.abs(r.thesisSummaries.reduce((n, g) => n + g.netPnl, 0) - r.summary.realizedNetPnl) < 1e-10);
  assert.deepEqual(derivePaperOutcomes([...history()].reverse()).thesisSummaries, r.thesisSummaries);
  assert.deepEqual(derivePaperOutcomes([]).thesisSummaries, []);
});

test("same GENERAL thesis hash combines symbols without combining their FIFO inventories", () => {
  const rows = history().map(f => ({...f, thesisRef: ref("c", "GENERAL")}));
  const r = derivePaperOutcomes(rows), g = r.thesisSummaries[0];
  assert.equal(r.thesisSummaries.length, 1);
  assert.deepEqual(g.symbols, ["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  assert.equal(g.matchedFragments, 3);
  assert.equal(g.netPnl, r.summary.realizedNetPnl);
});

test("HTTP summaries use complete server history without provider work or state writes", async () => {
  const store = new DurableStore();
  for (const f of history()) store.put("paper-fills", f.idempotencyKey, f);
  const before = JSON.stringify([...store.state]);
  let calls = 0;
  const srv = await startTestServer({store, fetchImpl: async () => {calls++; throw new Error("no provider needed");}});
  try {
    const response = await fetch(srv.base + "/api/learning/outcomes");
    assert.equal(response.status, 200);
    const d = (await response.json()).data;
    assert.deepEqual(d.thesisSummaries, derivePaperOutcomes(history()).thesisSummaries);
    assert.equal(JSON.stringify([...store.state]), before);
    assert.equal(calls, 0);
  } finally {await srv.close();}
});
