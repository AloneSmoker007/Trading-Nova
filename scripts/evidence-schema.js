export const EVIDENCE_STATUSES=Object.freeze(["PASS","FAIL","BLOCKED","NOT_RUN"]);
export const REQUIRED_EVIDENCE=Object.freeze([
  "postgres-production","backup-restore-rto-rpo","market-data-soak","observability",
  "security-assurance","capacity-load","paper-shadow","master-traceability","human-approval"
]);
export function validateEvidenceRecord(record={}){
  const missing=["id","environment","timestamp","operator","artifact","result"].filter(k=>!record[k]);
  const validResult=EVIDENCE_STATUSES.includes(record.result);
  return Object.freeze({valid:missing.length===0&&validResult,missing,invalidResult:!validResult});
}
const isMeasured=v=>typeof v==="number"&&Number.isFinite(v)&&v>=0;
const isPositive=v=>isMeasured(v)&&v>0;
export const ARTIFACT_SHA256=/^[0-9a-f]{64}$/;

const ANY_GATE=["artifactSha256"];
export const REQUIREMENT_FIELDS=Object.freeze({
  "postgres-production":[...ANY_GATE,"serverVersion","restoreVerified"],
  "backup-restore-rto-rpo":[...ANY_GATE,"rtoMs","rpoMs"],
  "market-data-soak":[...ANY_GATE,"soakDurationMs","maxGapMs"],
  "observability":[...ANY_GATE,"scrapeIntervalMs","alertDeliveryVerified"],
  "security-assurance":[...ANY_GATE,"reportSha256"],
  "capacity-load":[...ANY_GATE,"peakRps","p95Ms"],
  "paper-shadow":[...ANY_GATE,"tradingDays","fillCount"],
  "master-traceability":[...ANY_GATE,"capabilityCount"],
  "human-approval":[...ANY_GATE,"approver","approvalDate"],
});

export const MEASURED_FIELDS=Object.freeze({
  "backup-restore-rto-rpo":["rtoMs","rpoMs"],
  "market-data-soak":["soakDurationMs","maxGapMs"],
  "observability":["scrapeIntervalMs"],
  "capacity-load":["peakRps","p95Ms"],
  "paper-shadow":["tradingDays","fillCount"],
  "master-traceability":["capabilityCount"],
});

export const POSITIVE_MEASUREMENTS=Object.freeze([
  "rtoMs","rpoMs","soakDurationMs","scrapeIntervalMs","peakRps","p95Ms","tradingDays",
]);

export const VERIFIED_FLAGS=Object.freeze({
  "postgres-production":["restoreVerified"],
  "observability":["alertDeliveryVerified"],
});

export function validateEvidenceRequirement(record={}){
  const reasons=[];
  if(record.result==="BLOCKED"&&!record.blockedReason) reasons.push("BLOCKED without blockedReason");
  if(record.result==="PASS"){
    for(const field of REQUIREMENT_FIELDS[record.id]??[]){
      if(record[field]===undefined||record[field]===null||record[field]==="") reasons.push(`${record.id} PASS requires ${field}`);
    }
    if(record.artifactSha256!==undefined&&!ARTIFACT_SHA256.test(String(record.artifactSha256))) reasons.push("artifactSha256 must be a lowercase 64-character hex digest of the artifact");
    for(const field of MEASURED_FIELDS[record.id]??[]){
      const check=POSITIVE_MEASUREMENTS.includes(field)?isPositive:isMeasured;
      if(record[field]!==undefined&&!check(record[field])) reasons.push(`${field} must be a measured number${POSITIVE_MEASUREMENTS.includes(field)?" greater than zero":""}`);
    }
    for(const field of VERIFIED_FLAGS[record.id]??[]){
      if(record[field]!==undefined&&record[field]!==true) reasons.push(`${field} must be true for a PASS`);
    }
    if(record.id==="human-approval"&&record.approvalDate!==undefined&&Number.isNaN(Date.parse(record.approvalDate))) reasons.push("approvalDate must be a parseable date");
    if(record.productionEligible!==true) reasons.push("PASS requires productionEligible:true");
  }
  return Object.freeze({valid:reasons.length===0,reasons});
}
export function validateCertificationEvidence(records=[]){
  const byId=new Map(records.map(r=>[r.id,r]));
  const missing=REQUIRED_EVIDENCE.filter(id=>!byId.has(id));
  const invalid=records.filter(r=>!validateEvidenceRecord(r).valid).map(r=>r.id);
  const failed=records.filter(r=>r.result==="FAIL").map(r=>r.id);
  const blocked=records.filter(r=>r.result==="BLOCKED").map(r=>r.id);
  const certified=missing.length===0&&invalid.length===0&&failed.length===0&&blocked.length===0;
  return Object.freeze({certified,missing,invalid,failed,blocked,count:records.length});
}
