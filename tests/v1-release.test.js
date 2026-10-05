import test from "node:test";
import assert from "node:assert/strict";
import { finalCertification } from "../src/governance/certification.js";
import { evaluateMarketProbe } from "../src/market-data/production-probe.js";
import { productionEnvironment } from "../src/operations/production-env.js";
import { observabilityContract } from "../src/operations/observability-contract.js";

test("V1 remains blocked without external production evidence", () => {
  const result = finalCertification({
    productionReady: false, backupVerified: false, marketProbePassed: false,
    venueConformance: false, observabilityPassed: false,
    paperShadowEvidence: false, humanApproval: false
  });
  assert.equal(result.certified, false);
  assert.equal(result.tier, "NOT_CERTIFIED");
});

test("production environment gate fails closed when evidence is absent", () => {
  const result = productionEnvironment({});
  assert.equal(result.ready, false);
  assert.ok(result.missing.length >= 4);
});

test("market probe requires every critical health condition", () => {
  assert.equal(evaluateMarketProbe({
    connected: true, fresh: true, sequenceHealthy: true, gapRecovered: true, latencyMs: 50
  }).passed, true);
  assert.equal(evaluateMarketProbe({
    connected: true, fresh: false, sequenceHealthy: true, gapRecovered: true, latencyMs: 50
  }).passed, false);
});

test("observability contract requires every critical event sink", () => {
  assert.equal(observabilityContract({}).passed, false);
});
