export function highAvailabilityGate({primary, replica, failoverTest, rtoMinutes, rpoMinutes} = {}) {
  const checks = { primary, replica, failoverTest, rtoMinutes: Number.isFinite(rtoMinutes) && rtoMinutes >= 0, rpoMinutes: Number.isFinite(rpoMinutes) && rpoMinutes >= 0 };
  const ready = Object.values(checks).every(Boolean);
  return Object.freeze({ ready, checks, failClosed: !ready, liveMoneyBlocked: !ready });
}
