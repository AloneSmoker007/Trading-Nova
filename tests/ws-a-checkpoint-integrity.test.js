// WS-A [H3] Restore must hash-verify the FULL checkpoint. Before the fix only
// the audit journal was verified, so tampered trading state (cash 100 →
// 99,999,999) restored cleanly and fed the Risk Gate forged numbers.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DurableStore } from "../src/persistence/store.js";
import { createCheckpoint, restoreCheckpoint } from "../src/recovery/checkpoint.js";

// Independent replica of the store's canonical state-root hash, so the tests
// can simulate an attacker who recomputes the state hash after tampering.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  return value;
}
function stateRoot(state, idempotency) {
  return createHash("sha256").update(JSON.stringify(stable({ state, idempotency }))).digest("hex");
}

test("legitimate checkpoint restores in full (state + idempotency + journal)", () => {
  const s = new DurableStore();
  s.put("portfolio", "main", { cash: 100 });
  s.transactIdempotent("order-1", () => ({ status: "accepted" }));
  s.appendAudit({ type: "ORDER", id: "1" });
  const cp = createCheckpoint(s);
  const restored = new DurableStore();
  restoreCheckpoint(restored, cp);
  assert.deepEqual(restored.get("portfolio", "main"), { cash: 100 });
  assert.equal(restored.verify(), true);
  assert.equal(typeof restored.snapshot().stateHash, "string");
});

test("tampered trading state in a checkpoint is rejected (audit repro)", () => {
  const s = new DurableStore();
  s.put("portfolio", "main", { cash: 100 });
  s.appendAudit({ type: "SNAPSHOT" });
  const cp = createCheckpoint(s);
  // The exact tampering the audit reproduced: swap in forged trading state.
  cp.snapshot.state["portfolio:main"] = { cash: 999999999 };
  assert.throws(() => restoreCheckpoint(new DurableStore(), cp), /integrity/);
});

test("tampered idempotency cache is rejected", () => {
  const s = new DurableStore();
  s.transactIdempotent("order-1", () => ({ status: "accepted" }));
  const cp = createCheckpoint(s);
  cp.snapshot.idempotency["order-1"] = { status: "forged" };
  assert.throws(() => restoreCheckpoint(new DurableStore(), cp), /integrity/);
});

test("recomputing the state hash after tampering is not enough: the journal anchor catches it", () => {
  const s = new DurableStore();
  s.put("portfolio", "main", { cash: 100 });
  const cp = createCheckpoint(s);
  // Attacker tampers the state AND recomputes the snapshot's stateHash.
  cp.snapshot.state["portfolio:main"] = { cash: 999999999 };
  cp.snapshot.stateHash = stateRoot(cp.snapshot.state, cp.snapshot.idempotency);
  assert.throws(() => restoreCheckpoint(new DurableStore(), cp), /integrity/);
});

test("a checkpoint without a verifiable state hash is refused", () => {
  const s = new DurableStore();
  s.put("portfolio", "main", { cash: 100 });
  const cp = createCheckpoint(s);
  delete cp.snapshot.stateHash;
  assert.throws(() => restoreCheckpoint(new DurableStore(), cp), /integrity/);
});

test("tampered journal entries are still rejected", () => {
  const s = new DurableStore();
  s.appendAudit({ type: "ORDER", id: "1" });
  const cp = createCheckpoint(s);
  cp.snapshot.journal[0].entry.id = "tampered";
  assert.throws(() => restoreCheckpoint(new DurableStore(), cp), /integrity/);
});

test("snapshot and restore never share object references with callers", () => {
  const s = new DurableStore();
  s.put("portfolio", "main", { cash: 100 });
  const cp = createCheckpoint(s);
  // Mutating the snapshot must not reach the live store (or vice versa).
  cp.snapshot.state["portfolio:main"].cash = 999999999;
  assert.deepEqual(s.get("portfolio", "main"), { cash: 100 });
  const restored = new DurableStore();
  // The mutation above invalidated the hash; a clean checkpoint restores fine.
  const cp2 = createCheckpoint(s);
  restoreCheckpoint(restored, cp2);
  restored.get("portfolio", "main").cash = 42;
  assert.deepEqual(s.get("portfolio", "main"), { cash: 100 });
});

test("failed restore leaves the target store untouched", () => {
  const s = new DurableStore();
  s.put("portfolio", "main", { cash: 100 });
  const cp = createCheckpoint(s);
  cp.snapshot.state["portfolio:main"] = { cash: 999999999 };
  const target = new DurableStore();
  target.put("portfolio", "target", { cash: 7 });
  assert.throws(() => restoreCheckpoint(target, cp), /integrity/);
  assert.deepEqual(target.get("portfolio", "target"), { cash: 7 });
  assert.equal(target.get("portfolio", "main"), null);
});
