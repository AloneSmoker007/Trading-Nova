// WS-A [C1] Durable paper execution — regression tests against the REAL
// DurableStore (no mocks). Before the fix, PersistentPaperEngine.submit threw
// DataCloneError (sync transactIdempotent cloned a Promise) and leaked a
// partial `paper-fills` write before failing. These tests reproduce both
// failure modes and prove the fix.
import test from "node:test";
import assert from "node:assert/strict";
import { DurableStore } from "../src/persistence/store.js";
import { PersistentPaperEngine } from "../src/execution/paper-persistent.js";
import { createRiskConfig, evaluateRiskGate } from "../src/risk/gate.js";

function portfolio() {
  return { equity: 10000, cash: 10000, positions: [], grossExposure: 0, netExposure: 0, dailyPnl: 0, drawdown: 0 };
}

function allowArtifact(order, price) {
  const p = portfolio();
  const { config, hash } = createRiskConfig({
    version: "wsa-exec", maxPositionNotional: 100000, maxGrossExposure: 100000,
    maxDailyLoss: 1000, maxDrawdown: 0.5, maxLeverage: 10
  });
  const verdict = evaluateRiskGate({ order: { ...order, price }, portfolio: p, riskConfig: config, approvedConfigHash: hash });
  assert.equal(verdict.decision, "ALLOW");
  return verdict.artifact;
}

test("C1 regression: persistent paper engine executes against the real DurableStore", async () => {
  const store = new DurableStore();
  const engine = new PersistentPaperEngine(store);
  const order = { id: "1", idempotencyKey: "x", side: "BUY", symbol: "btc", quantity: 1 };
  // Pre-fix this threw: DataCloneError - #<Promise> could not be cloned.
  const fill = await engine.submit(order, { markPrice: 100, gateArtifact: allowArtifact(order, 100) });
  assert.equal(fill.status, "RECONCILED");
  assert.equal(fill.symbol, "BTC");
  assert.equal(fill.price, 100);
  // The fill must be durably persisted...
  assert.deepEqual(store.get("paper-fills", "x").status, "RECONCILED");
  // ...and the idempotency record must exist (pre-fix it was never recorded).
  const replay = await engine.submit({ ...order, id: "2" }, { markPrice: 999, gateArtifact: allowArtifact(order, 999) });
  assert.deepEqual(replay, fill);
  // Exactly one fill record; nothing leaked.
  assert.deepEqual(Object.keys(store.snapshot().state), ["paper-fills:x"]);
});

test("C1 regression: a failing operation leaks NO partial write and records no idempotency key", async () => {
  const store = new DurableStore();
  // The pre-fix bug: the operation's put executed against live state before
  // the call failed, leaving a committed partial write.
  await assert.rejects(
    store.transactIdempotent("order-1", async (tx) => {
      await tx.put("paper-fills", "1", { status: "RECONCILED" });
      store.put("paper-fills", "2", { status: "RECONCILED" });
      throw new Error("boom");
    }),
    /boom/
  );
  assert.equal(store.get("paper-fills", "1"), null);
  assert.equal(store.get("paper-fills", "2"), null);
  assert.equal(Object.keys(store.snapshot().state).length, 0);
  assert.equal(Object.keys(store.snapshot().idempotency).length, 0);
  // The key is free again: a retry executes cleanly and commits atomically.
  const result = await store.transactIdempotent("order-1", async (tx) => {
    await tx.put("paper-fills", "1", { status: "RECONCILED" });
    return { ok: true };
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(store.get("paper-fills", "1"), { status: "RECONCILED" });
});

test("C1 regression: an unclonable (Promise-bearing) result cannot leak the operation's writes", async () => {
  const store = new DurableStore();
  await assert.rejects(
    store.transactIdempotent("order-2", async (tx) => {
      await tx.put("paper-fills", "2", { leaked: true });
      // Pre-fix this Promise reached structuredClone and threw AFTER the put.
      return { pending: Promise.resolve(1) };
    })
  );
  assert.equal(store.get("paper-fills", "2"), null);
  assert.equal(Object.keys(store.snapshot().state).length, 0);
});

test("async operation results are awaited and returned as plain values, never Promises", async () => {
  const store = new DurableStore();
  const result = await store.transactIdempotent("k", async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { value: 42 };
  });
  assert.ok(!(result instanceof Promise));
  assert.deepEqual(result, { value: 42 });
  // Cached replay returns an equal, distinct clone.
  const replay = await store.transactIdempotent("k", async () => ({ value: 99 }));
  assert.deepEqual(replay, { value: 42 });
});

test("concurrent transactions are atomic and isolated (serialized staging)", async () => {
  const store = new DurableStore();
  const [a, b] = await Promise.all([
    store.transactIdempotent("a", async (tx) => {
      await tx.put("ns", "a", { from: "a" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { done: "a" };
    }),
    store.transactIdempotent("b", async (tx) => {
      await tx.put("ns", "b", { from: "b" });
      throw new Error("b-fails");
    }).catch((error) => ({ failed: error.message }))
  ]);
  assert.deepEqual(a, { done: "a" });
  assert.deepEqual(b, { failed: "b-fails" });
  // The failed transaction left nothing behind; the successful one committed.
  assert.deepEqual(store.get("ns", "a"), { from: "a" });
  assert.equal(store.get("ns", "b"), null);
});

test("same-key concurrent submissions execute the operation exactly once", async () => {
  const store = new DurableStore();
  let calls = 0;
  const op = async () => { calls++; return { calls }; };
  const [a, b, c] = await Promise.all([
    store.transactIdempotent("same", op),
    store.transactIdempotent("same", op),
    store.transactIdempotent("same", op)
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(a, { calls: 1 });
  assert.deepEqual(b, { calls: 1 });
  assert.deepEqual(c, { calls: 1 });
});

test("transaction reads see their own uncommitted writes", async () => {
  const store = new DurableStore();
  store.put("ns", "seed", { v: 0 });
  const result = await store.transactIdempotent("rw", async (tx) => {
    assert.deepEqual(tx.get("ns", "seed"), { v: 0 });
    tx.put("ns", "seed", { v: 1 });
    // Read-your-writes through both the handle and the store itself.
    assert.deepEqual(tx.get("ns", "seed"), { v: 1 });
    assert.deepEqual(store.get("ns", "seed"), { v: 1 });
    return { ok: true };
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(store.get("ns", "seed"), { v: 1 });
});

test("durable engine never executes a paper fill without a persisted idempotency record", async () => {
  const store = new DurableStore();
  const engine = new PersistentPaperEngine(store);
  const order = { id: "7", idempotencyKey: "k7", side: "SELL", symbol: "ETHUSDT", quantity: 2 };
  await engine.submit(order, { markPrice: 50, gateArtifact: allowArtifact(order, 50) });
  const snap = store.snapshot();
  assert.deepEqual(Object.keys(snap.state), ["paper-fills:k7"]);
  assert.deepEqual(Object.keys(snap.idempotency), ["paper:k7"]);
  // A restored store replays idempotently instead of double-filling.
  const restored = new DurableStore();
  restored.restore(snap);
  const again = await new PersistentPaperEngine(restored).submit({ ...order, id: "8" }, { markPrice: 60, gateArtifact: allowArtifact(order, 60) });
  assert.equal(again.status, "RECONCILED");
  assert.equal(again.price, 50);
});
