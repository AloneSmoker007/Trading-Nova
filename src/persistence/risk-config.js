import { hashRiskConfig } from "../risk/gate.js";

export function approveRiskConfig(config, approver, previousHash = null) {
  if (!approver || typeof approver !== "string") throw new Error("human approver required");
  const immutable = Object.freeze({...config});
  return Object.freeze({
    version: String(immutable.version),
    config: immutable,
    configHash: hashRiskConfig(immutable),
    approvedBy: approver,
    approvedAt: Date.now(),
    previousHash
  });
}

export function assertApprovedRiskConfig(record) {
  if (!record?.config || !record?.configHash || !record?.approvedBy) throw new Error("unapproved risk config");
  if (hashRiskConfig(record.config) !== record.configHash) throw new Error("risk config integrity failure");
  return true;
}