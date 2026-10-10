import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PAPER_FEE_RATE,
  DEFAULT_PAPER_SLIPPAGE_BPS,
  estimateMarketExecution,
  paperExecutionCostConfigFromEnv,
  validatePaperExecutionCostConfig
} from "../src/execution/costs.js";

test("paper execution cost defaults are deterministic and configurable", () => {
  assert.deepEqual(validatePaperExecutionCostConfig(), {
    feeRate: DEFAULT_PAPER_FEE_RATE,
    slippageBps: DEFAULT_PAPER_SLIPPAGE_BPS
  });
  assert.deepEqual(validatePaperExecutionCostConfig({feeRate: 0.002, slippageBps: 12}), {
    feeRate: 0.002,
    slippageBps: 12
  });
  assert.deepEqual(paperExecutionCostConfigFromEnv({
    NOVA_PAPER_FEE_RATE: "0.0015",
    NOVA_PAPER_SLIPPAGE_BPS: "8"
  }), {feeRate: 0.0015, slippageBps: 8});
  assert.throws(() => paperExecutionCostConfigFromEnv({NOVA_PAPER_FEE_RATE: "NaN"}), /NOVA_PAPER_FEE_RATE/);
  assert.throws(() => paperExecutionCostConfigFromEnv({NOVA_PAPER_FEE_RATE: ""}), /non-empty number/);
  assert.throws(() => paperExecutionCostConfigFromEnv({NOVA_PAPER_SLIPPAGE_BPS: "1.5"}), /slippage/);
});

test("BUY paper fills cross ask and apply configured slippage and fee", () => {
  const result = estimateMarketExecution({
    side: "BUY",
    quantity: 2,
    last: 100,
    bid: 99.9,
    ask: 100.1,
    feeRate: 0.001,
    slippageBps: 10
  });
  assert.equal(result.referencePrice, 100);
  assert.equal(result.quotePrice, 100.1);
  assert.ok(Math.abs(result.executionPrice - 100.2001) < 1e-10);
  assert.ok(Math.abs(result.notional - 200.4002) < 1e-9);
  assert.ok(Math.abs(result.fee - 0.2004002) < 1e-10);
  assert.equal(result.feeRate, 0.001);
  assert.equal(result.slippageBps, 10);
  assert.ok(result.spreadBps > 0);
  assert.ok(result.spreadCost > 0);
  assert.ok(result.slippageCost > 0);
});

test("SELL paper fills cross bid and apply slippage and fee", () => {
  const result = estimateMarketExecution({
    side: "sell",
    quantity: 2,
    last: 100,
    bid: 99.9,
    ask: 100.1,
    feeRate: 0.001,
    slippageBps: 10
  });
  assert.equal(result.quotePrice, 99.9);
  assert.ok(Math.abs(result.executionPrice - 99.8001) < 1e-10);
  assert.ok(Math.abs(result.notional - 199.6002) < 1e-9);
  assert.ok(Math.abs(result.fee - 0.1996002) < 1e-10);
});

test("paper execution fails closed on missing or crossed quotes and invalid costs", () => {
  const base = {side: "BUY", quantity: 1, last: 100, bid: 99, ask: 101};
  assert.throws(() => estimateMarketExecution({...base, bid: undefined}), /positive finite/);
  assert.throws(() => estimateMarketExecution({...base, bid: 102, ask: 101}), /crossed/);
  assert.throws(() => estimateMarketExecution({...base, side: "HOLD"}), /side/);
  assert.throws(() => estimateMarketExecution({...base, quantity: Infinity}), /quantity/);
  assert.throws(() => validatePaperExecutionCostConfig({feeRate: -0.01}), /fee rate/);
  assert.throws(() => validatePaperExecutionCostConfig({feeRate: 0.06}), /fee rate/);
  assert.throws(() => validatePaperExecutionCostConfig({slippageBps: -1}), /slippage/);
  assert.throws(() => validatePaperExecutionCostConfig({slippageBps: 1001}), /slippage/);
});
