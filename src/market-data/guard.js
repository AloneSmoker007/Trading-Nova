// Proposed: explicit NO-TRADE gate that wires live market-data state into the
// execution boundary. Fail-closed by design: any missing, unknown or unhealthy
// market-data state blocks trading deterministically.

const KNOWN_STATES = new Set(["CONNECTED", "GAP", "DEGRADED", "DISCONNECTED", "CONNECTING"]);

/**
 * Evaluate whether market data permits trading.
 * @param {object} state - output of WsFeed.qualityState() (or equivalent).
 * @param {{maxAgeMs?: number, now?: number}} opts
 * @returns {{allowed: boolean, reasons: string[]}}
 */
export function evaluateMarketGate(state, { maxAgeMs = 10000, now = Date.now() } = {}) {
  const reasons = [];
  if (!state || typeof state !== "object") {
    return Object.freeze({ allowed: false, reasons: Object.freeze(["UNKNOWN_MARKET_STATE"]) });
  }
  if (!KNOWN_STATES.has(state.state)) reasons.push("UNKNOWN_MARKET_STATE");
  if (state.connected !== true) reasons.push("DISCONNECTED");
  if (state.state === "GAP" || state.gapOpen === true) reasons.push("SEQUENCE_GAP");
  if (state.invalidData === true) reasons.push("INVALID_DATA");
  const ageLimit = Number.isFinite(state.maxAgeMs) ? state.maxAgeMs : maxAgeMs;
  const fresh = Number.isFinite(state.lastValidAt) && now - state.lastValidAt <= ageLimit;
  if (!fresh) reasons.push("STALE_DATA");
  return Object.freeze({ allowed: reasons.length === 0, reasons: Object.freeze(reasons) });
}

/**
 * Wrap any execution engine so submit() refuses to act on stale/invalid/gapped
 * market data. The refusal is a deterministic, frozen NO-TRADE record.
 */
export function withMarketGate(execution, getMarketState, { maxAgeMs = 10000, now = () => Date.now() } = {}) {
  if (!execution || typeof execution.submit !== "function") throw new Error("execution engine required");
  if (typeof getMarketState !== "function") throw new Error("market state provider required");
  return {
    ...execution,
    submit(order, opts) {
      const gate = evaluateMarketGate(getMarketState(), { maxAgeMs, now: now() });
      if (!gate.allowed) {
        return Object.freeze({
          status: "NO_TRADE",
          blocked: true,
          reasons: gate.reasons,
          symbol: order?.symbol ?? null,
          checkedAt: now()
        });
      }
      return execution.submit(order, opts);
    }
  };
}
