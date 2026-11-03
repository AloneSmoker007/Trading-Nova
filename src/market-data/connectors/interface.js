export function assertConnector(c){if(!c||typeof c.getQuote!=="function"||typeof c.getCandles!=="function")throw new Error("invalid market-data connector");return c;}
// `timestamp` is a source-reported event time, never a local request/receipt time.
// Some REST quote endpoints (including Binance Spot bookTicker) omit event time;
// keep it unknown rather than reporting a fabricated zero-age quote.
export function normalizeQuote({source,symbol,bid,ask,timestamp=null,receivedAt=Date.now()}) {
  if (!source || !symbol || ![bid, ask].every(Number.isFinite) || bid <= 0 || ask <= 0 || bid > ask) {
    throw new Error("invalid quote");
  }
  if (timestamp !== null && !Number.isFinite(timestamp)) throw new Error("invalid quote");
  if (!Number.isFinite(receivedAt)) throw new Error("invalid quote");
  return Object.freeze({
    source,
    symbol: symbol.toUpperCase(),
    bid,
    ask,
    timestamp,
    timestampStatus: timestamp === null ? "not-provided" : "source",
    receivedAt,
    ageMs: timestamp === null ? null : Math.max(0, receivedAt - timestamp),
    trust: 1
  });
}
// Schema parity with src/market-data/schema.js `validateCandle`: OHLC must be
// internally consistent (open/close inside [low,high], not just high>=low) and
// timestamps must be finite with closeTime>=openTime — NaN times or open>high
// used to slip through and poison downstream ageMs/gap math with NaN.
export function normalizeCandle({source,symbol,openTime,closeTime,open,high,low,close,volume,receivedAt=Date.now()}){if(![open,high,low,close,volume].every(Number.isFinite)||high<low||open<low||open>high||close<low||close>high||open<=0||close<=0||volume<0)throw new Error("invalid candle");if(!Number.isFinite(openTime)||!Number.isFinite(closeTime)||closeTime<openTime)throw new Error("invalid candle");if(!Number.isFinite(receivedAt))throw new Error("invalid candle");return Object.freeze({source,symbol:symbol.toUpperCase(),openTime,closeTime,open,high,low,close,volume,receivedAt,ageMs:Math.max(0,receivedAt-closeTime),trust:1});}
