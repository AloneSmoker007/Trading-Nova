export function orderBookFeatures({bids=[],asks=[],trades=[]}={}){
  const bidQty=bids.reduce((s,x)=>s+(Number(x.qty)||0),0),askQty=asks.reduce((s,x)=>s+(Number(x.qty)||0),0);const total=bidQty+askQty;
  const imbalance=total?((bidQty-askQty)/total):0;const buy=trades.filter(x=>x.side==="BUY").reduce((s,x)=>s+(Number(x.qty)||0),0);const sell=trades.filter(x=>x.side==="SELL").reduce((s,x)=>s+(Number(x.qty)||0),0);const flow=buy+sell?(buy-sell)/(buy+sell):0;
  return Object.freeze({bidQty,askQty,bookImbalance:imbalance,tradeFlow:flow,liquidity:total});
}
export function microstructureSignal(f){if(!f)return "WAIT";if(f.liquidity<=0)return "WAIT";if(f.bookImbalance>.25&&f.tradeFlow>.15)return "BUY_BIAS";if(f.bookImbalance<-.25&&f.tradeFlow<-.15)return "SELL_BIAS";return "NEUTRAL";}
