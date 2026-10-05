const REQUIRED = Object.freeze(["orderSubmit","orderStatus","cancelOrder","fills","userDataStream"]);
export function venueReplayConformance(adapter = {}) {
  const missing = REQUIRED.filter((name) => typeof adapter[name] !== "function");
  const scenarios = ["submit","status","partial-fill","fill","cancel","user-data-reconnect"];
  return Object.freeze({ passed: missing.length === 0, missing, scenarios: Object.freeze(scenarios) });
}
