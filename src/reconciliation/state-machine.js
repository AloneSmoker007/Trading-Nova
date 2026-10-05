const transitions = Object.freeze({
  CREATED: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["ACKNOWLEDGED", "REJECTED", "UNKNOWN"],
  ACKNOWLEDGED: ["PARTIALLY_FILLED", "FILLED", "REJECTED", "UNKNOWN"],
  PARTIALLY_FILLED: ["PARTIALLY_FILLED", "FILLED", "UNKNOWN"],
  FILLED: ["RECONCILED", "UNKNOWN"],
  RECONCILED: [],
  REJECTED: [],
  CANCELLED: [],
  UNKNOWN: ["RECONCILED", "CANCELLED"]
});

export function transitionExecution(state, next) {
  if (!transitions[state]?.includes(next)) throw new Error(`invalid execution transition: ${state} -> ${next}`);
  return next;
}

export function isExecutionSafe(state) {
  return state === "RECONCILED";
}