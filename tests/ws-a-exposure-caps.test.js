// WS-A [H4] MAX_POSITION / MAX_CONCENTRATION must bound the RESULTING
// per-symbol exposure (open + new), not the single order's notional. Before
// the fix, two 900 orders sailed through a 1000 limit (scale-in bypass).
import test from "node:test";
import assert from "node:assert/strict";
import { buildPortfolioState } from "../src/risk/portfolio.js";
import { createRiskConfig, evaluateRiskGate } from "../src/risk/gate.js";

function portfolio(positions = []) {
  return buildPortfolioState({ cash: 100000, positions, startingEquity: 100000 });
}

function cfg(overrides = {}) {
  return createRiskConfig({
    version: "wsa-exp", maxPositionNotional: 1000, maxGrossExposure: 100000,
    maxDailyLoss: 100000, maxDrawdown: 0.9, maxLeverage: 100, ...overrides
  });
}

test("2x900 is refused against a 1000 limit: caps see open + new exposure", () => {
  const { config, hash } = cfg();
  // First 900 order fits.
  const first = evaluateRiskGate({
    order: { symbol: "BTC", side: "BUY", quantity: 1, price: 900 },
    portfolio: portfolio(), riskConfig: config, approvedConfigHash: hash
  });
  assert.equal(first.decision, "ALLOW");
  assert.equal(first.projectedSymbolExposure, 900);
  // After it fills, the second 900 order would leave 1800 exposure → refused.
  const second = evaluateRiskGate({
    order: { symbol: "BTC", side: "BUY", quantity: 1, price: 900 },
    portfolio: portfolio([{ symbol: "BTC", quantity: 1, markPrice: 900 }]),
    riskConfig: config, approvedConfigHash: hash
  });
  assert.equal(second.decision, "NO_TRADE");
  assert.ok(second.reasons.includes("MAX_POSITION"));
  assert.equal(second.projectedSymbolExposure, 1800);
});

test("a single order at the cap is allowed, one tick above is refused", () => {
  const { config, hash } = cfg();
  const atCap = evaluateRiskGate({
    order: { symbol: "BTC", side: "BUY", quantity: 10, price: 10 },
    portfolio: portfolio([{ symbol: "BTC", quantity: 90, markPrice: 10 }]),
    riskConfig: config, approvedConfigHash: hash
  });
  assert.equal(atCap.decision, "ALLOW");
  assert.equal(atCap.projectedSymbolExposure, 1000);
  const overCap = evaluateRiskGate({
    order: { symbol: "BTC", side: "BUY", quantity: 10.01, price: 10 },
    portfolio: portfolio([{ symbol: "BTC", quantity: 90, markPrice: 10 }]),
    riskConfig: config, approvedConfigHash: hash
  });
  assert.equal(overCap.decision, "NO_TRADE");
  assert.ok(overCap.reasons.includes("MAX_POSITION"));
});

test("MAX_CONCENTRATION binds the resulting per-symbol exposure too", () => {
  const { config, hash } = cfg({ maxPositionNotional: 100000, maxConcentrationNotional: 1000 });
  // 600 open + 500 new = 1100 > 1000 concentration cap.
  const verdict = evaluateRiskGate({
    order: { symbol: "BTC", side: "BUY", quantity: 5, price: 100 },
    portfolio: portfolio([{ symbol: "BTC", quantity: 6, markPrice: 100 }]),
    riskConfig: config, approvedConfigHash: hash
  });
  assert.equal(verdict.decision, "NO_TRADE");
  assert.ok(verdict.reasons.includes("MAX_CONCENTRATION"));
});

test("exposure is per symbol: other symbols do not consume the cap", () => {
  const { config, hash } = cfg();
  const verdict = evaluateRiskGate({
    order: { symbol: "ETH", side: "BUY", quantity: 1, price: 900 },
    portfolio: portfolio([{ symbol: "BTC", quantity: 1, markPrice: 900 }]),
    riskConfig: config, approvedConfigHash: hash
  });
  assert.equal(verdict.decision, "ALLOW");
  assert.equal(verdict.projectedSymbolExposure, 900);
});

test("short exposure counts toward the cap", () => {
  const { config, hash } = cfg();
  const verdict = evaluateRiskGate({
    order: { symbol: "BTC", side: "SELL", quantity: 1, price: 900 },
    portfolio: portfolio([{ symbol: "BTC", quantity: -1, markPrice: 900 }]),
    riskConfig: config, approvedConfigHash: hash
  });
  // -1 open + 1 more short = 1800 gross symbol exposure → refused.
  assert.equal(verdict.decision, "NO_TRADE");
  assert.ok(verdict.reasons.includes("MAX_POSITION"));
});

test("caps are tenant/user scoped: another user's positions never count", () => {
  const { config, hash } = cfg();
  const p = buildPortfolioState({
    cash: 100000,
    positions: [
      { symbol: "BTC", quantity: 5, markPrice: 900, userId: "user-a" },
      { symbol: "BTC", quantity: 1, markPrice: 900, userId: "user-b" }
    ],
    startingEquity: 100000
  });
  // user-b: 900 open + 500 new = 1400 > 1000 → refused for user-b...
  const forB = evaluateRiskGate({
    order: { symbol: "BTC", side: "BUY", quantity: 1, price: 500, userId: "user-b" },
    portfolio: p, riskConfig: config, approvedConfigHash: hash
  });
  assert.equal(forB.decision, "NO_TRADE");
  assert.ok(forB.reasons.includes("MAX_POSITION"));
  // ...while user-c's exposure never includes user-a's or user-b's book.
  const forC = evaluateRiskGate({
    order: { symbol: "BTC", side: "BUY", quantity: 1, price: 900, userId: "user-c" },
    portfolio: p, riskConfig: config, approvedConfigHash: hash
  });
  assert.equal(forC.projectedSymbolExposure, 900);
  assert.equal(forC.decision, "ALLOW");
});

test("reduce-only orders remain exempt from the exposure caps", () => {
  const { config, hash } = cfg();
  const verdict = evaluateRiskGate({
    order: { symbol: "BTC", side: "SELL", quantity: 1, price: 900, reduceOnly: true },
    portfolio: portfolio([{ symbol: "BTC", quantity: 2, markPrice: 900 }]),
    riskConfig: config, approvedConfigHash: hash
  });
  assert.equal(verdict.decision, "ALLOW");
  assert.equal(verdict.validReduction, true);
});
