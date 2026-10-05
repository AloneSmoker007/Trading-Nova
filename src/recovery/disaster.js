export function disasterRecoveryGate({backupVerified, restoreVerified, recoveryReplayVerified, rollbackVerified, incidentPlan} = {}) {
  const checks = { backupVerified, restoreVerified, recoveryReplayVerified, rollbackVerified, incidentPlan };
  const ready = Object.values(checks).every(Boolean);
  return Object.freeze({ ready, checks, failClosed: !ready, liveMoneyBlocked: !ready });
}
