// Cross-indicator relationships: Pearson correlation, rolling correlation, beta,
// lagged correlation, conservative signal confirmation and relative strength.
// Pure and deterministic; no clocks, no randomness, no I/O. Rolling/lagged outputs
// are aligned to the input index and use only same-or-past samples (no look-ahead).
// Fail-safe: undefined statistics return null (never NaN/Infinity) and never throw.

// Sum of cross/own deviation products (unnormalized covariance moments). Returns
// null when the inputs are unusable: not arrays, different lengths, fewer than 2
// points, or any non-finite pair (pairing is strict — no silent dropping).
function moments(a,b){
  if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length||a.length<2)return null;
  const n=a.length;
  let sa=0,sb=0;
  for(let i=0;i<n;i++){
    const x=a[i],y=b[i];
    if(!Number.isFinite(x)||!Number.isFinite(y))return null;
    sa+=x;
    sb+=y;
  }
  const ma=sa/n,mb=sb/n;
  let sxy=0,sxx=0,syy=0;
  for(let i=0;i<n;i++){
    const dx=a[i]-ma,dy=b[i]-mb;
    sxy+=dx*dy;
    sxx+=dx*dx;
    syy+=dy*dy;
  }
  return {sxy,sxx,syy};
}

// Pearson correlation in [-1,1]. Returns null when it is *undefined* — bad input
// or zero variance in either series (denominator would be 0): a constant series
// has no direction, so we fail safe with null instead of NaN. Results within
// floating-point noise of +/-1 are snapped to exact +/-1 so perfect linear input
// always yields exact 1 / -1.
export function correlation(a,b){
  const m=moments(a,b);
  if(!m||m.sxx===0||m.syy===0)return null;
  const r=m.sxy/Math.sqrt(m.sxx*m.syy);
  if(!Number.isFinite(r))return null;
  if(r>=1-1e-15)return 1;
  if(r<=-1+1e-15)return -1;
  return Math.max(-1,Math.min(1,r));
}

// Correlation of the trailing `period` window ending at each index, aligned to the
// input (output[i] uses a/b at i-period+1..i only). Warm-up and windows with
// undefined correlation are null. Empty/mismatched input => [].
export function rollingCorrelation(a,b,period=20){
  if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length)return[];
  const out=a.map(()=>null);
  if(!Number.isFinite(period)||period<2)return out;
  period=Math.floor(period);
  for(let i=period-1;i<a.length;i++){
    out[i]=correlation(a.slice(i-period+1,i+1),b.slice(i-period+1,i+1));
  }
  return out;
}

// Beta of asset vs market returns: cov(asset, market)/var(market) (population
// moments; the divisor cancels). Null when undefined: zero market variance, short
// or mismatched series, or non-finite samples.
export function beta(assetReturns,marketReturns){
  const m=moments(assetReturns,marketReturns);
  if(!m||m.syy===0)return null;
  const b=m.sxy/m.syy;
  return Number.isFinite(b)?b:null;
}

// Strongest absolute correlation between a[i] and b[i-lag] for lag in 0..maxLag.
// Each pair uses only same-or-past b (no look-ahead); lag = how many bars b leads a.
// Ties resolve to the smallest lag. Returns {lag:null,corr:null} when nothing is
// defined (empty input, zero variance everywhere, bad maxLag).
export function lagCorrelation(a,b,maxLag=5){
  const none={lag:null,corr:null};
  if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length)return none;
  if(!Number.isFinite(maxLag)||maxLag<0)return none;
  maxLag=Math.floor(maxLag);
  let best=none;
  for(let lag=0;lag<=maxLag;lag++){
    const n=a.length-lag;
    if(n<2)break;
    const c=correlation(a.slice(lag),b.slice(0,n));
    if(c===null)continue;
    if(best.corr===null||Math.abs(c)>Math.abs(best.corr))best={lag,corr:c};
  }
  return best;
}

const BULLISH=new Set(["up","bull","bullish","long","buy","positive","+1","1"]);
const BEARISH=new Set(["down","bear","bearish","short","sell","negative","-1"]);
const NEUTRAL=new Set(["neutral","sideways","flat","wait","hold","none","0"]);

// Normalize a directional signal to +1/-1/0; null for anything unknown/missing.
function normalizeSignal(v){
  if(v===null||v===undefined)return null;
  if(typeof v==="number")return Number.isFinite(v)?(v>0?1:v<0?-1:0):null;
  if(typeof v==="string"){
    const s=v.trim().toLowerCase();
    if(BULLISH.has(s))return 1;
    if(BEARISH.has(s))return -1;
    if(NEUTRAL.has(s))return 0;
    return null;
  }
  return null;
}

// Conservative agreement check between a primary signal and a confirmatory one.
// Fail-closed: any unknown/missing input => {confirmed:false, reason:"UNKNOWN"};
// neutral inputs never confirm; only matching non-zero directions confirm.
export function confirmSignal(primary,confirmatory){
  const p=normalizeSignal(primary),c=normalizeSignal(confirmatory);
  if(p===null||c===null)return {confirmed:false,reason:"UNKNOWN"};
  if(p===0||c===0)return {confirmed:false,reason:"NEUTRAL"};
  if(p!==c)return {confirmed:false,reason:"CONFLICT"};
  return {confirmed:true,reason:p===1?"AGREE_BULLISH":"AGREE_BEARISH"};
}

// Relative strength of a vs b. line[i]=a[i]/b[i]; ratio[i]=line[i]/line[i-period]
// (growth factor of the RS line over `period` bars, 1 = unchanged). Both arrays are
// aligned to the input; warm-up and undefined points (zero/invalid denominators)
// are null. Empty/mismatched input => {line:[],ratio:[]}.
export function relativeStrength(a,b,period=20){
  if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length)return {line:[],ratio:[]};
  const n=a.length;
  const line=new Array(n).fill(null);
  const ratio=new Array(n).fill(null);
  if(!Number.isFinite(period)||period<1)return {line,ratio};
  period=Math.floor(period);
  for(let i=0;i<n;i++){
    const x=a[i],y=b[i];
    if(Number.isFinite(x)&&Number.isFinite(y)&&y!==0){
      const v=x/y;
      if(Number.isFinite(v))line[i]=v;
    }
  }
  for(let i=period;i<n;i++){
    const cur=line[i],base=line[i-period];
    if(cur!==null&&base!==null&&base!==0){
      const v=cur/base;
      if(Number.isFinite(v))ratio[i]=v;
    }
  }
  return {line,ratio};
}
