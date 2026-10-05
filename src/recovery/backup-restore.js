export function verifyBackupArtifact({ manifestValid, restoreTestPassed, dataVerified }) {
  const checks = {
    manifestValid: manifestValid === true,
    restoreTestPassed: restoreTestPassed === true,
    dataVerified: dataVerified === true
  };
  return Object.freeze({ passed: Object.values(checks).every(Boolean), checks: Object.freeze(checks) });
}

export function requireVerifiedBackup(result) {
  if (!result?.passed) {
    const error = new Error("BACKUP_RESTORE_NOT_VERIFIED");
    error.code = "BACKUP_RESTORE_NOT_VERIFIED";
    throw error;
  }
  return result;
}

export function crashRecoveryDecision({ checkpointRestored, reconciliationSafe, unknownExecution }) {
  const safe = checkpointRestored === true && reconciliationSafe === true && unknownExecution !== true;
  return Object.freeze({ safe, action: safe ? "RESUME" : "STOP_AND_RECONCILE" });
}
