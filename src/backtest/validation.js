export function validateBacktest({inSample,outOfSample,minTrades=30,maxDrawdown=0.25}){
  if(!inSample||!outOfSample)return {valid:false,reasons:["OUT_OF_SAMPLE_REQUIRED"]};
  const reasons=[];if(inSample.trades<minTrades||outOfSample.trades<minTrades)reasons.push("INSUFFICIENT_TRADES");
  if((1-(outOfSample.equity/Math.max(1,inSample.equity)))>maxDrawdown)reasons.push("OUT_OF_SAMPLE_DRAWDOWN");
  if(!Number.isFinite(outOfSample.returnPct))reasons.push("INVALID_RETURN");
  return {valid:reasons.length===0,reasons};
}
