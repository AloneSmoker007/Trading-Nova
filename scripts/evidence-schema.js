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
export function validateCertificationEvidence(records=[]){
  const byId=new Map(records.map(r=>[r.id,r]));
  const missing=REQUIRED_EVIDENCE.filter(id=>!byId.has(id));
  const invalid=records.filter(r=>!validateEvidenceRecord(r).valid).map(r=>r.id);
  const failed=records.filter(r=>r.result==="FAIL").map(r=>r.id);
  const blocked=records.filter(r=>r.result==="BLOCKED").map(r=>r.id);
  const certified=missing.length===0&&invalid.length===0&&failed.length===0&&blocked.length===0;
  return Object.freeze({certified,missing,invalid,failed,blocked,count:records.length});
}
