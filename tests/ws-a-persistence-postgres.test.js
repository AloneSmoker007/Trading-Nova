// WS-A medium items — persistence hardening:
// M7: concurrent same-key transactIdempotent must not double-execute (the old
//     SELECT ... FOR UPDATE on a missing row locked nothing and the loser's
//     INSERT blew up the call). Per-key advisory lock + winner's result.
// H3: operation writes must join the transaction client, never a side channel.
import test from "node:test";
import assert from "node:assert/strict";
import { PostgresStore } from "../src/persistence/postgres.js";

function fakePool() {
  const calls = [];
  const committed = new Map();
  const idempotency = new Map();
  let pending = null;
  const client = {
    async query(sql, args = []) {
      calls.push([sql, args]);
      if (sql === "BEGIN") { pending = new Map(); return { rows: [] }; }
      if (sql === "COMMIT") { for (const [k, v] of pending) committed.set(k, v); pending = null; return { rows: [] }; }
      if (sql === "ROLLBACK") { pending = null; return { rows: [] }; }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("INSERT INTO trading_state")) {
        pending.set(args[0] + ":" + args[1], JSON.parse(args[2]));
        return { rows: [] };
      }
      if (sql.includes("SELECT value FROM trading_state")) {
        const key = args[0] + ":" + args[1];
        const value = pending?.has(key) ? pending.get(key) : committed.get(key);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.includes("INSERT INTO trading_idempotency")) {
        idempotency.set(args[0], JSON.parse(args[1]));
        return { rows: [] };
      }
      if (sql.includes("SELECT result FROM trading_idempotency")) {
        return idempotency.has(args[0]) ? { rowCount: 1, rows: [{ result: idempotency.get(args[0]) }] } : { rowCount: 0, rows: [] };
      }
      return { rows: [] };
    },
    release() { calls.push(["RELEASE", []]); }
  };
  return { calls, committed, client, async connect() { return client; }, async query(sql) { calls.push([sql, []]); return { rows: [{ ok: 1 }] }; } };
}

function sqlIndex(calls, fragment) {
  return calls.findIndex(([sql]) => sql.includes(fragment));
}

test("PostgresStore listPage bounds rows and reports total count", async () => {
  const calls = [];
  const pool = {
    async connect() { throw new Error("listPage must not open a transaction"); },
    async query(sql, args) {
      calls.push([sql, args]);
      if (sql.includes("COUNT(*)")) return {rows: [{total: "9"}]};
      return {rows: [{value: {timestamp: 300}}, {value: {timestamp: 200}}]};
    }
  };
  const store = new PostgresStore(pool);
  const page = await store.listPage("paper-fills", {limit: 2, offset: 4});
  assert.deepEqual(page, {items: [{timestamp: 300}, {timestamp: 200}], total: 9});
  assert.ok(calls.some(([sql, args]) => sql.includes("LIMIT $2 OFFSET $3")
    && args[0] === "paper-fills" && args[1] === 2 && args[2] === 4));
  await assert.rejects(store.listPage("paper-fills", {limit: 201}), /invalid list page/);
});

test("M7: per-key advisory lock is taken before the idempotency lookup", async () => {
  const pool = fakePool();
  const store = new PostgresStore(pool);
  await store.transactIdempotent("k", async () => ({ ok: true }));
  const lockAt = sqlIndex(pool.calls, "pg_advisory_xact_lock");
  const selectAt = sqlIndex(pool.calls, "SELECT result FROM trading_idempotency");
  assert.ok(lockAt >= 0 && lockAt < selectAt, "advisory lock must precede the lookup");
  const lockCall = pool.calls[lockAt];
  assert.ok(String(lockCall[1][0]).includes("k"), "lock must be scoped to the idempotency key");
});

test("M7: a replay after the winner commits returns the winner's result without re-executing", async () => {
  const pool = fakePool();
  const store = new PostgresStore(pool);
  let calls = 0;
  const first = await store.transactIdempotent("k", async () => { calls++; return { winner: true }; });
  const second = await store.transactIdempotent("k", async () => { calls++; return { winner: false }; });
  assert.deepEqual(first, { winner: true });
  assert.deepEqual(second, { winner: true });
  assert.equal(calls, 1);
});

test("H3: operation writes join the transaction client (inside BEGIN..COMMIT)", async () => {
  const pool = fakePool();
  const store = new PostgresStore(pool);
  await store.transactIdempotent("k", async (tx) => {
    await tx.put("paper-fills", "1", { status: "RECONCILED" });
    return { ok: true };
  });
  const beginAt = sqlIndex(pool.calls, "BEGIN");
  const writeAt = sqlIndex(pool.calls, "INSERT INTO trading_state");
  const commitAt = sqlIndex(pool.calls, "COMMIT");
  assert.ok(beginAt >= 0 && beginAt < writeAt && writeAt < commitAt, "write must be transactional");
  assert.deepEqual(pool.committed.get("paper-fills:1"), { status: "RECONCILED" });
});

test("H3: a failing operation rolls back its writes and records no idempotency key", async () => {
  const pool = fakePool();
  const store = new PostgresStore(pool);
  await assert.rejects(
    store.transactIdempotent("k", async (tx) => {
      await tx.put("paper-fills", "1", { status: "RECONCILED" });
      throw new Error("boom");
    }),
    /boom/
  );
  assert.ok(pool.calls.some(([sql]) => sql === "ROLLBACK"));
  assert.equal(pool.committed.has("paper-fills:1"), false);
  assert.ok(!pool.calls.some(([sql]) => sql.includes("INSERT INTO trading_idempotency")));
});

test("an operation returning undefined is refused explicitly (no opaque NOT NULL failure)", async () => {
  const pool = fakePool();
  const store = new PostgresStore(pool);
  await assert.rejects(store.transactIdempotent("k", async () => undefined), /must return a result/);
  assert.ok(!pool.calls.some(([sql]) => sql.includes("INSERT INTO trading_idempotency")));
});

test("PersistentPaperEngine writes its fill through the transaction handle", async () => {
  const { PersistentPaperEngine } = await import("../src/execution/paper-persistent.js");
  const { createRiskConfig, evaluateRiskGate } = await import("../src/risk/gate.js");
  const pool = fakePool();
  const store = new PostgresStore(pool);
  const engine = new PersistentPaperEngine(store);
  const p = { equity: 10000, cash: 10000, positions: [], grossExposure: 0, netExposure: 0, dailyPnl: 0, drawdown: 0 };
  const { config, hash } = createRiskConfig({
    version: "wsa-pg", maxPositionNotional: 100000, maxGrossExposure: 100000,
    maxDailyLoss: 1000, maxDrawdown: 0.5, maxLeverage: 10
  });
  const order = { id: "1", idempotencyKey: "x", side: "BUY", symbol: "BTC", quantity: 1 };
  const verdict = evaluateRiskGate({ order: { symbol: "BTC", side: "BUY", quantity: 1, price: 100 }, portfolio: p, riskConfig: config, approvedConfigHash: hash });
  const fill = await engine.submit(order, { markPrice: 100, gateArtifact: verdict.artifact });
  assert.equal(fill.status, "RECONCILED");
  const beginAt = sqlIndex(pool.calls, "BEGIN");
  const writeAt = sqlIndex(pool.calls, "INSERT INTO trading_state");
  const idemAt = sqlIndex(pool.calls, "INSERT INTO trading_idempotency");
  const commitAt = sqlIndex(pool.calls, "COMMIT");
  assert.ok(beginAt < writeAt && writeAt < idemAt && idemAt < commitAt, "fill and idempotency record commit together");
});
