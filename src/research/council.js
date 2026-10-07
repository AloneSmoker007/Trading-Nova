// src/research/council.js
//
// Evidence aggregation for the research council. AI/agent output is UNTRUSTED
// input: every score must be a strictly finite number in [0,100] before it may
// enter an average. Garbage evidence (NaN, null, "", numeric strings, booleans,
// out-of-range values, non-objects) is REJECTED at ingestion and forces a
// fail-closed result: decision "WAIT" + uncertainty "High" — never "RESEARCH".
// Rejected items are never coerced to 0 (or any other value) and never counted
// in any average.
//
// Provenance labelling (data vs assumption vs interpretation) is preserved on
// every accepted item; unlabelled items default to "interpretation" (the least
// trusted class) and the aggregate result is explicitly marked `untrusted:true`.

const KINDS = Object.freeze(["data", "assumption", "interpretation"]);

// Strict score validation: real numbers only (Number.isFinite does not coerce),
// finite and inside [0,100]. NaN / null / "" / "80" / true / 1e9 / -1 are all
// invalid and can never leak into an average.
export function isValidEvidenceScore(score) {
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100;
}

function labelOf(item) {
  const kind = item && typeof item === "object" && !Array.isArray(item) ? item.kind : undefined;
  return KINDS.includes(kind) ? kind : "interpretation";
}

export function evaluateEvidence(groups = {}) {
  const invalid = [];
  const accepted = [];
  const entries = groups && typeof groups === "object" && !Array.isArray(groups) ? Object.entries(groups) : [];
  for (const [name, items] of entries) {
    if (!Array.isArray(items) || !items.length) continue;
    const good = [];
    items.forEach((item, index) => {
      const score = item && typeof item === "object" && !Array.isArray(item) ? item.score : undefined;
      if (isValidEvidenceScore(score)) good.push({score, kind: labelOf(item)});
      else invalid.push({group: name, index});
    });
    if (good.length) accepted.push([name, good]);
  }

  const provenance = {data: 0, assumption: 0, interpretation: 0};
  for (const [, good] of accepted) for (const item of good) provenance[item.kind]++;
  const groupScores = accepted.map(([name, good]) => [name, good.reduce((a, b) => a + b.score, 0) / good.length]);

  const base = {
    score: groupScores.length ? groupScores.reduce((a, b) => a + b[1], 0) / groupScores.length : 0,
    conflicts: groupScores.filter((x) => x[1] < 50).map((x) => x[0]),
    untrusted: true,
    provenance,
    invalid
  };

  // Fail closed on ANY rejected item: invalid evidence means the picture is
  // unknown, so the council must never report RESEARCH on it.
  if (invalid.length) {
    return {...base, conflicts: [...base.conflicts, "INVALID_EVIDENCE"], uncertainty: "High", decision: "WAIT"};
  }
  if (!groupScores.length) return {...base, uncertainty: "High", decision: "WAIT"};

  const scores = groupScores.map((x) => x[1]);
  const spread = Math.max(...scores) - Math.min(...scores);
  return {
    ...base,
    uncertainty: spread > 35 ? "High" : spread > 20 ? "Medium" : "Low",
    decision: base.conflicts.length >= 2 ? "WAIT" : "RESEARCH"
  };
}

export function romanUrduExplanation(x) {
  return "Decision: " + x.decision + ". Score " + Math.round(x.score) + "/100. Uncertainty " + x.uncertainty + "." + (x.conflicts?.length ? " Conflict: " + x.conflicts.join(", ") + "." : "");
}
