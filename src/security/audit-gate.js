const REQUIRED = ["dependencyAudit", "secretScan", "authzReview", "threatModel", "penetrationTest"];

export function securityAuditGate(evidence = {}) {
  const missing = REQUIRED.filter((key) => evidence[key] !== true);
  return Object.freeze({ ready: missing.length === 0, missing, failClosed: missing.length > 0, liveMoneyBlocked: missing.length > 0 });
}
