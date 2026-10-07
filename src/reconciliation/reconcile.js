import { normalizeSide, normalizeSymbol } from "../contracts/index.js";

// Fill statuses that represent a fully settled fill. "RECONCILED" is the
// durable paper tier's status (written at creation); "FILLED" is the paper
// tier's. PARTIALLY_FILLED settles only when filledQuantity covers the order.
const SETTLED_FILL_STATUSES = new Set(["FILLED", "RECONCILED"]);

// Float-safe quantity comparison: exact `===` spuriously mismatches any value
// that passed through sizing math or decimal round-trips (0.1 + 0.2 !== 0.3).
export function quantitiesMatch(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const tolerance = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= tolerance;
}

export function reconcileOrder({order, fill} = {}) {
  if (!order || !fill) return {status:"UNRESOLVED", reasons:["MISSING_STATE"]};
  const fillQuantity = Number.isFinite(fill.filledQuantity) ? fill.filledQuantity : fill.quantity;
  const fillStatus = String(fill.status ?? "").trim().toUpperCase();
  const settled = SETTLED_FILL_STATUSES.has(fillStatus)
    || (fillStatus === "PARTIALLY_FILLED" && quantitiesMatch(fillQuantity, order.quantity));
  const same = normalizeSymbol(order.symbol) === normalizeSymbol(fill.symbol)
    && normalizeSide(order.side) === normalizeSide(fill.side)
    && quantitiesMatch(order.quantity, fillQuantity);
  return same && settled ? {status:"RECONCILED",reasons:[]} : {status:"UNRESOLVED",reasons:["ORDER_FILL_MISMATCH"]};
}

export function requireReconciled(result) {
  if (result?.status !== "RECONCILED") throw new Error("execution is not reconciled");
  return true;
}
