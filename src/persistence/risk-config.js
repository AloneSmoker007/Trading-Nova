import { hashRiskConfig, createRiskConfig } from "../risk/gate.js";
export function approveRiskConfig(config, approver, previousHash = null) {
  if (!approver || typeof approver !== "string" || !approver.trim()) throw new Error("human approver required");
  const {config: validated}=createRiskConfig(config);
  const immutable=Object.freeze({...validated});
  return Object.freeze({version:String(immutable.version),config:immutable,configHash:hashRiskConfig(immutable),approvedBy:approver.trim(),approvedAt:Date.now(),previousHash});
}
export function assertApprovedRiskConfig(record) {
  if (!record?.config || !record?.configHash || !record?.approvedBy || !record?.approvedAt) throw new Error("unapproved risk config");
  if (hashRiskConfig(record.config) !== record.configHash) throw new Error("risk config integrity failure");
  return true;
}