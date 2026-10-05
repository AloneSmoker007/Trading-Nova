export function costPerformanceGate({latencyP95Ms, maxLatencyP95Ms, errorRate, maxErrorRate, monthlyCost, maxMonthlyCost, capacityHeadroom} = {}) {
  const numeric = Number.isFinite(latencyP95Ms) && Number.isFinite(maxLatencyP95Ms) && Number.isFinite(errorRate) && Number.isFinite(maxErrorRate) && Number.isFinite(monthlyCost) && Number.isFinite(maxMonthlyCost) && Number.isFinite(capacityHeadroom);
  const checks = {
    latency: numeric && latencyP95Ms <= maxLatencyP95Ms,
    errors: numeric && errorRate <= maxErrorRate,
    cost: numeric && monthlyCost <= maxMonthlyCost,
    capacity: numeric && capacityHeadroom > 0
  };
  const ready = Object.values(checks).every(Boolean);
  return Object.freeze({ ready, checks, failClosed: !ready, liveMoneyBlocked: !ready });
}
