export function scoreOpportunity(factors) {
  const entries=Object.entries(factors||{}).filter(([,v])=>Number.isFinite(v));
  if (!entries.length) return {score:0,uncertainty:"high",decision:"WAIT"};
  const score=Math.max(0,Math.min(100,entries.reduce((s,[,v])=>s+v,0)/entries.length));
  const spread=Math.max(...entries.map(([,v])=>v))-Math.min(...entries.map(([,v])=>v));
  const uncertainty=spread>=30?"high":spread>=15?"medium":"low";
  return {score,uncertainty,decision:score>=75&&uncertainty!=="high"?"RESEARCH_READY":"WAIT",factors:Object.fromEntries(entries)};
}

export function calibratedProbability({wins,losses,minSamples=100}) {
  const n=wins+losses;
  if (!Number.isFinite(wins)||!Number.isFinite(losses)||wins<0||losses<0||n<minSamples) return null;
  return wins/n;
}