import test from "node:test";
import assert from "node:assert/strict";
import {createApi} from "../server/api.js";

function memoryStore() {
  const values = new Map();
  const key = (namespace, id) => namespace + ":" + id;
  const store = {
    async get(namespace, id) { return values.has(key(namespace,id)) ? structuredClone(values.get(key(namespace,id))) : null; },
    async put(namespace, id, value) { values.set(key(namespace,id), structuredClone(value)); return structuredClone(value); },
    async list(namespace) { return [...values.entries()].filter(([k]) => k.startsWith(namespace + ":")).map(([,v]) => structuredClone(v)); },
    async withTransaction(work) { return work({query: async () => ({rows: [], rowCount: 0})}); },
    async transactIdempotent(_key, operation) { return operation({get: store.get.bind(store), put: store.put.bind(store)}); },
    async health() { return true; }
  };
  return store;
}

function api(store, now = () => 1700000000000) {
  return createApi({market: {}, stateFile: "/unused/state.json", executionStateFile: "/unused/orders.json", store, now});
}

test("database-backed journal survives API recreation", async () => {
  const store = memoryStore();
  const first = await api(store).addJournalEntry(JSON.stringify({text: "Wait for confirmation.", symbol: "BTCUSDT"}));
  assert.equal(first.status, 200);
  const read = await api(store, () => 1700000001000).journal();
  assert.equal(read.status, 200);
  assert.equal(read.body.data.total, 1);
  assert.equal(read.body.data.verified, true);
  assert.equal(read.body.data.entries[0].entry.text, "Wait for confirmation.");
});

test("tampered journal is reported and cannot be appended to", async () => {
  const store = memoryStore();
  const instance = api(store);
  await instance.addJournalEntry(JSON.stringify({text: "Original"}));
  const saved = await store.get("paper-journal", "main");
  const snapshot = JSON.parse(saved.payload);
  snapshot.entries[0].entry.text = "Tampered";
  await store.put("paper-journal", "main", {payload: JSON.stringify(snapshot)});
  const read = await instance.journal();
  assert.equal(read.body.data.verified, false);
  assert.equal(read.body.data.integrity, "broken");
  const result = await instance.addJournalEntry(JSON.stringify({text: "Next"}));
  assert.equal(result.status, 500);
});
