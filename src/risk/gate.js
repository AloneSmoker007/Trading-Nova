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

function currentPositionQuantity(portfolio, symbol) {
  return (portfolio?.positions ?? [])
    .filter((p) => p?.symbol === symbol)
    .reduce((sum, p) => sum + p.quantity, 0);
}

function isValidReduction({side, positionQuantity, orderQuantity}) {
  if (!Number.isFinite(positionQuantity) || positionQuantity === 0) return false;
  const reducesLong = side === "SELL" && positionQuantity > 0;
  const reducesShort = side === "BUY" && positionQuantity < 0;
  return (reducesLong || reducesShort) && orderQuantity <= Math.abs(positionQuantity);
}

export function evaluateRiskGate({order, portfolio, riskConfig, dataFresh=true, killSwitch=false, approvedConfigHash}) {
  const reasons=[];
  try { validatePortfolioState(portfolio); } catch { return {decision:"NO_TRADE",reasons:["INVALID_PORTFOLIO_STATE"]}; }

  const validOrder = !!order
    && Number.isFinite(order.quantity)
    && Number.isFinite(order.price)
    && order.quantity > 0
    && order.price > 0
    && ["BUY","SELL"].includes(order.side);
  if (!validOrder) reasons.push("INVALID_ORDER");

  if (!riskConfig || !Number.isFinite(riskConfig.maxPositionNotional) || !Number.isFinite(riskConfig.maxGrossExposure)
    || !Number.isFinite(riskConfig.maxDailyLoss) || !Number.isFinite(riskConfig.maxDrawdown) || !Number.isFinite(riskConfig.maxLeverage)) {
    reasons.push("INVALID_RISK_CONFIG");
  }
  if (!approvedConfigHash) reasons.push("RISK_CONFIG_NOT_APPROVED");
  else if (!riskConfig || hashRiskConfig(riskConfig) !== approvedConfigHash) reasons.push("RISK_CONFIG_HASH_MISMATCH");
  if (!dataFresh) reasons.push("STALE_CRITICAL_DATA");

  const notional = validOrder ? order.quantity * order.price : 0;
  const positionQuantity = validOrder ? currentPositionQuantity(portfolio, order.symbol) : 0;
  const reduceOnly = validOrder && order.reduceOnly === true;
  const validReduction = reduceOnly && isValidReduction({side: order.side, positionQuantity, orderQuantity: order.quantity});

  if (reduceOnly && !validReduction) reasons.push("INVALID_REDUCE_ONLY");

  const positionNotionalBefore = Math.abs(positionQuantity * (portfolio?.positions ?? [])
    .filter((p) => p?.symbol === order?.symbol)
    .reduce((sum, p) => sum + (Number.isFinite(p.markPrice) ? p.markPrice : 0), 0));

  const remainingQuantity = validReduction
    ? positionQuantity + (order.side === "SELL" ? -order.quantity : order.quantity)
    : positionQuantity;

  const projectedGross = validOrder
    ? Math.max(0, (portfolio?.grossExposure || 0) - positionNotionalBefore + Math.abs(remainingQuantity * order.price))
    : portfolio?.grossExposure || 0;
  const equity=portfolio?.equity||0;
  const projectedLeverage=equity>0 ? projectedGross/equity : Infinity;

  if (riskConfig && !validReduction && notional > riskConfig.maxPositionNotional) reasons.push("MAX_POSITION");
  if (riskConfig && !validReduction && projectedGross > riskConfig.maxGrossExposure) reasons.push("MAX_GROSS_EXPOSURE");
  if (riskConfig && riskConfig && !validReduction && (portfolio?.dailyPnl||0) <= -Math.abs(riskConfig.maxDailyLoss)) reasons.push("MAX_DAILY_LOSS");
  if (riskConfig && !validReduction && (portfolio?.drawdown||0) >= riskConfig.maxDrawdown) reasons.push("MAX_DRAWDOWN");
  if (riskConfig && !validReduction && projectedLeverage > riskConfig.maxLeverage) reasons.push("MAX_LEVERAGE");
  if (riskConfig && !validReduction && Number.isFinite(riskConfig.maxConcentrationNotional) && notional > riskConfig.maxConcentrationNotional) reasons.push("MAX_CONCENTRATION");

  return {
    decision: reasons.length ? "NO_TRADE" : "ALLOW",
    reasons,
    orderNotional:notional,
    projectedGrossExposure:projectedGross,
    projectedLeverage,
    reduceOnly,
    positionQuantity,
    validReduction
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