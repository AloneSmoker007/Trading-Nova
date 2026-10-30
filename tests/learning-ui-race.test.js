import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const controller = app.slice(app.indexOf("  var learningOutcomesRequestId = 0;"), app.indexOf("  var publisherNewsBusy"));
function report(label) {
  return {status: 200, body: {ok: true, data: {state: "ok", accounting: "FIFO", currency: "USDT",
    summary: {outcomeCount: 1, realizedNetPnl: -2}, reviewState: "verified", lossAutopsies: [],
    thesisSummaries: [{title: label, thesisHash: label, symbols: ["BTCUSDT"], matchedFragments: 1,
      wins: 0, losses: 1, breakeven: 0, fees: 2, netPnl: -2, openLotCount: 0}],
    outcomes: [{outcomeId: label, symbol: "BTCUSDT", direction: "LONG", result: "LOSS", netPnl: -2,
      fees: 2, thesisRef: {title: label}}], note: label}}};
}
function harness() {
  const nodes = new Map(), requests = [];
  const get = id => {if (!nodes.has(id)) nodes.set(id, {children: [], appendChild(n) {this.children.push(n);}}); return nodes.get(id);};
  const context = vm.createContext({Promise, Number, Set, verifiedLearningOutcomes: [], $: get,
    clear: n => {n.children = [];}, el: (tag, cls, text) => ({tag, cls, text, children: [], appendChild(n) {this.children.push(n);}}),
    setBadge: (id, state) => {get(id).state = state;}, setBusy: (id, busy) => {get(id).busy = busy;},
    note: (id, text) => {get(id).text = text;}, row: (n, key, text) => n.appendChild({key, text}), fmtNum: String,
    failureState: () => ({state: "unavailable", message: "Not available."}),
    syncLossAutopsyControl: () => {get("loss-options").ids = context.verifiedLearningOutcomes.map(x => x.outcomeId);},
    api: () => new Promise((resolve, reject) => requests.push({resolve, reject}))});
  vm.runInContext(controller, context);
  return {get, context, requests, run: () => context.renderLearningOutcomes()};
}

test("old learning success cannot overwrite a newer report or its loss-review options", async () => {
  const h = harness(), old = h.run(), current = h.run();
  h.requests[1].resolve(report("new")); await current;
  h.requests[0].resolve(report("old")); await old;
  assert.equal(h.get("learning-note").text, "new");
  assert.equal(h.context.verifiedLearningOutcomes[0].outcomeId, "new");
  assert.equal(h.get("learning-theses-body").children[0].children[0].text, "new · new · BTCUSDT");
});

test("superseded transport failure cannot clear current learning or mark it unavailable", async () => {
  const h = harness(), old = h.run(), current = h.run();
  h.requests[1].resolve(report("new")); await current;
  h.requests[0].reject(new Error("old network error")); await old;
  assert.equal(h.get("learning-badge").state, "ok");
  assert.equal(h.get("learning-note").text, "new");
  assert.equal(h.get("learning-theses-body").children.length, 1);
});

test("refresh clears all report surfaces and loss options; old finally cannot clear current busy state", async () => {
  const h = harness(), initial = h.run();
  h.requests[0].resolve(report("initial")); await initial;
  const old = h.run(), current = h.run();
  for (const id of ["learning-values", "learning-outcomes", "learning-theses-body"]) assert.equal(h.get(id).children.length, 0);
  assert.equal(h.context.verifiedLearningOutcomes.length, 0);
  assert.equal(h.get("loss-options").ids.length, 0);
  h.requests[1].resolve(report("old")); await old;
  assert.equal(h.get("learning-values").busy, true);
  h.requests[2].reject(new Error("current network error")); await current;
  assert.equal(h.get("learning-values").busy, false);
  assert.equal(h.get("learning-badge").state, "unavailable");
  for (const id of ["learning-values", "learning-outcomes", "learning-theses-body"]) assert.equal(h.get(id).children.length, 0);
});

test("late old success cannot revive a report after the latest request is unavailable", async () => {
  const h = harness(), old = h.run(), current = h.run();
  h.requests[1].resolve({status: 503, body: {ok: false}}); await current;
  h.requests[0].resolve(report("old")); await old;
  assert.equal(h.get("learning-badge").state, "unavailable");
  assert.equal(h.context.verifiedLearningOutcomes.length, 0);
  assert.equal(h.get("learning-outcomes").children.length, 0);
});
