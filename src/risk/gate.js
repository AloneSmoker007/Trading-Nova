import { createHash } from "node:crypto";
import { validatePortfolioState } from "./portfolio.js";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
export function hashRiskConfig(config) {
  return createHash("sha256").update(JSON.stringify(stable(config))).digest("hex");
}

// --- order normalization (single vocabulary across gate/execution/reconciliation)

export function normalizeSymbol(symbol) {
  return String(symbol ?? "").trim().toUpperCase();
}

export function normalizeSide(side) {
  return String(side ?? "").trim().toUpperCase();
}

// Hash of the exact economic payload a verdict is computed for. The engines
// recompute it on submit so a gate verdict can never be reused for a different
// order (verdict reuse / swap protection).
export function hashOrderPayload(order) {
  const payload = {
    symbol: normalizeSymbol(order?.symbol),
    side: normalizeSide(order?.side),
    quantity: order?.quantity,
    price: order?.price,
    reduceOnly: order?.reduceOnly === true
  };
  return createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex");
}

// --- gate artifacts: the only admissible execution permit
//
// An artifact is issued exclusively by evaluateRiskGate on an ALLOW verdict and
// is bound to the order payload hash + the approved risk-config hash. Execution
// engines must refuse any order without a matching, actually-issued artifact.

const GATE_ARTIFACT_VERSION = 1;
// Weak keys bind authorization to the exact artifact object actually issued
// by the gate, without retaining completed artifacts or imposing a churnable cap.
const issuedGateArtifacts = new WeakMap();

function issueGateArtifact({ orderHash, configHash }) {
  const artifact = Object.freeze({
    version: GATE_ARTIFACT_VERSION,
    decision: "ALLOW",
    orderHash,
    configHash,
    issuedAt: Date.now()
  });
  issuedGateArtifacts.set(artifact, Object.freeze({orderHash, configHash}));
  return artifact;
}

// Throws unless `artifact` is a genuine evaluateRiskGate ALLOW artifact bound
// to exactly this order payload. This is the enforcement point the execution
// engines call: no order executes without it.
export function assertGateArtifact(artifact, order) {
  if (!artifact || typeof artifact !== "object") throw new Error("risk gate artifact required");
  if (artifact.version !== GATE_ARTIFACT_VERSION || artifact.decision !== "ALLOW") {
    throw new Error("risk gate artifact invalid: not an ALLOW verdict");
  }
  const orderHash = hashOrderPayload(order);
  if (artifact.orderHash !== orderHash) throw new Error("risk gate artifact invalid: order hash mismatch");
  if (typeof artifact.configHash !== "string" || artifact.configHash.length === 0) {
    throw new Error("risk gate artifact invalid: config hash missing");
  }
  const issued = issuedGateArtifacts.get(artifact);
  if (!issued || issued.orderHash !== artifact.orderHash || issued.configHash !== artifact.configHash) {
    throw new Error("risk gate artifact invalid: unknown or forged artifact");
  }
  return true;
}

// --- portfolio helpers (tenant/user scoped, case-normalized symbols)

const SCOPE_KEYS = ["userId", "user", "tenant", "tenantId", "accountId", "owner"];

function positionInScope(order, position) {
  // A position is excluded only when both sides declare the same scope key and
  // disagree. Untagged data stays counted (fail closed: never under-count).
  for (const key of SCOPE_KEYS) {
    if (order?.[key] !== undefined && position?.[key] !== undefined && order[key] !== position[key]) return false;
  }
  return true;
}

function positionsForSymbol(portfolio, symbol, order) {
  const wanted = normalizeSymbol(symbol);
  return (portfolio?.positions ?? []).filter((p) => normalizeSymbol(p?.symbol) === wanted && positionInScope(order, p));
}

function currentPositionQuantity(portfolio, symbol, order) {
  return positionsForSymbol(portfolio, symbol, order).reduce((sum, p) => sum + p.quantity, 0);
}

