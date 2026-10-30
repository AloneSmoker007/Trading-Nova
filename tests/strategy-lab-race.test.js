import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

// Execute the actual controller with deferred transport and a small DOM adapter.
const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const controller = app.slice(app.indexOf("  var strategyLabBusy = false;"), app.indexOf("  function syncOrderThesisOptions()"));
function harness() {
  const nodes = new Map(), requests = [];
  const node = () => ({children: [], value: "", disabled: false, appendChild(n) {this.children.push(n);},
    setAttribute() {}, removeAttribute() {}});
  const get = id => {if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id);};
  const context = vm.createContext({Promise, Number, encodeURIComponent, $: get,
    readSymbol: () => get("symbol-input").value,
    clear: n => {n.children = [];}, el: (_tag, _cls, text) => ({...node(), text}),
    setBadge: (id, state, text) => Object.assign(get(id), {state, text}),
    setBusy: (id, busy) => {get(id).busy = busy;}, note: (id, text) => {get(id).text = text;},
    row: (n, key, text) => n.appendChild({key, text}), fmtNum: String, fmtPct: String,
    api: path => new Promise(resolve => requests.push({path, resolve}))});
  vm.runInContext(controller, context);
  get("symbol-input").value = "BTCUSDT";
  const result = {status: 200, body: {ok: true, data: {
    inSample: {returnPct: 0.1, equity: 11000, trades: 1}, outOfSample: {returnPct: 0.1, equity: 11000, trades: 1},
    startingCash: 10000, evaluationSplit: {mode: "automatic", inSampleCandles: 140, outOfSampleCandles: 60},
    parameters: {feeRate: 0.001, slippageBps: 5}
  }}};
  return {get, requests, context, run: () => context.renderStrategyLab(),
    release: start => requests.slice(start, start + 3).forEach(r => r.resolve(result))};
}

test("late backtest responses cannot publish results under a different selected coin", async () => {
  const h = harness(), old = h.run();
  h.get("symbol-input").value = "ETHUSDT";
  h.release(0); await old;
  assert.equal(h.get("lab-body").children.length, 0);
  assert.notEqual(h.get("lab-badge").state, "ok");
});

test("input invalidation clears all result tables and an old completion cannot unlock a newer run", async () => {
  const h = harness(), old = h.run();
  h.get("symbol-input").value = "ETHUSDT";
  h.context.invalidateStrategyLab();
  const current = h.run();
  assert.equal(h.requests.length, 6);
  h.release(0); await old;
  assert.equal(h.get("run-backtest-btn").disabled, true);
  assert.equal(h.get("backtest-values").busy, true);
  h.release(3); await current;
  assert.equal(h.get("lab-body").children.length, 3);
  assert.equal(h.get("run-backtest-btn").disabled, false);
  h.context.invalidateStrategyLab();
  for (const id of ["lab-body", "lab-comparison-body", "lab-rolling-body", "backtest-values"]) assert.equal(h.get(id).children.length, 0);
  assert.equal(h.get("lab-badge").text, "RUN REQUIRED");
});

test("split edits discard pending results even when the coin is unchanged", async () => {
  const h = harness(), old = h.run();
  h.get("walk-forward-input").value = "150";
  h.context.invalidateStrategyLab();
  h.release(0); await old;
  assert.equal(h.get("lab-body").children.length, 0);
  assert.equal(h.get("lab-badge").text, "RUN REQUIRED");
});
