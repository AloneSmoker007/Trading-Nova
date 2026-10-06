// Market-structure layer: fractal swing points, BOS/CHOCH events, range breakouts,
// MA-based trend direction and ATR-scaled breakout levels.
// Pure and deterministic: no clocks, no randomness, no I/O. Every output at index i
// depends only on candles[0..i] — structure events never reference a swing before it
// is confirmed (`strength` bars after its pivot) or after it goes stale (`lookback`).
// Zero dependencies: the sma/atr helpers below are local on purpose.

const SWING_STRENGTH=3; // fractal half-window used by marketStructure
const CONFIRMATION_BARS=SWING_STRENGTH; // bars after the pivot before a swing is known
const DEFAULT_LOOKBACK=20;

function high(c){return Number.isFinite(c?.high)?c.high:null;}
function low(c){return Number.isFinite(c?.low)?c.low:null;}
function close(c){return Number.isFinite(c?.close)?c.close:null;}

// Trailing simple moving average; null where the window is not yet complete.
function sma(values,period){
  const out=new Array(values.length).fill(null);
  let sum=0;
  for(let i=0;i<values.length;i++){
    sum+=values[i];
    if(i>=period)sum-=values[i-period];
    if(i>=period-1)out[i]=sum/period;
  }
  return out;
}

// Average true range over the trailing `period` bars. TR[0]=high-low (no previous
// close), TR[i]=max(high-low, |high-prevClose|, |low-prevClose|). Null when any
// candle in the window is unusable — never NaN/Infinity.
function atr(candles,period){
  if(!Array.isArray(candles)||!Number.isFinite(period)||period<1)return null;
  period=Math.floor(period);
  const n=candles.length;
  if(n<period)return null;
  const trs=[];
  for(let i=0;i<n;i++){
    const h=high(candles[i]),l=low(candles[i]);
    if(h===null||l===null)return null;
    if(i===0){trs.push(h-l);continue;}
    const pc=close(candles[i-1]);
    if(pc===null)return null;
    trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
  }
  return trs.slice(-period).reduce((s,x)=>s+x,0)/period;
}

// N-bar fractal swing points. A pivot at i is a swing high iff its high is strictly
// greater than every other high in candles[i-strength..i+strength] (swing low: low
// strictly smaller). Pivot indices need a full window on both sides, so a swing at i
// is only *confirmed* `strength` bars later. Returns [{index, price, type}] sorted
// by index; empty for empty/invalid input, never throws.
export function swings(candles,strength=3){
  if(!Array.isArray(candles)||!Number.isFinite(strength)||strength<1)return[];
  strength=Math.floor(strength);
  const out=[];
  const n=candles.length;
  for(let i=strength;i+strength<n;i++){
    const ch=high(candles[i]),cl=low(candles[i]);
    if(ch===null||cl===null)continue;
    let isHigh=true,isLow=true,valid=true;
    for(let k=i-strength;k<=i+strength;k++){
      if(k===i)continue;
      const h=high(candles[k]),l=low(candles[k]);
      if(h===null||l===null){valid=false;break;}
      if(h>=ch)isHigh=false;
      if(l<=cl)isLow=false;
    }
    if(!valid)continue;
    if(isHigh)out.push({index:i,price:ch,type:"high"});
    if(isLow)out.push({index:i,price:cl,type:"low"});
  }
  return out;
}

// Swing map + market-structure events. Walks the series in order and marks:
//  - BOS  = close through a swing level in the direction of the current structure
//  - CHOCH = close through a swing level against the current structure
// Only confirmed swings (pivot + CONFIRMATION_BARS <= i) that are still fresh
// (i - pivot <= lookback) act as reference levels, and each level triggers at most
// one event. On a bar that breaks both levels the bullish check wins (deterministic).
export function marketStructure(candles,lookback=20){
  const empty={swings:[],events:[]};
  if(!Array.isArray(candles)||!candles.length)return empty;
  if(!Number.isFinite(lookback)||lookback<1)lookback=DEFAULT_LOOKBACK;
  lookback=Math.floor(lookback);
  const pts=swings(candles,SWING_STRENGTH);
  const events=[];
  const used=new Set();
  let structure=null;
  for(let i=0;i<candles.length;i++){
    const c=close(candles[i]);
    if(c===null)continue;
    let refHigh=null,refLow=null;
    for(const p of pts){
      if(used.has(p.index))continue;
      if(p.index+CONFIRMATION_BARS>i)continue;
      if(i-p.index>lookback)continue;
      if(p.type==="high")refHigh=p;else refLow=p;
    }
    if(refHigh&&c>refHigh.price){
      events.push({index:i,type:structure==="bearish"?"CHOCH":"BOS",direction:"bullish"});
      structure="bullish";
      used.add(refHigh.index);
    }else if(refLow&&c<refLow.price){
      events.push({index:i,type:structure==="bullish"?"CHOCH":"BOS",direction:"bearish"});
      structure="bearish";
      used.add(refLow.index);
    }
  }
  return {swings:pts,events};
}

