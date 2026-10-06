import {performance} from "node:perf_hooks";
import {requireEnv} from "./lib/require-env.js";
const url=requireEnv("LOAD_TEST_URL",{
  hint:"HTTP endpoint the load test should hit",
  example:"LOAD_TEST_URL=http://localhost:8080/health npm run load:test"
});
const durationMs=Number(process.env.LOAD_TEST_DURATION_MS??30000);
const concurrency=Math.max(1,Number(process.env.LOAD_TEST_CONCURRENCY??5));
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
console.log(JSON.stringify(report,null,2));
if(report.errorRate>Number(process.env.LOAD_TEST_MAX_ERROR_RATE??0.01))process.exitCode=1;
if(report.p95Ms>Number(process.env.LOAD_TEST_MAX_P95_MS??2000))process.exitCode=1;
