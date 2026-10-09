// WS-A [C1b/H2] Risk Gate enforcement on the order path: both execution
// engines must REFUSE any order without a genuine evaluateRiskGate ALLOW
// artifact bound to the order payload hash + approved config hash. No bypass.
import test from "node:test";
import assert from "node:assert/strict";
import { createPaperExecution } from "../src/execution/paper.js";
import { PersistentPaperEngine } from "../src/execution/paper-persistent.js";
import { DurableStore } from "../src/persistence/store.js";
import { createRiskConfig, evaluateRiskGate, hashOrderPayload, hashRiskConfig } from "../src/risk/gate.js";

function portfolio(overrides = {}) {
  return { equity: 10000, cash: 10000, positions: [], grossExposure: 0, netExposure: 0, dailyPnl: 0, drawdown: 0, ...overrides };
}

function config() {
  return createRiskConfig({
    version: "wsa-gate", maxPositionNotional: 100000, maxGrossExposure: 100000,
    maxDailyLoss: 1000, maxDrawdown: 0.5, maxLeverage: 10
  });
}

function verdictFor(order, { killSwitch = false, cfg = config() } = {}) {
  return evaluateRiskGate({ order, portfolio: portfolio(), riskConfig: cfg.config, approvedConfigHash: cfg.hash, killSwitch });
}

const PAPER_ORDER = { symbol: "BTC", side: "BUY", quantity: 1, price: 100, idempotencyKey: "g1" };

test("paper engine refuses orders without a gate artifact (no bypass path)", () => {
  const ex = createPaperExecution();
  assert.throws(() => ex.submit({ ...PAPER_ORDER }), /risk gate artifact required/);
  assert.throws(() => ex.submit({ ...PAPER_ORDER }, {}), /risk gate artifact required/);
  assert.throws(() => ex.submit({ ...PAPER_ORDER }, { gateArtifact: null }), /risk gate artifact required/);
});

test("paper engine refuses forged artifacts that were never issued by the gate", () => {
  const ex = createPaperExecution();
  const { hash } = createRiskConfig({
    version: "wsa-forged", maxPositionNotional: 100000, maxGrossExposure: 100000,
    maxDailyLoss: 1000, maxDrawdown: 0.5, maxLeverage: 10
  });
  // Perfectly shaped artifact for an order the gate never allowed: it matches
  // the order hash and carries a config hash, but was never issued.
  const order = { symbol: "FAKE", side: "BUY", quantity: 3, price: 77, idempotencyKey: "forged-1" };
  const forged = { version: 1, decision: "ALLOW", orderHash: hashOrderPayload(order), configHash: hash, issuedAt: Date.now() };
  assert.throws(() => ex.submit(order, { gateArtifact: forged }), /unknown or forged/);
});

test("paper engine refuses artifacts bound to a different order payload", () => {
  const ex = createPaperExecution();
  const other = verdictFor({ symbol: "ETH", side: "BUY", quantity: 1, price: 100 });
  assert.equal(other.decision, "ALLOW");
  assert.throws(() => ex.submit({ ...PAPER_ORDER }, { gateArtifact: other.artifact }), /order hash mismatch/);
});

test("paper engine refuses artifacts bound to a different price, quantity, side or reduceOnly flag", () => {
  const ex = createPaperExecution();
  const verdict = verdictFor({ symbol: "BTC", side: "BUY", quantity: 1, price: 100 });
  assert.throws(() => ex.submit({ ...PAPER_ORDER, price: 200 }, { gateArtifact: verdict.artifact }), /order hash mismatch/);
  assert.throws(() => ex.submit({ ...PAPER_ORDER, quantity: 2 }, { gateArtifact: verdict.artifact }), /order hash mismatch/);
  assert.throws(() => ex.submit({ ...PAPER_ORDER, side: "SELL" }, { gateArtifact: verdict.artifact }), /order hash mismatch/);
  assert.throws(() => ex.submit({ ...PAPER_ORDER, reduceOnly: true }, { gateArtifact: verdict.artifact }), /order hash mismatch/);
});

test("a NO_TRADE verdict issues no artifact and executes nothing", () => {
  const ex = createPaperExecution();
  const verdict = verdictFor({ symbol: "BTC", side: "BUY", quantity: 1, price: 100 }, { killSwitch: true });
  assert.equal(verdict.decision, "NO_TRADE");
  assert.equal(verdict.artifact, undefined);
  assert.throws(() => ex.submit({ ...PAPER_ORDER }, { gateArtifact: verdict.artifact }), /risk gate artifact required/);
});

test("genuine ALLOW artifacts execute and are bound to the approved config hash", () => {
  const ex = createPaperExecution();
  const cfg = config();
  const verdict = verdictFor({ symbol: "BTC", side: "BUY", quantity: 1, price: 100 }, { cfg });
  assert.equal(verdict.decision, "ALLOW");
  assert.equal(verdict.artifact.configHash, hashRiskConfig(cfg.config));
  assert.equal(verdict.artifact.orderHash, hashOrderPayload({ symbol: "BTC", side: "BUY", quantity: 1, price: 100 }));
  const fill = ex.submit({ ...PAPER_ORDER }, { gateArtifact: verdict.artifact });
  assert.equal(fill.status, "FILLED");
  assert.equal(fill.symbol, "BTC");
});

