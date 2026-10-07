import {normalizeQuote,normalizeCandle} from "./interface.js";
const BASE="https://api.binance.com";
const AbortSignalCtor=globalThis.AbortSignal;
const DEFAULT_TIMEOUT_MS=10000;
// Binance public REST connector. Every request is bounded by a hard deadline
// (AbortSignal.timeout + a timer race that also covers transports ignoring the
// signal): a stalled upstream rejects with "market data timeout" instead of
// leaving the data pipeline pending forever.
export class BinancePublicConnector{
  constructor({fetchImpl=globalThis.fetch,baseUrl=BASE,now=()=>Date.now(),timeoutMs=DEFAULT_TIMEOUT_MS}={}){
    this.fetchImpl=fetchImpl;this.baseUrl=baseUrl;this.now=now;
    this.timeoutMs=Number.isFinite(timeoutMs)&&timeoutMs>0?timeoutMs:DEFAULT_TIMEOUT_MS;
  }
  async request(path,params={}){
    const u=new URL(path,this.baseUrl);for(const[k,v]of Object.entries(params))u.searchParams.set(k,String(v));
    const timeoutMs=this.timeoutMs;
    const signal=AbortSignalCtor&&typeof AbortSignalCtor.timeout==="function"?AbortSignalCtor.timeout(timeoutMs):undefined;
    let timer=null;let timedOut=false;
    const deadline=new Promise((_resolve,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new Error("market data timeout"));},timeoutMs);});
    const work=(async()=>{const r=await this.fetchImpl(u,signal?{signal}:undefined);if(!r.ok)throw new Error("market data http "+r.status);return r.json();})();
    try{return await Promise.race([work,deadline]);}
    catch(e){throw timedOut?new Error("market data timeout"):e;}
    finally{if(timer)clearTimeout(timer);}
  }
  async getQuote(symbol){const t=this.now(),x=await this.request("/api/v3/ticker/bookTicker",{symbol:symbol.toUpperCase()});return normalizeQuote({source:"binance-public",symbol:x.symbol,bid:Number(x.bidPrice),ask:Number(x.askPrice),timestamp:t,receivedAt:this.now()});}
  async getCandles(symbol,{interval="1m",limit=500}={}){if(limit<1||limit>1000)throw new Error("invalid candle limit");const rows=await this.request("/api/v3/klines",{symbol:symbol.toUpperCase(),interval,limit});return rows.map(r=>normalizeCandle({source:"binance-public",symbol,openTime:Number(r[0]),closeTime:Number(r[6]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5]),receivedAt:this.now()}));}
  websocketUrl(symbol,stream="trade"){return "wss://stream.binance.com:9443/ws/"+symbol.toLowerCase()+"@"+stream;}
}
