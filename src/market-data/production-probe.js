export function evaluateMarketProbe({ connected, fresh, sequenceHealthy, gapRecovered, latencyMs, maxLatencyMs = 2000 }) {
  const checks = {
    connected: connected === true,
    fresh: fresh === true,
    sequenceHealthy: sequenceHealthy === true,
    gapRecovered: gapRecovered === true,
    latency: Number.isFinite(latencyMs) && latencyMs <= maxLatencyMs
  };
  return Object.freeze({ passed: Object.values(checks).every(Boolean), checks: Object.freeze(checks), latencyMs });
}
