const base=process.env.MARKET_DATA_URL??"https://api.binance.com";
const symbol=(process.env.MARKET_SYMBOL??"BTCUSDT").toUpperCase();
const intervalMs=Math.max(250,Number(process.env.MARKET_SOAK_INTERVAL_MS??1000));
const durationMs=Math.max(intervalMs,Number(process.env.MARKET_SOAK_DURATION_MS??60000));
const maxAgeMs=Number(process.env.MARKET_MAX_AGE_MS??5000);
const latencies=[],freshness=[];let errors=0,lastTs=null,requests=0;
const end=Date.now()+durationMs;
while(Date.now()<end){
  const t=performance.now();let ok=false;
  try{
    const r=await fetch(base+"/api/v3/ticker/bookTicker?symbol="+encodeURIComponent(symbol));
    if(!r.ok)throw new Error("http "+r.status);
    const x=await r.json();const bid=Number(x.bidPrice),ask=Number(x.askPrice);
    if(!(bid>0&&ask>=bid))throw new Error("invalid quote");
    const now=Date.now();lastTs=now;ok=true;
  }catch{errors++;}
  latencies.push(performance.now()-t);freshness.push({at:Date.now(),ok});
  requests++;await new Promise(r=>setTimeout(r,intervalMs));
}
const sorted=latencies.slice().sort((a,b)=>a-b);const pct=p=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor((p/100)*(sorted.length-1)))]:null;
const staleSamples=freshness.filter(x=>!x.ok).length;
const report={source:"public-rest",symbol,durationMs,requests,errors,errorRate:requests?errors/requests:1,
p50Ms:pct(50),p95Ms:pct(95),p99Ms:pct(99),staleSamples,maxAgeMs,
lastSuccessfulAt:lastTs?new Date(lastTs).toISOString():null,
noTradeRequired:errors>0||lastTs===null||Date.now()-lastTs>maxAgeMs};
console.log(JSON.stringify(report,null,2));
if(report.noTradeRequired&&process.env.MARKET_SOAK_ALLOW_FAILURE!=="1")process.exitCode=1;
