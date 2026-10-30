import test from "node:test";
import assert from "node:assert/strict";
import {DurableStore} from "../src/persistence/store.js";
import {PersistentPaperEngine} from "../src/execution/paper-persistent.js";
import {createRiskConfig, evaluateRiskGate} from "../src/risk/gate.js";
import {derivePaperOutcomes} from "../src/journal/outcomes.js";

function submit(engine, id, side = "BUY", onFill) {
  const order = {symbol: "BTCUSDT", side, price: 100, quantity: 1, idempotencyKey: id, executionSequence: 999};
  const cfg = createRiskConfig({version: "sequence", maxPositionNotional: 100000, maxGrossExposure: 100000,
    maxDailyLoss: 1000, maxDrawdown: 0.5, maxLeverage: 10});
  const verdict = evaluateRiskGate({order, riskConfig: cfg.config, approvedConfigHash: cfg.hash,
    portfolio: {equity: 10000, cash: 10000, positions: [], grossExposure: 0, netExposure: 0, dailyPnl: 0, drawdown: 0}});
  assert.equal(verdict.decision, "ALLOW");
  return engine.submit(order, {markPrice: 100, gateArtifact: verdict.artifact, onFill});
}

test("new fills get atomic durable sequence, replay/restart keep it and equal-time outcomes use it", async () => {
  const store = new DurableStore(), engine = new PersistentPaperEngine(store);
  const original = Date.now;
  Date.now = () => 1234;
  try {
    const first = await submit(engine, "z-open");
    const second = await submit(engine, "a-close", "SELL");
    assert.equal(first.executionSequence, 1);
    assert.equal(second.executionSequence, 2);
    assert.equal(first.sequenceVersion, 1);
    assert.equal(first.timestamp, second.timestamp);
    const restored = new DurableStore(); restored.restore(store.snapshot());
    assert.deepEqual(await submit(new PersistentPaperEngine(restored), "z-open"), first);
    assert.equal((await submit(new PersistentPaperEngine(restored), "third")).executionSequence, 3);
    const report = derivePaperOutcomes([second, first]);
    assert.equal(report.outcomes[0].openingOrderId, "z-open");
    assert.equal(report.outcomes[0].direction, "LONG");
  } finally {Date.now = original;}
});

test("failed fill rolls counter back; concurrent submissions allocate distinct sequences; forged gates allocate nothing", async () => {
  const store = new DurableStore(), engine = new PersistentPaperEngine(store);
  await assert.rejects(submit(engine, "rollback", "BUY", async () => {throw new Error("injected failure");}), /injected failure/);
  assert.equal(store.get("paper-sequence", "global"), null);
  assert.equal(store.get("paper-fills", "rollback"), null);
  const fills = await Promise.all(Array.from({length: 8}, (_, i) => submit(engine, "concurrent-" + i)));
  assert.deepEqual(fills.map(f => f.executionSequence).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  await assert.rejects(engine.submit({symbol: "BTCUSDT", side: "BUY", quantity: 1, idempotencyKey: "forged"}, {markPrice: 100}), /gate artifact/);
  assert.equal(store.get("paper-sequence", "global").last, 8);
});

test("invalid counters, malformed sequences, duplicates, mixed legacy ties and clock reversals fail closed", async () => {
  for (const last of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    const store = new DurableStore(); store.put("paper-sequence", "global", {version: 1, last});
    await assert.rejects(submit(new PersistentPaperEngine(store), "bad-counter"), /invalid paper execution sequence/);
    assert.equal(store.get("paper-fills", "bad-counter"), null);
  }
  const store = new DurableStore(), engine = new PersistentPaperEngine(store);
  const a = {...await submit(engine, "open"), timestamp: 1};
  const b = {...await submit(engine, "close", "SELL"), timestamp: 1};
  for (const pair of [[a, {...b, executionSequence: 1}], [a, {...b, sequenceVersion: 2}],
    [a, {...b, executionSequence: undefined, sequenceVersion: undefined}],
    [{...a, timestamp: 2}, {...b, timestamp: 1}]]) assert.throws(() => derivePaperOutcomes(pair), /sequence|chronology/);
});
