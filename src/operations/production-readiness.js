const REQUIRED = Object.freeze([
  "database", "marketData", "riskGate", "backup", "rollback",
  "observability", "reconciliation"
]);

export function productionReadinessReport(checks = {}) {
  const results = Object.fromEntries(REQUIRED.map((key) => [key, checks[key] === true]));
  const blockers = REQUIRED.filter((key) => !results[key]);
  return Object.freeze({ ready: blockers.length === 0, checks: Object.freeze(results), blockers: Object.freeze(blockers) });
}

export function requireProductionReadiness(checks = {}) {
  const report = productionReadinessReport(checks);
  if (!report.ready) {
    const error = new Error("PRODUCTION_NOT_READY");
    error.code = "PRODUCTION_NOT_READY";
    error.blockers = report.blockers;
    throw error;
  }
  return report;
}