function currentPositionGross(portfolio, symbol, order) {
  return positionsForSymbol(portfolio, symbol, order)
    .reduce((sum, p) => sum + Math.abs(p.quantity * p.markPrice), 0);
}

function isValidReduction({side, positionQuantity, orderQuantity}) {
  if (!Number.isFinite(positionQuantity) || positionQuantity === 0) return false;
  const reducesLong = side === "SELL" && positionQuantity > 0;
  const reducesShort = side === "BUY" && positionQuantity < 0;
  return (reducesLong || reducesShort) && orderQuantity <= Math.abs(positionQuantity);
}

// Drawdown is measured from PEAK (high-water mark) equity when the portfolio
// carries one; otherwise the reported value is used. When both exist the
// larger (worse) drawdown applies — the gate never under-reports risk.
function effectiveDrawdown(portfolio, equity) {
  const reported = Number.isFinite(portfolio?.drawdown) ? portfolio.drawdown : 0;
  const peak = portfolio?.peakEquity;
  if (Number.isFinite(peak) && peak > 0) return Math.max(reported, Math.max(0, (peak - equity) / peak));

  // Older snapshots may not carry peakEquity. Infer a compatible high-water
  // mark from their reported drawdown so an estimated execution cost cannot
  // disappear from the projected drawdown just because the peak is absent.
  const currentEquity = portfolio?.equity;
  if (Number.isFinite(currentEquity) && currentEquity > 0 && reported >= 0 && reported < 1) {
    const inferredPeak = currentEquity / (1 - reported);
    if (Number.isFinite(inferredPeak) && inferredPeak > 0) {
      return Math.max(reported, Math.max(0, (inferredPeak - equity) / inferredPeak));
    }
  }
  return reported;
}

