export function runShadow({signals=[],market={},paperExecutor,observations=[]}={}){
  const results=[];for(const signal of signals){if(signal.decision!=="ENTER")continue;const observed=observations.find(x=>x.id===signal.id)||null;const paper=paperExecutor?paperExecutor(signal,market):null;results.push({id:signal.id,paper,observed,reconciled:Boolean(observed?.reconciled),decision:observed?.reconciled?"MEASURE":"STOP"});}
  return {count:results.length,unknown:results.filter(x=>!x.reconciled).length,results,tradeAllowed:results.every(x=>x.reconciled)};
}
