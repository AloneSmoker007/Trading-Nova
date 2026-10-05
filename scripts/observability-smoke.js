const endpoint=process.env.OBSERVABILITY_INGEST_URL;
if(!endpoint) throw new Error("OBSERVABILITY_INGEST_URL is required");
const events=["READINESS_FAILURE","RISK_BLOCK","RECONCILIATION_FAILURE","UNKNOWN_EXECUTION","MARKET_DATA_STALE","SECURITY_EVENT","BACKUP_FAILURE"];
const results=[];
for(const event of events){
  const r=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json",...(process.env.OBSERVABILITY_TOKEN?{authorization:"Bearer "+process.env.OBSERVABILITY_TOKEN}:{})},body:JSON.stringify({event,timestamp:new Date().toISOString(),source:"trading-nova-v1-smoke"})});
  results.push({event,status:r.status,ok:r.ok});
}
console.log(JSON.stringify({passed:results.every(x=>x.ok),results},null,2));
if(results.some(x=>!x.ok))process.exitCode=1;
