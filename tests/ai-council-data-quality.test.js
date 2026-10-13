// tests/ai-council-data-quality.test.js — missing market inputs must stay unknown.
import test from "node:test";
import assert from "node:assert/strict";
import { computeAiCouncil } from "../server/ai.js";

function sampleCandles() {
  return Array.from({length: 80}, (_, i) => {
    const close = 100 + i * 0.1;
    return {
      ts: 1_700_000_000_000 + i * 3_600_000,
      open: close - 0.1,
      high: close + 1,
      low: close - 1,
      close,
      volume: 100
    };
  });
}

function councilFor(ticker) {
  return computeAiCouncil({
    ticker: {symbol: "BTCUSDT", ...ticker},
    candles: sampleCandles(),
    portfolio: {drawdown: 0, grossExposure: 0},
    limits: {ok: true, reasons: []}
  });
}

test("missing liquidity and momentum inputs are unknown and fail closed", () => {
  const council = councilFor({quoteVolume24h: null, changePct24h: undefined});
  const liquidity = council.roles.find((role) => role.role === "Liquidity proxy");
  const momentum = council.roles.find((role) => role.role === "24h momentum proxy");

  assert.equal(liquidity.displayStatus, "VOLUME UNKNOWN");
  assert.equal(liquidity.status, "VOLUME_UNKNOWN");
  assert.equal(liquidity.score, null);
  assert.match(liquidity.reason, /unavailable or invalid/i);

  assert.equal(momentum.displayStatus, "MOMENTUM UNKNOWN");
  assert.equal(momentum.status, "MOMENTUM_UNKNOWN");
  assert.equal(momentum.score, null);
  assert.match(momentum.reason, /unavailable or invalid/i);
  assert.equal(council.decision, "WAIT");
});

test("non-finite market values are not treated as neutral or flat", () => {
  const council = councilFor({quoteVolume24h: Number.NaN, changePct24h: Number.NaN});
  const liquidity = council.roles.find((role) => role.role === "Liquidity proxy");
  const momentum = council.roles.find((role) => role.role === "24h momentum proxy");

  assert.equal(liquidity.displayStatus, "VOLUME UNKNOWN");
  assert.equal(liquidity.score, null);
  assert.equal(momentum.displayStatus, "MOMENTUM UNKNOWN");
  assert.equal(momentum.status, "MOMENTUM_UNKNOWN");
  assert.equal(momentum.score, null);
  assert.equal(council.decision, "WAIT");
});

test("valid zero readings remain distinct from missing data", () => {
  const council = councilFor({quoteVolume24h: 0, changePct24h: 0});
  const liquidity = council.roles.find((role) => role.role === "Liquidity proxy");
  const momentum = council.roles.find((role) => role.role === "24h momentum proxy");

  assert.equal(liquidity.displayStatus, "LOW VOLUME");
  assert.equal(liquidity.status, "LOW_VOLUME");
  assert.equal(liquidity.score, 40);
  assert.equal(momentum.displayStatus, "FLAT CHANGE");
  assert.equal(momentum.status, "FLAT_CHANGE");
  assert.equal(momentum.score, 50);
});
