import {requireEnv} from "./lib/require-env.js";
import {fetchWithRetry} from "./lib/http.js";
const endpoint=requireEnv("OBSERVABILITY_INGEST_URL",{
  hint:"ingest endpoint that receives observability events",
  example:"OBSERVABILITY_INGEST_URL=https://ingest.example.com/events npm run observability:smoke"
});
const requestTimeoutMs=Math.max(1,Number(process.env.OBSERVABILITY_REQUEST_TIMEOUT_MS??5000));
const retries=Math.max(0,Number(process.env.OBSERVABILITY_RETRIES??2));
const deadlineAt=Date.now()+Math.max(requestTimeoutMs,Number(process.env.OBSERVABILITY_SMOKE_DEADLINE_MS??60000));
const events=["READINESS_FAILURE","RISK_BLOCK","RECONCILIATION_FAILURE","UNKNOWN_EXECUTION","MARKET_DATA_STALE","SECURITY_EVENT","BACKUP_FAILURE"];
const results=[];
for(const event of events){
  let r;
  try{
    r=await fetchWithRetry(endpoint,{init:{method:"POST",headers:{"content-type":"application/json",...(process.env.OBSERVABILITY_TOKEN?{authorization:"Bearer "+process.env.OBSERVABILITY_TOKEN}:{})},body:JSON.stringify({event,timestamp:new Date().toISOString(),source:"trading-nova-v1-smoke"})},timeoutMs:requestTimeoutMs,retries,deadlineAt});
  }catch(error){
    results.push({event,status:null,ok:false,error:error?.code??error?.name??"request-failed"});
    continue;
  }
  results.push({event,status:r.status,ok:r.ok});
}
console.log(JSON.stringify({passed:results.every(x=>x.ok),results},null,2));
if(results.some(x=>!x.ok))process.exitCode=1;
