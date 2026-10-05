import {performance} from "node:perf_hooks";
import {pathToFileURL} from "node:url";

export async function runLoadTest({
  url=process.env.LOAD_TEST_URL,
  durationMs=Number(process.env.LOAD_TEST_DURATION_MS??30000),
  concurrency=Math.max(1,Number(process.env.LOAD_TEST_CONCURRENCY??5)),
  maxErrorRate=Number(process.env.LOAD_TEST_MAX_ERROR_RATE??0.01),
  maxP95Ms=Number(process.env.LOAD_TEST_MAX_P95_MS??2000),
}={}){
  if(!url) throw new Error("LOAD_TEST_URL is required");
  const samples=[];let errors=0,requests=0,stop=false;
  const started=Date.now();
  const worker=async()=>{while(!stop){const t=performance.now();try{const r=await fetch(url);if(!r.ok)errors++;}catch{errors++;}finally{samples.push(performance.now()-t);requests++;}}};
  const workers=Array.from({length:concurrency},()=>worker());
  await new Promise(r=>setTimeout(r,durationMs)); stop=true; await Promise.all(workers);
  samples.sort((a,b)=>a-b);
  const pct=p=>samples.length?samples[Math.min(samples.length-1,Math.floor((p/100)*(samples.length-1)))] : null;
  const mem=process.memoryUsage();
  const report={url,durationMs,concurrency,requests,errors,errorRate:requests?errors/requests:1,
  p50Ms:pct(50),p95Ms:pct(95),p99Ms:pct(99),memoryRssMb:mem.rss/1048576,startedAt:new Date(started).toISOString(),endedAt:new Date().toISOString()};
  if(report.errorRate>maxErrorRate||report.p95Ms>maxP95Ms)process.exitCode=1;
  return report;
}

const isMain=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(isMain){
  const report=await runLoadTest();
  console.log(JSON.stringify(report,null,2));
}
