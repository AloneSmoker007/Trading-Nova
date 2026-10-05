import { createHash } from "node:crypto";
import { validatePortfolioState } from "./portfolio.js";

export function hashRiskConfig(config) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function evaluateRiskGate({order, portfolio, riskConfig, dataFresh=true, killSwitch=false, approvedConfigHash}) {
  const reasons=[];
  try { validatePortfolioState(portfolio); } catch (e) { return {decision:"NO_TRADE",reasons:["INVALID_PORTFOLIO_STATE"]}; }
  if (!order || !Number.isFinite(order.quantity) || !Number.isFinite(order.price) || order.quantity <= 0 || order.price <= 0) reasons.push("INVALID_ORDER");
  if (!riskConfig || !Number.isFinite(riskConfig.maxPositionNotional) || !Number.isFinite(riskConfig.maxGrossExposure) || !Number.isFinite(riskConfig.maxDailyLoss) || !Number.isFinite(riskConfig.maxDrawdown) || !Number.isFinite(riskConfig.maxLeverage)) reasons.push("INVALID_RISK_CONFIG");
  if (approvedConfigHash && hashRiskConfig(riskConfig) !== approvedConfigHash) reasons.push("RISK_CONFIG_HASH_MISMATCH");
  if (!dataFresh) reasons.push("STALE_CRITICAL_DATA");
  if (killSwitch) reasons.push("EMERGENCY_KILL_SWITCH");
  const notional=Math.abs((order?.quantity||0)*(order?.price||0));
  const projectedGross=(portfolio?.grossExposure||0)+notional;
  const equity=portfolio?.equity||0;
  const projectedLeverage=equity>0 ? projectedGross/equity : Infinity;
  if (riskConfig && notional > riskConfig.maxPositionNotional) reasons.push("MAX_POSITION");
  if (riskConfig && projectedGross > riskConfig.maxGrossExposure) reasons.push("MAX_GROSS_EXPOSURE");
  if (riskConfig && (portfolio?.dailyPnl||0) <= -Math.abs(riskConfig.maxDailyLoss)) reasons.push("MAX_DAILY_LOSS");
  if (riskConfig && (portfolio?.drawdown||0) >= riskConfig.maxDrawdown) reasons.push("MAX_DRAWDOWN");
  if (riskConfig && projectedLeverage > riskConfig.maxLeverage) reasons.push("MAX_LEVERAGE");
  if (riskConfig?.maxConcentrationNotional && notional > riskConfig.maxConcentrationNotional) reasons.push("MAX_CONCENTRATION");
  return {decision: reasons.length ? "NO_TRADE" : "ALLOW", reasons, orderNotional:notional, projectedGrossExposure:projectedGross, projectedLeverage};
}

export function createRiskConfig(input) {
  const config=Object.freeze({...input, version:String(input?.version||"1")});
  const required=["maxPositionNotional","maxGrossExposure","maxDailyLoss","maxDrawdown","maxLeverage"];
  if (required.some(k=>!Number.isFinite(config[k]) || config[k] < 0) || config.maxLeverage <= 0) throw new Error("invalid risk config");
  return Object.freeze({config, hash:hashRiskConfig(config)});
}