// Deterministic position sizing and exposure checks.
//
// These functions are INPUTS to the Risk Gate (src/risk/gate.js) — they never
// replace it. Only the gate may permit an order.
//
// Fail-closed contract: unknown / missing / NaN / non-finite / non-positive
// (where positive is required) / malformed input always returns {ok:false,...}
// with a machine-readable reason. Nothing here throws, and no computation may
// produce NaN or Infinity (every division and every product is guarded).
//
// Pct parameters are percentage points of account equity: 2 means 2%.
//
// Rounding policy: results are returned at full precision so that no risk is
// silently rounded away. If a caller must round to instrument granularity, it
// must round units DOWN and risk amounts UP (against the trader) — never the
// reverse — so the intended risk cap can never be exceeded.
//
// Pure and deterministic: no clocks, no randomness, no I/O.

function isPositive(v) {
  return Number.isFinite(v) && v > 0;
}

function validPct(v) {
  return Number.isFinite(v) && v > 0 && v <= 100;
}

export function positionSize(input) {
  const {accountEquity, riskPerTradePct, entryPrice, stopPrice} = input ?? {};
  const fail = (reason) => ({ok:false, units:null, riskAmount:null, stopDistance:null, reason});
  if (!isPositive(accountEquity)) return fail("invalid_account_equity");
  if (!validPct(riskPerTradePct)) return fail("invalid_risk_per_trade_pct");
  if (!isPositive(entryPrice)) return fail("invalid_entry_price");
  if (!isPositive(stopPrice)) return fail("invalid_stop_price");
  // Long-only stop convention (this API takes no side): the stop must sit
  // strictly below the entry, otherwise risk per unit is undefined or zero and
  // the position must not be sized at all.
  if (stopPrice >= entryPrice) return fail("invalid_stop");
  // Multiplication before division keeps integer cases exact; the finite guard
  // turns any overflow into a fail-closed result instead of Infinity.
  const riskAmount = accountEquity * riskPerTradePct / 100;
  if (!Number.isFinite(riskAmount)) return fail("arithmetic_overflow");
  const stopDistance = entryPrice - stopPrice;
  if (!isPositive(stopDistance)) return fail("invalid_stop");
  const units = riskAmount / stopDistance;
  if (!Number.isFinite(units)) return fail("arithmetic_overflow");
  return {ok:true, units, riskAmount, stopDistance, reason:null};
}

export function riskPerTrade(input) {
  const {accountEquity, riskPerTradePct, maxRiskPerTradeAbsolute} = input ?? {};
  const fail = (reason) => ({ok:false, riskAmount:null, uncappedRiskAmount:null, capped:null, reason});
  if (!isPositive(accountEquity)) return fail("invalid_account_equity");
  if (!validPct(riskPerTradePct)) return fail("invalid_risk_per_trade_pct");
  if (!isPositive(maxRiskPerTradeAbsolute)) return fail("invalid_max_risk_absolute");
  const uncappedRiskAmount = accountEquity * riskPerTradePct / 100;
  if (!Number.isFinite(uncappedRiskAmount)) return fail("arithmetic_overflow");
  // The absolute cap always binds downward: risk is the smaller of the two,
  // so the trader can never risk more than the approved absolute maximum.
  const capped = uncappedRiskAmount > maxRiskPerTradeAbsolute;
  return {ok:true, riskAmount:Math.min(uncappedRiskAmount, maxRiskPerTradeAbsolute), uncappedRiskAmount, capped, reason:null};
}

export function maxPosition(input) {
  const {accountEquity, maxPositionPct, price} = input ?? {};
  const fail = (reason) => ({ok:false, units:null, maxNotional:null, reason});
  if (!isPositive(accountEquity)) return fail("invalid_account_equity");
  if (!validPct(maxPositionPct)) return fail("invalid_max_position_pct");
  if (!isPositive(price)) return fail("invalid_price");
  const maxNotional = accountEquity * maxPositionPct / 100;
  if (!Number.isFinite(maxNotional)) return fail("arithmetic_overflow");
  const units = maxNotional / price;
  if (!Number.isFinite(units)) return fail("arithmetic_overflow");
  // Full precision cap; a caller rounding to whole units must round this cap
  // DOWN so the notional ceiling is never inflated.
  return {ok:true, units, maxNotional, reason:null};
}

export function exposureCheck(input) {
  const {positions, maxExposurePct, accountEquity} = input ?? {};
  const fail = (reason) => ({ok:false, totalExposurePct:null, breaches:[], reason});
  if (!isPositive(accountEquity)) return fail("invalid_account_equity");
  if (!validPct(maxExposurePct)) return fail("invalid_max_exposure_pct");
  if (!Array.isArray(positions)) return fail("invalid_positions");
  let grossExposure = 0;
  for (const p of positions) {
    if (!p || typeof p !== "object" || !p.symbol || !Number.isFinite(p.quantity) || !isPositive(p.markPrice)) {
      return fail("invalid_position");
    }
    // Gross exposure uses absolute notional: a short position is still market
    // exposure and must count against the cap.
    const notional = Math.abs(p.quantity * p.markPrice);
    if (!Number.isFinite(notional)) return fail("arithmetic_overflow");
    grossExposure += notional;
    if (!Number.isFinite(grossExposure)) return fail("arithmetic_overflow");
  }
  const totalExposurePct = grossExposure * 100 / accountEquity;
  if (!Number.isFinite(totalExposurePct)) return fail("arithmetic_overflow");
  // Boundary matches gate.js MAX_GROSS_EXPOSURE, which blocks on strict `>`:
  // exactly at the cap is allowed, one tick above is a breach.
  if (totalExposurePct > maxExposurePct) {
    return {ok:false, totalExposurePct, breaches:["max_exposure"], reason:"max_exposure"};
  }
  return {ok:true, totalExposurePct, breaches:[], reason:null};
}
