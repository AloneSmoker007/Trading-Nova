// src/backtest/validation.js
//
// Walk-forward / holdout validation gates.
//
// OUT_OF_SAMPLE_DRAWDOWN is measured on the OUT-OF-SAMPLE run's own equity
// path — never across two independent runs. (The previous implementation
// compared `outOfSample.equity` against `inSample.equity`, which mislabeled
// plain cross-run performance differences as a "drawdown" and flagged
// profitable OOS runs invalid whenever the in-sample run happened to earn
// more.) Sources, in order of preference:
//   1. outOfSample.equityCurve — metrics.maxDrawdown over the OOS curve itself;
//   2. outOfSample.maxDrawdown — a run that self-reports its (<= 0) drawdown;
//   3. a conservative lower bound from the OOS run alone: a losing OOS run has
//      a drawdown of at least its total loss (peak >= starting equity), a
//      profitable OOS run has no provable drawdown -> 0.
import {maxDrawdown} from "./metrics.js";

function oosDrawdown(outOfSample) {
  if (Array.isArray(outOfSample.equityCurve) && outOfSample.equityCurve.some(Number.isFinite)) {
    return maxDrawdown(outOfSample.equityCurve);
  }
  if (Number.isFinite(outOfSample.maxDrawdown) && outOfSample.maxDrawdown <= 0) return outOfSample.maxDrawdown;
  if (Number.isFinite(outOfSample.returnPct)) return Math.min(0, outOfSample.returnPct);
  return null;
}

export function validateBacktest({inSample, outOfSample, minTrades = 30, maxDrawdown: maxDrawdownLimit = 0.25} = {}) {
  if (!inSample || !outOfSample) return {valid: false, reasons: ["OUT_OF_SAMPLE_REQUIRED"]};
  const reasons = [];
  const isTrades = Number.isFinite(inSample.trades) ? inSample.trades : 0;
  const oosTrades = Number.isFinite(outOfSample.trades) ? outOfSample.trades : 0;
  if (isTrades < minTrades || oosTrades < minTrades) reasons.push("INSUFFICIENT_TRADES");
  const oosDd = oosDrawdown(outOfSample);
  if (oosDd !== null && -oosDd > maxDrawdownLimit) reasons.push("OUT_OF_SAMPLE_DRAWDOWN");
  if (!Number.isFinite(outOfSample.returnPct)) reasons.push("INVALID_RETURN");
  return {valid: reasons.length === 0, reasons, metrics: {outOfSampleDrawdown: oosDd}};
}