export function evaluateRiskGate({
  order,
  portfolio,
  riskConfig,
  dataFresh = true,
  killSwitch = false,
  approvedConfigHash,
  estimatedExecutionCost = 0
}) {
  const reasons=[];
  try { validatePortfolioState(portfolio); } catch { return {decision:"NO_TRADE",reasons:["INVALID_PORTFOLIO_STATE"]}; }

  const validOrder = !!order
    && Number.isFinite(order.quantity)
    && Number.isFinite(order.price)
    && order.quantity > 0
    && order.price > 0
    && ["BUY","SELL"].includes(normalizeSide(order.side));
  if (!validOrder) reasons.push("INVALID_ORDER");

  if (!riskConfig || !Number.isFinite(riskConfig.maxPositionNotional) || !Number.isFinite(riskConfig.maxGrossExposure)
    || !Number.isFinite(riskConfig.maxDailyLoss) || !Number.isFinite(riskConfig.maxDrawdown) || !Number.isFinite(riskConfig.maxLeverage)) {
    reasons.push("INVALID_RISK_CONFIG");
  }
  if (!approvedConfigHash) reasons.push("RISK_CONFIG_NOT_APPROVED");
  else if (!riskConfig || hashRiskConfig(riskConfig) !== approvedConfigHash) reasons.push("RISK_CONFIG_HASH_MISMATCH");
  if (!dataFresh) reasons.push("STALE_CRITICAL_DATA");

  const validEstimatedExecutionCost = Number.isFinite(estimatedExecutionCost) && estimatedExecutionCost >= 0;
  if (!validEstimatedExecutionCost) reasons.push("INVALID_EXECUTION_COST");
  const costForProjection = validEstimatedExecutionCost ? estimatedExecutionCost : 0;

  const notional = validOrder ? order.quantity * order.price : 0;
  const orderSide = validOrder ? normalizeSide(order.side) : "BUY";
  const positionQuantity = validOrder ? currentPositionQuantity(portfolio, order.symbol, order) : 0;
  const symbolGross = validOrder ? currentPositionGross(portfolio, order.symbol, order) : 0;
  const reduceOnly = validOrder && order.reduceOnly === true;
  const validReduction = reduceOnly && isValidReduction({side: orderSide, positionQuantity, orderQuantity: order.quantity});

  if (reduceOnly && !validReduction) reasons.push("INVALID_REDUCE_ONLY");

  const projectedGross = validOrder
    ? (validReduction
      ? Math.max(0, (portfolio?.grossExposure || 0) - symbolGross + Math.abs((positionQuantity + (orderSide === "SELL" ? -order.quantity : order.quantity)) * order.price))
      : (portfolio?.grossExposure || 0) + notional)
    : portfolio?.grossExposure || 0;
  // Resulting per-symbol EXPOSURE (open position + new order), not just the
  // single order's notional: splitting an order into N pieces cannot bypass it.
  const projectedSymbolExposure = validOrder && !validReduction ? symbolGross + notional : symbolGross;
  const equity = portfolio?.equity || 0;
  // Costs are a conservative estimate of immediate paper-equity loss versus
  // the reference mark. Apply them before checking loss, drawdown and leverage
  // limits; an order must not cross a hard stop merely because fees/slippage
  // were omitted from the pre-trade projection.
  const projectedEquity = equity - costForProjection;
  const projectedDailyPnl = (portfolio?.dailyPnl || 0) - costForProjection;
  const projectedLeverage = projectedEquity > 0 ? projectedGross / projectedEquity : Infinity;
  const drawdown = effectiveDrawdown(portfolio, equity);
  const projectedDrawdown = effectiveDrawdown(portfolio, projectedEquity);

  if (riskConfig && !validReduction && (notional > riskConfig.maxPositionNotional || projectedSymbolExposure > riskConfig.maxPositionNotional)) reasons.push("MAX_POSITION");
  if (riskConfig && !validReduction && projectedGross > riskConfig.maxGrossExposure) reasons.push("MAX_GROSS_EXPOSURE");
  if (riskConfig && !validReduction && projectedDailyPnl <= -Math.abs(riskConfig.maxDailyLoss)) reasons.push("MAX_DAILY_LOSS");
  if (riskConfig && !validReduction && projectedDrawdown >= riskConfig.maxDrawdown) reasons.push("MAX_DRAWDOWN");
  if (riskConfig && !validReduction && projectedLeverage > riskConfig.maxLeverage) reasons.push("MAX_LEVERAGE");
  if (riskConfig && !validReduction && Number.isFinite(riskConfig.maxConcentrationNotional)
    && (notional > riskConfig.maxConcentrationNotional || projectedSymbolExposure > riskConfig.maxConcentrationNotional)) reasons.push("MAX_CONCENTRATION");

  if (killSwitch && !validReduction) reasons.push("EMERGENCY_KILL_SWITCH");

  const decision = reasons.length ? "NO_TRADE" : "ALLOW";
  const orderHash = validOrder ? hashOrderPayload(order) : null;
  return {
    decision,
    reasons,
    orderNotional:notional,
    projectedGrossExposure:projectedGross,
    projectedSymbolExposure,
    projectedLeverage,
    drawdown,
    reduceOnly,
    positionQuantity,
    validReduction,
    orderHash,
    configHash: approvedConfigHash ?? null,
    // Issued only for ALLOW: this object is what execution engines accept.
    ...(decision === "ALLOW" ? { artifact: issueGateArtifact({ orderHash, configHash: approvedConfigHash }) } : {})
  };
}

export function createRiskConfig(input) {
  const config=Object.freeze({...input, version:String(input?.version||"1")});
  const required=["maxPositionNotional","maxGrossExposure","maxDailyLoss","maxDrawdown","maxLeverage"];
  if (required.some(k=>!Number.isFinite(config[k]) || config[k] < 0) || config.maxLeverage <= 0) throw new Error("invalid risk config");
  if (config.maxConcentrationNotional !== undefined && (!Number.isFinite(config.maxConcentrationNotional) || config.maxConcentrationNotional < 0)) {
    throw new Error("invalid risk config");
  }
  return Object.freeze({config, hash:hashRiskConfig(config)});
}
