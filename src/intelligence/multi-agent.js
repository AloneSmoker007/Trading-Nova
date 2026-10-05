const ROLES=["technical","macro","derivatives","microstructure","news","risk","skeptic"];
export function runResearchCouncil({evidence={},agents=ROLES}={}){
  const reports=agents.filter(r=>ROLES.includes(r)).map(role=>{const items=Array.isArray(evidence[role])?evidence[role]:[];const scores=items.map(x=>Number(x.score)).filter(Number.isFinite);const score=scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null;return Object.freeze({role,score,items:items.length});});
  const valid=reports.filter(x=>x.score!==null);const score=valid.length?valid.reduce((a,b)=>a+b.score,0)/valid.length:0;const dissent=valid.filter(x=>Math.abs(x.score-score)>=20).map(x=>x.role);
  return Object.freeze({score,agents:reports,dissent,uncertainty:!valid.length?"high":dissent.length>=2?"high":dissent.length?"medium":"low",decision:!valid.length||dissent.length>=2?"WAIT":score>=70?"RESEARCH_READY":"RESEARCH"});
}
export function commonModeCouncil(reports=[]){const directions=reports.map(x=>x?.direction).filter(Boolean);const counts=Object.fromEntries([...new Set(directions)].map(d=>[d,directions.filter(x=>x===d).length]));const max=Math.max(0,...Object.values(counts));return Object.freeze({commonModeRisk:max>=Math.max(3,Math.ceil(reports.length*.75)),counts});}
