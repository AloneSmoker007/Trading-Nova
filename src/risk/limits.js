// Deterministic loss and drawdown limits.
//
// These functions are INPUTS to the Risk Gate (src/risk/gate.js) — they never
// replace it. Only the gate may permit an order.
//
// Fail-closed contract: unknown / missing / NaN / non-finite / non-positive
// (where positive is required) input always returns {ok:false,...} with a
// machine-readable reason. A breached limit also returns ok:false with a
// machine-readable reason. evaluateLimits never "assumes fine": if any check
// cannot prove safety, the aggregate is ok:false.
//
// Pct parameters are percentage points of equity: 2 means 2%.
//
// Rounding policy: results are returned at full precision so that no risk is
// silently rounded away. If a caller must round, it must round risk amounts UP
// and remaining budget DOWN (against the trader).
//
// Pure and deterministic: no clocks, no randomness, no I/O.

function isPositive(v) {
  return Number.isFinite(v) && v > 0;
}

function validPct(v) {
  return Number.isFinite(v) && v > 0 && v <= 100;
}

function lossCheck(input, {field, invalidPctReason, breachReason}) {
  const source = input ?? {};
  const fail = (reason) => ({ok:false, used:null, limit:null, remaining:null, reason});
  const realizedPnl = source.realizedPnl;
  const startingEquity = source.startingEquity;
  const limitPct = source[field];
  if (!Number.isFinite(realizedPnl)) return fail("invalid_realized_pnl");
  if (!isPositive(startingEquity)) return fail("invalid_starting_equity");
  if (!validPct(limitPct)) return fail(invalidPctReason);
  // Multiplication before division keeps integer cases exact; guards turn any
  // overflow or underflow into a fail-closed result instead of NaN/Infinity.
  const limit = startingEquity * limitPct / 100;
  if (!isPositive(limit)) return fail("arithmetic_overflow");
  // Only losses consume the loss budget; profits never do.
  const used = Math.max(0, -realizedPnl);
  const remaining = limit - used;
  if (!Number.isFinite(remaining)) return fail("arithmetic_overflow");
  // Boundary matches gate.js MAX_DAILY_LOSS, which blocks when
  // dailyPnl <= -maxDailyLoss: a limit reached exactly is a breach.
  if (used >= limit) return {ok:false, used, limit, remaining, reason:breachReason};
  return {ok:true, used, limit, remaining, reason:null};
}

export function dailyLossCheck(input) {
  return lossCheck(input, {field:"dailyLossLimitPct", invalidPctReason:"invalid_daily_loss_limit_pct", breachReason:"daily_loss_limit"});
}

export function weeklyLossCheck(input) {
  return lossCheck(input, {field:"weeklyLossLimitPct", invalidPctReason:"invalid_weekly_loss_limit_pct", breachReason:"weekly_loss_limit"});
}

export function drawdownCheck(input) {
  const source = input ?? {};
  const fail = (reason) => ({ok:false, drawdownPct:null, limitPct:null, remaining:null, reason});
  const {peakEquity, currentEquity, maxDrawdownPct} = source;
  if (!isPositive(peakEquity)) return fail("invalid_peak_equity");
  if (!Number.isFinite(currentEquity) || currentEquity < 0) return fail("invalid_current_equity");
  if (!validPct(maxDrawdownPct)) return fail("invalid_max_drawdown_pct");
  // Multiplication before division keeps integer cases exact; the finite guard
  // prevents an overflowed quotient from being clamped into a false "no loss".
  const rawDrawdownPct = (peakEquity - currentEquity) * 100 / peakEquity;
  if (!Number.isFinite(rawDrawdownPct)) return fail("arithmetic_overflow");
  // A new equity high is not drawdown. Clamping at 0 never inflates `remaining`
  // relative to the raw (negative) value, so it cannot hide risk.
  const drawdownPct = Math.max(0, rawDrawdownPct);
  const limitPct = maxDrawdownPct;
  const remaining = limitPct - drawdownPct;
  if (!Number.isFinite(remaining)) return fail("arithmetic_overflow");
  // Boundary matches gate.js MAX_DRAWDOWN, which blocks when drawdown >= limit:
  // a drawdown at the limit exactly is a breach.
  if (drawdownPct >= limitPct) return {ok:false, drawdownPct, limitPct, remaining, reason:"max_drawdown"};
  return {ok:true, drawdownPct, limitPct, remaining, reason:null};
}

// evaluateLimits(state) aggregates the three checks above.
//
// state = {
//   daily:   {realizedPnl, startingEquity, dailyLossLimitPct},
//   weekly:  {realizedPnl, startingEquity, weeklyLossLimitPct},
//   drawdown:{peakEquity, currentEquity, maxDrawdownPct}
// }
//
// Returns {ok, blockedBy:[...], reasons:[...]}. ok is true only when every
// check proves its limit is respected. A missing section, a malformed field,
// an uncomputable value or a breached limit all make ok false. Unknown state
// is never treated as "fine".
export function evaluateLimits(state) {
  const source = state ?? {};
  const blockedBy = [];
  const reasons = [];
  const checks = [["daily", dailyLossCheck], ["weekly", weeklyLossCheck], ["drawdown", drawdownCheck]];
  for (const [key, check] of checks) {
    const section = source[key];
    if (!section || typeof section !== "object") {
      blockedBy.push(key);
      reasons.push(`${key}:missing_state`);
      continue;
    }
    const result = check(section);
    if (!result.ok) {
      blockedBy.push(key);
      reasons.push(`${key}:${result.reason}`);
    }
  }
  return {ok: blockedBy.length === 0, blockedBy, reasons};
}
