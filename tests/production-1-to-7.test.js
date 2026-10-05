import test from "node:test";
import assert from "node:assert/strict";
import { productionEnvironment } from "../src/operations/production-env.js";
import { backupDrillPlan } from "../src/recovery/backup-drill.js";
import { evaluateMarketProbe } from "../src/market-data/production-probe.js";
import { venueReplayConformance } from "../src/governance/venue-replay.js";
import { observabilityContract } from "../src/operations/observability-contract.js";
import { finalCertification } from "../src/governance/certification.js";

test("production environment fails closed", () => {
  assert.equal(productionEnvironment({ DATABASE_URL:"x" }).ready, false);
});
test("backup drill requires all stages", () => {
  assert.equal(backupDrillPlan({ backupCommand:"backup", verifyCommand:"verify", restoreCommand:"restore" }).ready, true);
});
test("market probe fails on stale/slow data", () => {
  assert.equal(evaluateMarketProbe({ connected:true, fresh:false, sequenceHealthy:true, gapRecovered:true, latencyMs:3000 }).passed, false);
});
test("venue conformance detects missing adapter surface", () => {
  assert.equal(venueReplayConformance({}).passed, false);
});
test("observability requires every critical event sink", () => {
  assert.equal(observabilityContract({}).passed, false);
});
test("final certification fails closed without human approval", () => {
  const base = { productionReady:true, backupVerified:true, marketProbePassed:true, venueConformance:true, observabilityPassed:true, paperShadowEvidence:true };
  assert.equal(finalCertification(base).certified, false);
  assert.equal(finalCertification({...base, humanApproval:"operator-1"}).certified, true);
});