test("case differences cannot dodge the binding: verdict for btc/buy authorizes BTC/BUY", () => {
  const ex = createPaperExecution();
  const verdict = verdictFor({ symbol: "btc", side: "buy", quantity: 1, price: 100 });
  assert.equal(verdict.decision, "ALLOW");
  const fill = ex.submit({ symbol: "BTC", side: "BUY", quantity: 1, price: 100 }, { gateArtifact: verdict.artifact });
  assert.equal(fill.status, "FILLED");
});

test("persistent engine refuses orders without a gate artifact and writes nothing", async () => {
  const store = new DurableStore();
  const engine = new PersistentPaperEngine(store);
  const order = { id: "1", idempotencyKey: "p1", side: "BUY", symbol: "BTC", quantity: 1 };
  await assert.rejects(engine.submit(order, { markPrice: 100 }), /risk gate artifact required/);
  await assert.rejects(engine.submit(order, { markPrice: 100, gateArtifact: { decision: "ALLOW" } }), /risk gate artifact invalid/);
  // Absolutely nothing was written by the refused submissions.
  assert.deepEqual(Object.keys(store.snapshot().state), []);
  assert.deepEqual(Object.keys(store.snapshot().idempotency), []);
});

test("persistent engine binds the artifact to the executed mark price", async () => {
  const store = new DurableStore();
  const engine = new PersistentPaperEngine(store);
  const order = { id: "1", idempotencyKey: "p2", side: "BUY", symbol: "BTC", quantity: 1 };
  const verdict = verdictFor({ symbol: "BTC", side: "BUY", quantity: 1, price: 100 });
  await assert.rejects(engine.submit(order, { markPrice: 200, gateArtifact: verdict.artifact }), /order hash mismatch/);
  const fill = await engine.submit(order, { markPrice: 100, gateArtifact: verdict.artifact });
  assert.equal(fill.price, 100);
});

test("idempotent replay of an executed order returns the recorded fill; new orders still need the gate", async () => {
  const store = new DurableStore();
  const engine = new PersistentPaperEngine(store);
  const order = { id: "1", idempotencyKey: "p3", side: "BUY", symbol: "BTC", quantity: 1 };
  const verdict = verdictFor({ symbol: "BTC", side: "BUY", quantity: 1, price: 100 });
  const first = await engine.submit(order, { markPrice: 100, gateArtifact: verdict.artifact });
  // Replay of the SAME executed order: no new execution happens, the recorded
  // fill is returned even without re-presenting the artifact.
  const replay = await engine.submit({ ...order, id: "2" }, { markPrice: 100 });
  assert.deepEqual(replay, first);
  // A DIFFERENT order under the same key is a caller bug and always refused.
  await assert.rejects(
    engine.submit({ ...order, id: "3", quantity: 5 }, { markPrice: 100 }),
    /idempotency_key_reuse_with_different_payload/
  );
});

test("paper engine refuses idempotency key reuse with a different payload", () => {
  const ex = createPaperExecution();
  const verdict = verdictFor({ symbol: "BTC", side: "BUY", quantity: 1, price: 100 });
  ex.submit({ ...PAPER_ORDER }, { gateArtifact: verdict.artifact });
  assert.throws(
    () => ex.submit({ ...PAPER_ORDER, symbol: "ETH" }, { gateArtifact: verdict.artifact }),
    /idempotency_key_reuse_with_different_payload/
  );
});

test("every engine order corresponds to a gate-evaluable order object (contract parity)", async () => {
  const { validateOrder, ExecutionTier } = await import("../src/contracts/index.js");
  const ex = createPaperExecution();
  const order = { orderId: "o1", symbol: "btcusdt", side: "buy", quantity: 1, price: 100, tier: ExecutionTier.PAPER };
  // One and the same order object passes the shared contract...
  assert.equal(validateOrder(order), true);
  // ...and the engine (via a genuine gate verdict for the same payload).
  const verdict = verdictFor({ symbol: order.symbol, side: order.side, quantity: order.quantity, price: order.price });
  assert.equal(verdict.decision, "ALLOW");
  const fill = ex.submit(order, { gateArtifact: verdict.artifact });
  assert.equal(fill.symbol, "BTCUSDT");
  assert.equal(fill.side, "BUY");
});


test("in-memory paper execution fails closed at capacity without evicting replay keys", () => {
  const ex = createPaperExecution({maxOrders:1});
  const order = {...PAPER_ORDER, idempotencyKey:"capacity-first"};
  const verdict = verdictFor({symbol:order.symbol,side:order.side,quantity:order.quantity,price:order.price});
  const first = ex.submit(order, {gateArtifact:verdict.artifact});

  // Replays remain safe and available at capacity.
  assert.deepEqual(ex.submit(order, {}), first);

  const secondOrder = {...PAPER_ORDER, idempotencyKey:"capacity-second", symbol:"ETH"};
  const secondVerdict = verdictFor({symbol:secondOrder.symbol,side:secondOrder.side,quantity:secondOrder.quantity,price:secondOrder.price});
  assert.throws(() => ex.submit(secondOrder, {gateArtifact:secondVerdict.artifact}), /paper_execution_capacity_reached/);
  assert.deepEqual(ex.get(first.id), first);
});

test("in-memory paper execution capacity must be a positive safe integer", () => {
  assert.throws(() => createPaperExecution({maxOrders:0}), /maxOrders/);
  assert.throws(() => createPaperExecution({maxOrders:1.5}), /maxOrders/);
});
