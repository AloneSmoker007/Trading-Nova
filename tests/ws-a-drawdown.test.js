// WS-A [H1] MAX_DRAWDOWN must be computed from PEAK (high-water mark) equity,
// not starting equity. Before the fix an account that peaked at 20k and fell to
// 11k (45% from peak) reported drawdown 0 and the gate returned ALLOW.
import test from "node:test";
import assert from "node:assert/strict";
import { buildPortfolioState } from "../src/risk/portfolio.js";
import { createRiskConfig, evaluateRiskGate } from "../src/risk/gate.js";

function cfg(overrides = {}) {
  return createRiskConfig({
    version: "wsa-dd", maxPositionNotional: 100000, maxGrossExposure: 100000,
    maxDailyLoss: 100000, maxDrawdown: 0.1, maxLeverage: 100, ...overrides
  });
}

const ORDER = { symbol: "BTC", side: "BUY", quantity: 1, price: 100 };

test("45%-from-peak drawdown is refused against a 10% limit", () => {
  // Started at 10,000, peaked at 20,000, now 11,000 → true drawdown 45%.
  const p = buildPortfolioState({ cash: 11000, startingEquity: 10000, peakEquity: 20000 });
  assert.equal(p.peakEquity, 20000);
  assert.ok(Math.abs(p.drawdown - 0.45) < 1e-12);
  const { config, hash } = cfg();
  const verdict = evaluateRiskGate({ order: ORDER, portfolio: p, riskConfig: config, approvedConfigHash: hash });
  assert.equal(verdict.decision, "NO_TRADE");
  assert.ok(verdict.reasons.includes("MAX_DRAWDOWN"));
  // Refused orders issue no execution artifact.
  assert.equal(verdict.artifact, undefined);
});

test("pre-fix behavior was inert: the same account without peak tracking ALLOWED", () => {
  // The old formula measured from STARTING equity: (10000-11000)/10000 → 0.
  const stale = { equity: 11000, cash: 11000, positions: [], grossExposure: 0, netExposure: 0, dailyPnl: 0, drawdown: 0 };
  const { config, hash } = cfg();
  const verdict = evaluateRiskGate({ order: ORDER, portfolio: stale, riskConfig: config, approvedConfigHash: hash });
  assert.equal(verdict.decision, "ALLOW");
  // But as soon as the high-water mark is known the same account is stopped.
  const aware = { ...stale, peakEquity: 20000 };
  const blocked = evaluateRiskGate({ order: ORDER, portfolio: aware, riskConfig: config, approvedConfigHash: hash });
  assert.equal(blocked.decision, "NO_TRADE");
  assert.ok(blocked.reasons.includes("MAX_DRAWDOWN"));
});

test("a new equity high raises the peak and resets drawdown to zero", () => {
  const p = buildPortfolioState({ cash: 21000, startingEquity: 10000, peakEquity: 20000 });
  assert.equal(p.peakEquity, 21000);
  assert.equal(p.drawdown, 0);
});

test("without an explicit peak, starting equity remains the high-water mark", () => {
  const down = buildPortfolioState({ cash: 9000, startingEquity: 10000 });
  assert.equal(down.peakEquity, 10000);
  assert.ok(Math.abs(down.drawdown - 0.1) < 1e-12);
  const up = buildPortfolioState({ cash: 12000, startingEquity: 10000 });
  assert.equal(up.drawdown, 0);
});

test("drawdown exactly at the limit is a breach (boundary semantics preserved)", () => {
  // 20,000 peak → 18,000 equity = exactly 10% drawdown = breach at >= limit.
  const p = buildPortfolioState({ cash: 18000, startingEquity: 18000, peakEquity: 20000 });
  assert.ok(Math.abs(p.drawdown - 0.1) < 1e-12);
  const { config, hash } = cfg();
  const verdict = evaluateRiskGate({ order: ORDER, portfolio: p, riskConfig: config, approvedConfigHash: hash });
  assert.equal(verdict.decision, "NO_TRADE");
  assert.ok(verdict.reasons.includes("MAX_DRAWDOWN"));
});

test("peak-based drawdown also applies to raw portfolio states with positions", () => {
  const p = {
    equity: 11000, cash: 11000, positions: [], grossExposure: 0, netExposure: 0,
    dailyPnl: -9000, drawdown: 0, peakEquity: 20000
  };
  const { config, hash } = cfg({ maxDailyLoss: 100000 });
  const verdict = evaluateRiskGate({ order: ORDER, portfolio: p, riskConfig: config, approvedConfigHash: hash });
  assert.equal(verdict.decision, "NO_TRADE");
  assert.ok(verdict.reasons.includes("MAX_DRAWDOWN"));
  // The reported figure is the worse of reported vs from-peak.
  assert.ok(Math.abs(verdict.drawdown - 0.45) < 1e-12);
});

test("the gate never under-reports: reported drawdown is kept when it is worse", () => {
  const p = {
    equity: 10000, cash: 10000, positions: [], grossExposure: 0, netExposure: 0,
    dailyPnl: 0, drawdown: 0.5, peakEquity: 10000
  };
  const { config, hash } = cfg();
  const verdict = evaluateRiskGate({ order: ORDER, portfolio: p, riskConfig: config, approvedConfigHash: hash });
  assert.equal(verdict.decision, "NO_TRADE");
  assert.ok(verdict.reasons.includes("MAX_DRAWDOWN"));
  assert.equal(verdict.drawdown, 0.5);
});
