export function dataExpansionGate({coverage, freshness, sourceTrust, pointInTime, biasChecks} = {}) {
  const checks = { coverage, freshness, sourceTrust, pointInTime, biasChecks };
  const ready = Object.values(checks).every(Boolean);
  return Object.freeze({ ready, checks, failClosed: !ready });
}
