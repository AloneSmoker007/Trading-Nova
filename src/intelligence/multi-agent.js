// src/intelligence/multi-agent.js
//
// Multi-role research council over AI/agent evidence. Scores are UNTRUSTED
// input: only `typeof score === "number" && Number.isFinite(score)` values inside
// [0,100] are accepted; NaN / null / "" / numeric strings / out-of-range values
// are REJECTED (never coerced to 0) and counted per role as `invalid` so callers
// can see the evidence holes. ANY rejected item forces a fail-closed decision:
// "WAIT" + highest uncertainty — never RESEARCH / RESEARCH_READY.
//
// Every accepted item keeps a provenance label (data vs assumption vs
// interpretation; unlabelled -> "interpretation", the least trusted class) and
// the aggregate result is marked `untrusted:true`.
const ROLES = ["technical", "macro", "derivatives", "microstructure", "news", "risk", "skeptic"];
const KINDS = Object.freeze(["data", "assumption", "interpretation"]);

function validScore(item) {
  const s = item && typeof item === "object" && !Array.isArray(item) ? item.score : undefined;
  return typeof s === "number" && Number.isFinite(s) && s >= 0 && s <= 100 ? s : null;
}

export function runResearchCouncil({evidence = {}, agents = ROLES} = {}) {
  const ev = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : {};
  const reports = [];
  let invalidTotal = 0;
  for (const role of agents.filter((r) => ROLES.includes(r))) {
    const items = Array.isArray(ev[role]) ? ev[role] : [];
    const scores = [];
    const provenance = {data: 0, assumption: 0, interpretation: 0};
    let invalid = 0;
    for (const item of items) {
      const s = validScore(item);
      if (s === null) invalid++;
      else {
        scores.push(s);
        provenance[KINDS.includes(item.kind) ? item.kind : "interpretation"]++;
      }
    }
    invalidTotal += invalid;
    const score = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    reports.push(Object.freeze({role, score, items: items.length, invalid, provenance}));
  }
  const valid = reports.filter((x) => x.score !== null);
  const score = valid.length ? valid.reduce((a, b) => a + b.score, 0) / valid.length : 0;
  const dissent = valid.filter((x) => Math.abs(x.score - score) >= 20).map((x) => x.role);
  if (invalidTotal > 0) {
    return Object.freeze({score, agents: reports, dissent, invalid: invalidTotal, untrusted: true, uncertainty: "High", decision: "WAIT"});
  }
  const uncertainty = !valid.length ? "high" : valid.some((x) => Math.abs(x.score - score) >= 30) ? "high" : dissent.length >= 2 ? "high" : dissent.length ? "medium" : "low";
  const decision = !valid.length || uncertainty === "high" ? "WAIT" : score >= 70 ? "RESEARCH_READY" : "RESEARCH";
  return Object.freeze({score, agents: reports, dissent, invalid: invalidTotal, untrusted: true, uncertainty, decision});
}

export function commonModeCouncil(reports = []) {
  const directions = reports.map((x) => x?.direction).filter(Boolean);
  const counts = Object.fromEntries([...new Set(directions)].map((d) => [d, directions.filter((x) => x === d).length]));
  const max = Math.max(0, ...Object.values(counts));
  return Object.freeze({commonModeRisk: max >= Math.max(3, Math.ceil(reports.length * 0.75)), counts});
}
