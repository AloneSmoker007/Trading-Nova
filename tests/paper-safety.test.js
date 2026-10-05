import test from "node:test";
import assert from "node:assert/strict";
import { createPaperExecution } from "../src/execution/paper.js";
import { createGuardedPaperExecution } from "../src/execution/guarded-paper.js";
import { createPostgresStore } from "../src/persistence/postgres.js";

const validOrder = (over = {}) => ({ symbol: "BTCUSDT", side: "BUY", quantity: 1, price: 100, ...over });

test("paper engine retention is bounded (audit LOAD F-02)", () => {
  const engine = createPaperExecution({ maxRetainedFills: 5 });
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(engine.submit(validOrder()).id);
  assert.equal(engine.get(ids[0]), null, "oldest fill must be evicted");
  assert.equal(engine.get(ids[19]).id, ids[19], "newest fill must be retained");
  let retained = 0;
  for (const id of ids) if (engine.get(id)) retained++;
  assert.equal(retained, 5, "exactly maxRetainedFills fills retained");
});

test("paper engine rejects invalid maxRetainedFills", () => {
  assert.throws(() => createPaperExecution({ maxRetainedFills: 0 }), /invalid maxRetainedFills/);
  assert.throws(() => createPaperExecution({ maxRetainedFills: -1 }), /invalid maxRetainedFills/);
  assert.throws(() => createPaperExecution({ maxRetainedFills: 1.5 }), /invalid maxRetainedFills/);
});

test("idempotency dedupe holds within the retention window", () => {
  const engine = createPaperExecution({ maxRetainedFills: 10 });
  const a = engine.submit(validOrder({ idempotencyKey: "k1" }));
  const b = engine.submit(validOrder({ idempotencyKey: "k1" }));
  assert.equal(a.id, b.id, "same key must return same fill inside window");
});

test("idempotency window is explicitly bounded by retention (documented semantics)", () => {
  const engine = createPaperExecution({ maxRetainedFills: 2 });
  const first = engine.submit(validOrder({ idempotencyKey: "evict-me" }));
  engine.submit(validOrder());
  engine.submit(validOrder()); // pushes retention over the cap -> key evicted
  const again = engine.submit(validOrder({ idempotencyKey: "evict-me" }));
  assert.notEqual(first.id, again.id, "evicted key is no longer deduplicated (bounded window)");
});

test("paper engine still rejects invalid orders", () => {
  const engine = createPaperExecution();
  assert.throws(() => engine.submit(validOrder({ quantity: 0 })), /invalid paper order/);
  assert.throws(() => engine.submit(validOrder({ side: "HOLD" })), /invalid paper order/);
  assert.throws(() => engine.submit(validOrder({ price: NaN })), /invalid paper order/);
});

test("guarded paper engine refuses to construct without market state provider", () => {
  assert.throws(() => createGuardedPaperExecution({}), /market state provider required/);
});

test("guarded paper engine returns deterministic NO_TRADE on unhealthy market (audit MARKET F-02)", () => {
  let state = { state: "CONNECTED", connected: true, lastValidAt: Date.now() };
  const engine = createGuardedPaperExecution({ getMarketState: () => state });

  const fill = engine.submit(validOrder());
  assert.equal(fill.status, "FILLED", "healthy market must fill");

  state = { state: "DISCONNECTED", connected: false, lastValidAt: Date.now() };
  const blocked = engine.submit(validOrder());
  assert.equal(blocked.status, "NO_TRADE");
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.reasons.includes("DISCONNECTED"));
});

test("guarded paper engine blocks stale, gapped and invalid data (fail-closed)", () => {
  const base = { state: "CONNECTED", connected: true, lastValidAt: Date.now() };
  const cases = [
    [{ ...base, lastValidAt: Date.now() - 60000 }, "STALE_DATA"],
    [{ ...base, state: "GAP", gapOpen: true }, "SEQUENCE_GAP"],
    [{ ...base, invalidData: true }, "INVALID_DATA"],
    [{ state: "WEIRD", connected: true, lastValidAt: Date.now() }, "UNKNOWN_MARKET_STATE"],
    [null, "UNKNOWN_MARKET_STATE"],
    [undefined, "UNKNOWN_MARKET_STATE"],
  ];
  for (const [state, expected] of cases) {
    const engine = createGuardedPaperExecution({ getMarketState: () => state });
    const res = engine.submit(validOrder());
    assert.equal(res.status, "NO_TRADE", `state ${JSON.stringify(state)} must not trade`);
    assert.ok(res.reasons.includes(expected), `expected reason ${expected}, got ${res.reasons}`);
  }
});

test("postgres pool survives idle-client errors instead of crashing (audit DB-03)", async () => {
  const store = await createPostgresStore({ connectionString: "postgresql://testuser@127.0.0.1:1/nonexistentdb" });
  assert.ok(store.pool.listenerCount("error") >= 1, "pool must have an error listener");
  // Simulated server-restart idle client failure (57P01) must be logged, not fatal.
  store.pool.emit("error", Object.assign(new Error("Connection terminated due to administrator command"), { code: "57P01" }));
  await store.pool.end();
  assert.ok(true, "process survived pool error event");
});
