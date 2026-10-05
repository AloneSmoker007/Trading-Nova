export function constrainedOptimize(candidates=[],constraints={}){
  const maxLeverage=Number(constraints.maxLeverage??1),maxDrawdown=Number(constraints.maxDrawdown??1);return candidates.filter(x=>Number.isFinite(x.expectedReturn)&&Number.isFinite(x.leverage)&&Number.isFinite(x.drawdown)).filter(x=>x.leverage<=maxLeverage&&x.drawdown<=maxDrawdown).sort((a,b)=>b.expectedReturn-a.expectedReturn).map(x=>Object.freeze({...x}));
}
export function optimizationRequiresRevalidation(previous,next){return JSON.stringify(previous)!==JSON.stringify(next);}
