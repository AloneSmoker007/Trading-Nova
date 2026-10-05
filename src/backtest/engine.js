export function runBacktest({candles, strategy, startingCash=10000}) {
  if (!Array.isArray(candles) || typeof strategy!=="function") throw new Error("backtest inputs required");
  let cash=startingCash, position=0, trades=0;
  for (const candle of candles) {
    const signal=strategy(candle, {cash,position});
    if (signal?.side==="BUY" && signal.quantity>0 && cash >= signal.quantity*candle.close) { cash-=signal.quantity*candle.close; position+=signal.quantity; trades++; }
    if (signal?.side==="SELL" && signal.quantity>0 && position >= signal.quantity) { cash+=signal.quantity*candle.close; position-=signal.quantity; trades++; }
  }
  const finalEquity=cash+position*(candles.at(-1)?.close||0);
  return {startingCash,finalEquity,returnPct:(finalEquity-startingCash)/startingCash,trades,endingPosition:position};
}