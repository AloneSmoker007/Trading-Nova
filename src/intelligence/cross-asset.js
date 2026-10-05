export function crossAssetRegime(series={}){
  const returns=Object.entries(series).map(([asset,r])=>({asset,return:Number(r)})).filter(x=>Number.isFinite(x.return));if(!returns.length)return{score:0,regime:"UNKNOWN"};
  const avg=returns.reduce((s,x)=>s+x.return,0)/returns.length;const dispersion=Math.max(...returns.map(x=>x.return))-Math.min(...returns.map(x=>x.return));
  return Object.freeze({score:Math.max(0,Math.min(100,50+avg*1000-dispersion*500)),regime:dispersion>0.05?"DIVERGENT":avg>0?"RISK_ON":"RISK_OFF",assets:returns});
}
