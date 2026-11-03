import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const start = app.indexOf("  var journalRequestId = 0;");
const end = app.indexOf("  var learningOutcomesRequestId = 0;", start);
assert.ok(start >= 0 && end > start, "journal controller boundaries exist");
const controller = app.slice(start, end);

function report(label) {
  return {status: 200, body: {ok: true, data: {state: "ok", verified: true, integrity: "verified",
    total: 1, returned: 1, entries: [{index: 1, hash: label, previousHash: "GENESIS",
      entry: {type: "thesis", symbol: "BTCUSDT", title: label, text: "fixture"}}], note: label}}};
}

function harness() {
  const nodes = new Map(), requests = [];
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, {children: [], options: [], value: "", appendChild(node) {this.children.push(node);}});
    return nodes.get(id);
  };
  const context = vm.createContext({
    Promise, Array, JSON, String, verifiedJournalRecords: [],
    $: get,
    clear: node => {node.children = [];},
    el: (tag, cls, text) => ({tag, cls, text, children: [], appendChild(node) {this.children.push(node);}}),
    setBadge: (id, state, text) => {get(id).state = state; get(id).badgeText = text || String(state).toUpperCase();},
    setBusy: (id, busy) => {get(id).busy = busy;},
    note: (id, text) => {get(id).text = text;},
    row: (node, key, text) => node.appendChild({key, text}),
    failureState: () => ({state: "unavailable", message: "Not available."}),
    syncOrderThesisOptions: () => {
      const select = get("order-thesis");
      const selected = select.value;
      select.options = [{value: ""}].concat(context.verifiedJournalRecords.map(record => ({value: record.hash})));
      if (!select.options.some(option => option.value === selected)) select.value = "";
      select.disabled = select.options.length <= 1;
    },
    api: () => new Promise((resolve, reject) => requests.push({resolve, reject}))
  });
  vm.runInContext(controller, context);
  return {get, context, requests, run: () => context.renderJournal()};
}

test("older journal success cannot overwrite a newer verified snapshot", async () => {
  const h = harness(), old = h.run(), current = h.run();
  h.requests[1].resolve(report("new")); await current;
  h.requests[0].resolve(report("old")); await old;
  assert.equal(h.get("journal-note").text, "new");
  assert.equal(h.context.verifiedJournalRecords[0].hash, "new");
  assert.equal(h.get("journal-entries").children[0].text, "#1 {\"type\":\"thesis\",\"symbol\":\"BTCUSDT\",\"title\":\"new\",\"text\":\"fixture\"}");
  assert.equal(h.get("journal-badge").state, "ok");
});

test("superseded journal transport failure cannot clear a newer verified snapshot", async () => {
  const h = harness(), old = h.run(), current = h.run();
  h.requests[1].resolve(report("new")); await current;
  h.requests[0].reject(new Error("old network error")); await old;
  assert.equal(h.get("journal-badge").state, "ok");
  assert.equal(h.get("journal-note").text, "new");
  assert.equal(h.context.verifiedJournalRecords[0].hash, "new");
});

test("refresh clears old journal records and thesis choices while the newest request owns loading", async () => {
  const h = harness(), initial = h.run();
  h.requests[0].resolve(report("initial")); await initial;
  h.get("order-thesis").value = "initial";
  const old = h.run(), current = h.run();
  assert.equal(h.context.verifiedJournalRecords.length, 0);
  assert.equal(h.get("journal-values").children.length, 0);
  assert.equal(h.get("journal-entries").children.length, 0);
  assert.equal(h.get("order-thesis").disabled, true);
  h.requests[1].resolve(report("older")); await old;
  assert.equal(h.get("journal-values").busy, true);
  h.requests[2].reject(new Error("current network error")); await current;
  assert.equal(h.get("journal-values").busy, false);
  assert.equal(h.get("journal-badge").state, "unavailable");
  assert.equal(h.get("journal-values").children.length, 0);
  assert.equal(h.get("journal-entries").children.length, 0);
  assert.equal(h.context.verifiedJournalRecords.length, 0);
  assert.equal(h.get("order-thesis").disabled, true);
});

test("latest successful journal refresh restores only a still-verified selected thesis", async () => {
  const h = harness(), initial = h.run();
  h.requests[0].resolve(report("same-hash")); await initial;
  h.get("order-thesis").value = "same-hash";
  const refresh = h.run();
  assert.equal(h.get("order-thesis").disabled, true);
  h.requests[1].resolve(report("same-hash")); await refresh;
  assert.equal(h.get("order-thesis").disabled, false);
  assert.equal(h.get("order-thesis").value, "same-hash");
});

test("latest failed journal refresh cannot be revived by a late older success", async () => {
  const h = harness(), old = h.run(), current = h.run();
  h.requests[1].reject(new Error("current network error")); await current;
  h.requests[0].resolve(report("old")); await old;
  assert.equal(h.get("journal-badge").state, "unavailable");
  assert.equal(h.context.verifiedJournalRecords.length, 0);
  assert.equal(h.get("journal-entries").children.length, 0);
  assert.equal(h.get("order-thesis").disabled, true);
});
