import test from "node:test";
import assert from "node:assert/strict";
import { productionReadinessReport, requireProductionReadiness } from "../src/operations/production-readiness.js";
import { verifyBackupArtifact, requireVerifiedBackup, crashRecoveryDecision } from "../src/recovery/backup-restore.js";
import { createPromotionCertificate, requirePromotionCertificate } from "../src/governance/promotion-certificate.js";

test("production readiness fails closed when evidence is missing", () => {
  const report = productionReadinessReport({ database: true, marketData: true });
  assert.equal(report.ready, false);
  assert.ok(report.blockers.includes("backup"));
  assert.throws(() => requireProductionReadiness({ database: true }), /PRODUCTION_NOT_READY/);
});

test("production readiness passes only when every required control is evidenced", () => {
  const checks = { database: true, marketData: true, riskGate: true, backup: true, rollback: true, observability: true, reconciliation: true };
  assert.equal(requireProductionReadiness(checks).ready, true);
});

test("backup verification requires restore and data verification", () => {
  const failed = verifyBackupArtifact({ manifestValid: true, restoreTestPassed: false, dataVerified: true });
  assert.equal(failed.passed, false);
  assert.throws(() => requireVerifiedBackup(failed), /BACKUP_RESTORE_NOT_VERIFIED/);
  const passed = verifyBackupArtifact({ manifestValid: true, restoreTestPassed: true, dataVerified: true });
  assert.equal(requireVerifiedBackup(passed).passed, true);
});

test("crash recovery stops when execution state is unknown", () => {
  assert.deepEqual(crashRecoveryDecision({ checkpointRestored: true, reconciliationSafe: false, unknownExecution: true }), { safe: false, action: "STOP_AND_RECONCILE" });
});

test("promotion certificate requires sequential promotion and human approval", () => {
  const cert = createPromotionCertificate({ from: "paper", to: "shadow", validationEvidence: true, independentSafety: true, rollbackTest: true, humanApproval: "operator-1" });
  assert.equal(cert.eligible, true);
  assert.equal(requirePromotionCertificate(cert).to, "shadow");
});

test("limited-live requires venue conformance", () => {
  const cert = createPromotionCertificate({ from: "shadow", to: "limited-live", validationEvidence: true, independentSafety: true, rollbackTest: true, venueConformance: false, humanApproval: "operator-1" });
  assert.equal(cert.eligible, false);
  assert.throws(() => requirePromotionCertificate(cert), /PROMOTION_NOT_CERTIFIED/);
});
