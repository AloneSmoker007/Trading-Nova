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
export const REQUIREMENT_FIELDS=Object.freeze({
  "backup-restore-rto-rpo":["rtoMs","rpoMs","artifactSha256"],
});
export function validateEvidenceRequirement(record={}){
  const reasons=[];
  if(record.result==="BLOCKED"&&!record.blockedReason) reasons.push("BLOCKED without blockedReason");
  if(record.result==="PASS"){
    for(const field of REQUIREMENT_FIELDS[record.id]??[]){
      if(!record[field]) reasons.push(`${record.id} PASS requires ${field}`);
    }
    if(record.id==="backup-restore-rto-rpo"){
      if(!isMeasured(record.rtoMs)) reasons.push("rtoMs must be a measured duration");
      if(!isMeasured(record.rpoMs)) reasons.push("rpoMs must be a measured duration");
      if(record.productionEligible!==true) reasons.push("PASS requires productionEligible:true");
    }
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
