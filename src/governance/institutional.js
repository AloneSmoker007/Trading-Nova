import {dataExpansionGate} from "../intelligence/data-expansion.js";

const REQUIRED = ["operatorSeparation", "activityReconstruction", "modelInventory", "changeControl", "independentValidation", "certificateExpiry"];

export function institutionalGovernanceGate(evidence = {}) {
  const missing = REQUIRED.filter((key) => evidence[key] !== true);
  const ready = missing.length === 0;
  return Object.freeze({ ready, missing, failClosed: !ready, liveMoneyBlocked: !ready });
}

export function scaleThroughPhase20(evidence = {}) {
  const p15 = evidence.phase15 ?? {};
  const p16 = evidence.phase16 ?? {};
  const p17 = evidence.phase17 ?? {};
  const p18 = evidence.phase18 ?? {};
  const p19 = evidence.phase19 ?? {};
  const p20 = evidence.phase20 ?? {};
  const results = {
    phase15: evidence.phase15Result ?? null,
    phase16: evidence.phase16Result ?? null,
    phase17: institutionalGovernanceGate(p17),
    phase18: evidence.phase18Result ?? null,
    phase19: dataExpansionGate(p19),
    phase20: institutionalGovernanceGate(p20)
  };
  const ready = Object.values(results).every((r) => r && r.ready === true);
  return Object.freeze({ ready, results, liveMoneyBlocked: !ready });
}
