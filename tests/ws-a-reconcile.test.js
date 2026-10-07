// WS-A [H5] Reconciliation: persistent fills must reconcile (status
// vocabulary), quantities compare float-safely, symbols case-insensitively,
// and reconciliation output must speak the shared contract vocabulary.
import test from "node:test";
import assert from "node:assert/strict";
import { reconcileOrder, requireReconciled, quantitiesMatch } from "../src/reconciliation/reconcile.js";
import { validateReconciliation, validateOrder, ExecutionTier } from "../src/contracts/index.js";
import { PersistentPaperEngine } from "../src/execution/paper-persistent.js";
import { DurableStore } from "../src/persistence/store.js";
import { createRiskConfig, evaluateRiskGate } from "../src/risk/gate.js";

function allowArtifact(order, price) {
  const p = { equity: 10000, cash: 10000, positions: [], grossExposure: 0, netExposure: 0, dailyPnl: 0, drawdown: 0 };
  const { config, hash } = createRiskConfig({
    version: "wsa-rec", maxPositionNotional: 100000, maxGrossExposure: 100000,
    maxDailyLoss: 1000, maxDrawdown: 0.5, maxLeverage: 10
  });
  const verdict = evaluateRiskGate({ order: { ...order, price }, portfolio: p, riskConfig: config, approvedConfigHash: hash });
  assert.equal(verdict.decision, "ALLOW");
  return verdict.artifact;
}

test("cross-module: persistent engine fill reconciles and passes the contract (M1 vocabulary)", async () => {
  const store = new DurableStore();
  const engine = new PersistentPaperEngine(store);
  const order = { id: "1", idempotencyKey: "r1", side: "BUY", symbol: "btc", quantity: 1 };
  const fill = await engine.submit(order, { markPrice: 100, gateArtifact: allowArtifact({ symbol: "btc", side: "BUY", quantity: 1 }, 100) });
  const result = reconcileOrder({ order, fill });
  assert.equal(result.status, "RECONCILED");
  assert.equal(requireReconciled(result), true);
  // The result passes the shared contract without translation (pre-fix this
  // threw `invalid reconciliation status`).
  assert.equal(validateReconciliation(result), true);
});

test("cross-module: one order object passes validateOrder AND engine submit", async () => {
  const store = new DurableStore();
  const engine = new PersistentPaperEngine(store);
  const order = { orderId: "o1", id: "o1", idempotencyKey: "r2", symbol: "BTCUSDT", side: "buy", quantity: 1, tier: ExecutionTier.PAPER };
  assert.equal(validateOrder(order), true);
  const fill = await engine.submit(order, { markPrice: 5, gateArtifact: allowArtifact({ symbol: "BTCUSDT", side: "buy", quantity: 1 }, 5) });
  assert.equal(fill.side, "BUY");
  const result = reconcileOrder({ order, fill });
  assert.equal(result.status, "RECONCILED");
});

test("symbol case and whitespace mismatches reconcile (pre-fix btcusdt vs BTCUSDT was UNRESOLVED)", () => {
  const order = { symbol: " btcusdt ", side: "buy", quantity: 1 };
  const fill = { symbol: "BTCUSDT", side: "BUY", quantity: 1, status: "FILLED" };
  assert.equal(reconcileOrder({ order, fill }).status, "RECONCILED");
});

test("float quantities compare with an epsilon (0.1+0.2 vs 0.3)", () => {
  const order = { symbol: "BTC", side: "BUY", quantity: 0.1 + 0.2 };
  const fill = { symbol: "BTC", side: "BUY", quantity: 0.3, status: "FILLED" };
  assert.equal(reconcileOrder({ order, fill }).status, "RECONCILED");
  assert.equal(quantitiesMatch(0.1 + 0.2, 0.3), true);
  // Genuine mismatches still fail.
  assert.equal(quantitiesMatch(1, 1.1), false);
  const bad = reconcileOrder({ order, fill: { ...fill, quantity: 0.4 } });
  assert.equal(bad.status, "UNRESOLVED");
  assert.deepEqual(bad.reasons, ["ORDER_FILL_MISMATCH"]);
});

test("filledQuantity drives the comparison for partial fills", () => {
  const order = { symbol: "BTC", side: "BUY", quantity: 1 };
  const partialFull = { symbol: "BTC", side: "BUY", quantity: 0.4, filledQuantity: 1, status: "PARTIALLY_FILLED" };
  assert.equal(reconcileOrder({ order, fill: partialFull }).status, "RECONCILED");
  const partialOpen = { symbol: "BTC", side: "BUY", quantity: 0.4, filledQuantity: 0.4, status: "PARTIALLY_FILLED" };
  assert.equal(reconcileOrder({ order, fill: partialOpen }).status, "UNRESOLVED");
});

test("RECONCILED is a settled fill status (durable tier)", () => {
  const order = { symbol: "BTC", side: "SELL", quantity: 2 };
  const fill = { symbol: "BTC", side: "SELL", quantity: 2, filledQuantity: 2, status: "RECONCILED" };
  assert.equal(reconcileOrder({ order, fill }).status, "RECONCILED");
});

test("genuine mismatches stay unresolved and block execution", () => {
  const order = { symbol: "BTC", side: "BUY", quantity: 1 };
  const wrongSide = reconcileOrder({ order, fill: { symbol: "BTC", side: "SELL", quantity: 1, status: "FILLED" } });
  assert.equal(wrongSide.status, "UNRESOLVED");
  assert.throws(() => requireReconciled(wrongSide), /not reconciled/);
  assert.throws(() => validateReconciliation(wrongSide), /blocks execution/);
  assert.equal(reconcileOrder({ order }).status, "UNRESOLVED");
});

test("contract reconciliation vocabulary crosswalk is explicit", () => {
  assert.equal(validateReconciliation({ status: "matched" }), true);
  assert.equal(validateReconciliation({ status: "RECONCILED" }), true);
  assert.throws(() => validateReconciliation({ status: "mismatch" }), /blocks execution/);
  assert.throws(() => validateReconciliation({ status: "MISMATCH" }), /blocks execution/);
  assert.throws(() => validateReconciliation({ status: "UNRESOLVED" }), /blocks execution/);
  assert.throws(() => validateReconciliation({ status: "unknown" }), /blocks execution/);
  assert.throws(() => validateReconciliation({ status: "something-else" }), /invalid reconciliation status/);
});
