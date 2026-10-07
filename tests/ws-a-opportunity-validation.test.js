// WS-A medium items — opportunity input validation (L8): garbage input must
// never coerce into ENTER ("80" strings, unknown uncertainty labels, negative
// sample sizes). Missing/unknown uncertainty fails closed to WAIT.
import test from "node:test";
import assert from "node:assert/strict";
import { buildOpportunity } from "../src/opportunity/engine.js";

test("valid opportunity keeps its shape and ENTER semantics", () => {
  const a = buildOpportunity({ symbol: "BTCUSDT", side: "LONG", score: 83, evidence: { uncertainty: "Medium" }, sampleSize: 50, calibratedProbability: 0.9 });
  assert.equal(a.opportunityScore, 83);
  assert.equal(a.calibratedProbability, null); // below the 200-sample threshold
  assert.equal(a.uncertainty, "Medium");
  assert.equal(a.decision, "ENTER");
});

test("numeric-string scores are rejected, never coerced", () => {
  assert.throws(() => buildOpportunity({ symbol: "BTC", side: "LONG", score: "80", evidence: { uncertainty: "Low" } }), /invalid opportunity score/);
  assert.throws(() => buildOpportunity({ symbol: "BTC", side: "LONG", score: NaN }), /invalid opportunity score/);
  assert.throws(() => buildOpportunity({ symbol: "BTC", side: "LONG", score: 101 }), /invalid opportunity score/);
  assert.throws(() => buildOpportunity({ symbol: "BTC", side: "LONG", score: -1 }), /invalid opportunity score/);
});

test("uncertainty is allowlisted: unknown labels cannot unlock ENTER", () => {
  assert.throws(() => buildOpportunity({ symbol: "BTC", side: "LONG", score: 90, evidence: { uncertainty: "kinda" } }), /invalid opportunity uncertainty/);
  // Missing uncertainty fails closed to High -> WAIT even at a top score.
  const missing = buildOpportunity({ symbol: "BTC", side: "LONG", score: 99 });
  assert.equal(missing.uncertainty, "High");
  assert.equal(missing.decision, "WAIT");
  // Explicit High stays WAIT.
  const high = buildOpportunity({ symbol: "BTC", side: "LONG", score: 99, evidence: { uncertainty: "High" } });
  assert.equal(high.decision, "WAIT");
});

test("sample size and calibrated probability are validated", () => {
  assert.throws(() => buildOpportunity({ symbol: "BTC", side: "LONG", score: 50, sampleSize: -1 }), /sample size/);
  assert.throws(() => buildOpportunity({ symbol: "BTC", side: "LONG", score: 50, sampleSize: 2.5 }), /sample size/);
  assert.throws(() => buildOpportunity({ symbol: "BTC", side: "LONG", score: 50, calibratedProbability: 1.5 }), /calibrated probability/);
  const mature = buildOpportunity({ symbol: "BTC", side: "SHORT", score: 60, evidence: { uncertainty: "Low" }, sampleSize: 200, calibratedProbability: 0.42 });
  assert.equal(mature.calibratedProbability, 0.42);
});

test("conflicts must be an array; malformed evidence is refused", () => {
  assert.throws(() => buildOpportunity({ symbol: "BTC", side: "LONG", score: 50, evidence: { uncertainty: "Low", conflicts: "x" } }), /conflicts/);
  assert.throws(() => buildOpportunity({ symbol: "BTC", side: "LONG", score: 50, evidence: "garbage" }), /evidence/);
  const withConflicts = buildOpportunity({ symbol: "BTC", side: "LONG", score: 50, evidence: { uncertainty: "Low", conflicts: ["macro"] } });
  assert.deepEqual(withConflicts.conflicts, ["macro"]);
});
