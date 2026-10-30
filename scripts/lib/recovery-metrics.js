import {validateEvidenceRecord} from "../evidence-schema.js";

export const BACKUP_RESTORE_EVIDENCE_ID = "backup-restore-rto-rpo";

const LOCAL_HOSTS=new Set(["localhost","127.0.0.1","0.0.0.0","::1","host.docker.internal","db","postgres"]);

// A drill that ran on a laptop or a CI service container is not production
// evidence. Classification is derived from the connection string the drill
// actually used, never from an environment variable an operator can set.
export function classifyEnvironment(connectionString){
  if(!connectionString || typeof connectionString!=="string") throw new Error("connection string required");
  let host;
  try{ host=new URL(connectionString).hostname.toLowerCase().replace(/^\[|\]$/g,""); }
  catch{ throw new Error("invalid connection string"); }
  const local=LOCAL_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".localhost");
  return Object.freeze({environment:local?"local":"production",host,productionEligible:!local});
}

export function computeRto(phases=[]){
  if(!Array.isArray(phases) || phases.length===0) throw new Error("RTO requires at least one phase");
  for(const phase of phases){
    if(!Number.isFinite(phase?.startMs) || !Number.isFinite(phase?.endMs)){
      throw new Error("RTO phase "+(phase?.name ?? "?")+" requires numeric start and end times");
    }
    if(phase.endMs<phase.startMs) throw new Error("RTO phase "+(phase.name ?? "?")+" ends before it starts");
  }
  const startedMs=Math.min(...phases.map(p=>p.startMs));
  const readyMs=Math.max(...phases.map(p=>p.endMs));
  return Object.freeze({
    rtoMs:readyMs-startedMs,
    phases:Object.freeze(phases.map(p=>Object.freeze({name:p.name,startMs:p.startMs,endMs:p.endMs,durationMs:p.endMs-p.startMs})))
  });
}

// RPO is the confirmed data-loss window: everything written after the last row
// captured by the backup artifact is lost in a real restore. Both timestamps
// come from the drill itself; if the recovery point precedes the last durable
// write the measurement is impossible, so it throws instead of guessing.
export function computeRpo({lastDurableAt,recoveryPointAt}={}){
  if(!Number.isFinite(lastDurableAt)) throw new Error("RPO requires the last durable write timestamp captured by the backup");
  if(!Number.isFinite(recoveryPointAt)) throw new Error("RPO requires the recovery point timestamp");
  if(recoveryPointAt<lastDurableAt) throw new Error("recovery point precedes the last durable write; RPO cannot be measured");
  return Object.freeze({rpoMs:recoveryPointAt-lastDurableAt,lastDurableAt,recoveryPointAt});
}

export function buildBackupRestoreEvidence({
  environment,
  productionEligible,
  operator,
  artifact,
  drillStartedAt,
  rto,
  rpo,
  incidentToReadyMs,
  requireProduction=false,
  details={}
}={}){
  if(!Number.isFinite(rto?.rtoMs)) throw new Error("evidence requires a measured RTO");
  if(!Number.isFinite(rpo?.rpoMs)) throw new Error("evidence requires a measured RPO");
  // A production evidence run pointed at a non-production host is recorded as
  // BLOCKED, never as PASS: the artifact still lands so the reason is visible,
  // and the drill exits non-zero.
  const blocked=Boolean(requireProduction)&&!productionEligible;
  const record={
    id:BACKUP_RESTORE_EVIDENCE_ID,
    environment,
    timestamp:new Date(drillStartedAt).toISOString(),
    operator,
    artifact,
    result:"PASS",
    productionEligible:Boolean(productionEligible),
    rtoMs:rto.rtoMs,
    rpoMs:rpo.rpoMs,
    incidentToReadyMs,
    rtoPhases:rto.phases,
    ...(Number.isFinite(rpo.lastDurableAt)&&Number.isFinite(rpo.recoveryPointAt)
      ? {rpoWindow:{lastDurableAt:new Date(rpo.lastDurableAt).toISOString(),recoveryPointAt:new Date(rpo.recoveryPointAt).toISOString()}}
      : {}),
    ...details,
    ...(blocked?{result:"BLOCKED",blockedReason:"production evidence requested but the drill host is "+environment}:{})
  };
  const validation=validateEvidenceRecord(record);
  if(!validation.valid) throw new Error("evidence record invalid: missing="+validation.missing.join(",")+" invalidResult="+validation.invalidResult);
  return Object.freeze(record);
}

// Fail closed: a non-production drill may produce a result, but it is labelled
// so it can never be counted as production certification evidence.
export function labelLocalEvidence(record){
  if(!record || record.productionEligible!==false) return record;
  return Object.freeze({...record,result:"BLOCKED",blockedReason:record.blockedReason ?? "drill ran against a non-production PostgreSQL host"});
}
