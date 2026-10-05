const EVENTS = Object.freeze([
  "READINESS_FAILURE","RISK_BLOCK","RECONCILIATION_FAILURE",
  "UNKNOWN_EXECUTION","MARKET_DATA_STALE","SECURITY_EVENT","BACKUP_FAILURE"
]);
export function observabilityContract(sinks = {}) {
  const missing = EVENTS.filter((event) => typeof sinks[event] !== "function");
  return Object.freeze({ passed: missing.length === 0, requiredEvents: EVENTS, missing });
}