// Most recent close beyond the prior `period`-bar range (strictly beyond: a close
// exactly at the range edge is not a breakout). The range at bar i covers
// candles[i-period..i-1] only — no look-ahead. Returns
// {ok, direction:"up"|"down"|null, level, index} with ok=false and null fields
// when no breakout exists or the input is unusable.
export function breakout(candles,period=20){
  const none={ok:false,direction:null,level:null,index:null};
  if(!Array.isArray(candles)||!Number.isFinite(period)||period<1)return none;
  period=Math.floor(period);
  const n=candles.length;
  if(n<period+1)return none;
  let last=null;
  for(let i=period;i<n;i++){
    const c=close(candles[i]);
    if(c===null)continue;
    let hi=-Infinity,lo=Infinity,valid=true;
    for(let k=i-period;k<i;k++){
      const h=high(candles[k]),l=low(candles[k]);
      if(h===null||l===null){valid=false;break;}
      hi=Math.max(hi,h);
      lo=Math.min(lo,l);
    }
    if(!valid)continue;
    if(c>hi)last={ok:true,direction:"up",level:hi,index:i};
    else if(c<lo)last={ok:true,direction:"down",level:lo,index:i};
  }
  return last??none;
}

// "up"/"down"/"sideways" from trailing-MA cross plus long-MA slope:
// "up" only when the short MA is above the long MA *and* the long MA is rising,
// "down" only when the short MA is below a falling long MA, otherwise "sideways".
// Null when the series/config is unusable (empty, NaN samples, short>=long,
// fewer than long+1 samples). Never NaN/Infinity.
export function trendDirection(values,short=20,long=50){
  if(!Array.isArray(values)||!values.length)return null;
  if(!Number.isFinite(short)||!Number.isFinite(long))return null;
  short=Math.floor(short);
  long=Math.floor(long);
  if(short<1||long<1||short>=long)return null;
  if(values.length<long+1)return null;
  if(!values.every(Number.isFinite))return null;
  const maShort=sma(values,short),maLong=sma(values,long);
  const i=values.length-1;
  const s=maShort[i],l=maLong[i],slope=l-maLong[i-1];
  if(s>l&&slope>0)return "up";
  if(s<l&&slope<0)return "down";
  return "sideways";
}

// Volatility-adjusted breakout level on the last bar. The prior `period`-bar range
// (candles[n-1-period..n-2]) is compared with the last close; the breakout distance
// is then expressed in ATR units ("scaled"). All-or-nothing: any unusable candle
// yields the all-null result instead of partial/NaN data.
// Returns {atr, rangeHigh, rangeLow, direction, level, distance, scaled} where
// direction/level/distance/scaled are null without a breakout, and scaled is null
// when ATR is zero (scaling undefined — never Infinity).
export function volatilityAdjustedLevel(candles,period=20){
  const na={atr:null,rangeHigh:null,rangeLow:null,direction:null,level:null,distance:null,scaled:null};
  if(!Array.isArray(candles)||!Number.isFinite(period)||period<1)return na;
  period=Math.floor(period);
  const n=candles.length;
  if(n<period+1)return na;
  const a=atr(candles,period);
  const c=close(candles[n-1]);
  if(a===null||c===null)return na;
  let hi=-Infinity,lo=Infinity;
  for(let k=n-1-period;k<n-1;k++){
    const h=high(candles[k]),l=low(candles[k]);
    if(h===null||l===null)return na;
    hi=Math.max(hi,h);
    lo=Math.min(lo,l);
  }
  if(c>hi){
    const distance=c-hi;
    return {atr:a,rangeHigh:hi,rangeLow:lo,direction:"up",level:hi,distance,scaled:a>0?distance/a:null};
  }
  if(c<lo){
    const distance=lo-c;
    return {atr:a,rangeHigh:hi,rangeLow:lo,direction:"down",level:lo,distance,scaled:a>0?distance/a:null};
  }
  return {atr:a,rangeHigh:hi,rangeLow:lo,direction:null,level:null,distance:null,scaled:null};
}
