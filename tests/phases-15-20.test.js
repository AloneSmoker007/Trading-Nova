import assert from "node:assert/strict";
import test from "node:test";
import { highAvailabilityGate } from "../src/scale/ha.js";
import { disasterRecoveryGate } from "../src/recovery/disaster.js";
import { securityAuditGate } from "../src/security/audit-gate.js";
import { costPerformanceGate } from "../src/operations/cost-performance.js";
import { dataExpansionGate } from "../src/intelligence/data-expansion.js";
import { institutionalGovernanceGate } from "../src/governance/institutional.js";

test("phase 15 HA fails closed without failover evidence", () => {
  const r = highAvailabilityGate({ primary: true, replica: true, failoverTest: false, rtoMinutes: 5, rpoMinutes: 1 });
  assert.equal(r.ready, false);
  assert.equal(r.liveMoneyBlocked, true);
});

test("phase 16 DR requires verified restore and replay", () => {
  const r = disasterRecoveryGate({ backupVerified: true, restoreVerified: true, recoveryReplayVerified: false, rollbackVerified: true, incidentPlan: true });
  assert.equal(r.ready, false);
});

test("phase 17 security requires every independent control", () => {
  const r = securityAuditGate({ dependencyAudit: true, secretScan: true, authzReview: true, threatModel: true, penetrationTest: false });
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes("penetrationTest"));
});

test("phase 18 performance blocks on capacity breach", () => {
  const r = costPerformanceGate({ latencyP95Ms: 100, maxLatencyP95Ms: 200, errorRate: 0.001, maxErrorRate: 0.01, monthlyCost: 50, maxMonthlyCost: 100, capacityHeadroom: 0 });
  assert.equal(r.ready, false);
});

test("phase 19 data expansion fails closed on incomplete evidence", () => {
  const r = dataExpansionGate({ coverage: true, freshness: true, sourceTrust: true, pointInTime: true, biasChecks: false });
  assert.equal(r.ready, false);
});

test("phase 20 governance requires separation and independent validation", () => {
  const r = institutionalGovernanceGate({ operatorSeparation: true, activityReconstruction: true, modelInventory: true, changeControl: true, independentValidation: false, certificateExpiry: true });
  assert.equal(r.ready, false);
  assert.equal(r.liveMoneyBlocked, true);
});
