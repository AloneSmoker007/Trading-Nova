// src/intelligence/calibration.js
//
// Calibration scoring over {probability, outcome} rows. Rows are strictly
// validated: probability must be a finite number in [0,1] and outcome must be a
// finite 0 or 1. Invalid rows (probability > 1, outcome > 1, NaN, "", strings)
// are DROPPED — never coerced — and reported via `calibrationReport`; a score
// over no valid rows is `null`. NaN can never escape (this file's siblings
// promise "never NaN").
const validRow = (x) =>
  Boolean(x) && typeof x === "object" && !Array.isArray(x) &&
  typeof x.probability === "number" && Number.isFinite(x.probability) && x.probability >= 0 && x.probability <= 1 &&
  typeof x.outcome === "number" && Number.isFinite(x.outcome) && (x.outcome === 0 || x.outcome === 1);

export function validCalibrationRows(rows = []) {
  return Array.isArray(rows) ? rows.filter(validRow) : [];
}

// Brier score = mean squared error between probability and binary outcome.
// null on empty/all-invalid input (score of "no rows" is unknown, not 0, not NaN).
export function brierScore(rows = []) {
  const valid = validCalibrationRows(rows);
  if (!valid.length) return null;
  return valid.reduce((s, x) => s + (x.probability - x.outcome) ** 2, 0) / valid.length;
}

// Full report: score + how much evidence was rejected as garbage.
export function calibrationReport(rows = []) {
  const all = Array.isArray(rows) ? rows : [];
  const valid = validCalibrationRows(all);
  return {brier: brierScore(rows), rows: all.length, validRows: valid.length, invalidRows: all.length - valid.length};
}

export function calibrationBins(rows = [], bins = 10) {
  const n = Number.isInteger(bins) && bins > 0 ? bins : 10;
  const valid = validCalibrationRows(rows);
  return Array.from({length: n}, (_, i) => {
    const lo = i / n;
    const hi = (i + 1) / n;
    const subset = valid.filter((x) => x.probability >= lo && (i === n - 1 ? x.probability <= hi : x.probability < hi));
    return {
      subset: subset.length,
      predicted: subset.length ? subset.reduce((s, x) => s + x.probability, 0) / subset.length : null,
      observed: subset.length ? subset.reduce((s, x) => s + x.outcome, 0) / subset.length : null
    };
  });
}
