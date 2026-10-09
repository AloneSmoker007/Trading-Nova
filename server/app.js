// server/app.js — thin localhost HTTP server for the Trading-Nova dashboard.
import {createServer} from "node:http";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {createMarketService} from "./market.js";
import {createApi} from "./api.js";
import {readStatic} from "./static.js";
import {getBoundedTokenBucket} from "../src/security/client-rate-limiters.js";
import {createTradingTutor,validateInput} from "./tutor.js";
import {createAccessGuard} from "./access-guard.js";

const REPO_ROOT=join(dirname(fileURLToPath(import.meta.url)),"..");
const MAX_URL_LENGTH=2048;
const MAX_BODY_LENGTH=16384;
const PAPER_ORDER_RATE_CAPACITY=30;
const PAPER_ORDER_RATE_REFILL_PER_SECOND=0.5;
const SECURITY_HEADERS=Object.freeze({
  "Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY","Cross-Origin-Opener-Policy":"same-origin"
});
function readRequestBody(req){return new Promise((resolve,reject)=>{const chunks=[];let size=0,complete=false,tooLarge=false;req.on("data",chunk=>{if(tooLarge)return;size+=chunk.length;if(size>MAX_BODY_LENGTH){tooLarge=true;complete=true;chunks.length=0;resolve({tooLarge:true});return;}chunks.push(chunk);});req.on("end",()=>{if(complete)return;complete=true;resolve({body:Buffer.concat(chunks).toString("utf8")});});req.on("error",error=>{if(complete)return;complete=true;reject(error);});});}

function sendJson(res,status,body,extra={}){const {omitBody=false,...headers}=extra;const payload=JSON.stringify(body);res.writeHead(status,{...SECURITY_HEADERS,"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Content-Length":Buffer.byteLength(payload),...headers});res.end(omitBody?undefined:payload);}

function matchApi(pathname){
  if(pathname==="/api/health")return{name:"health",params:{}};
  if(pathname==="/api/tutor/chat")return{name:"tutorChat",params:{}};
  if(pathname==="/api/markets")return{name:"markets",params:{}};
  let m=/^\/api\/market\/([^\/]+)$/.exec(pathname);if(m)return{name:"marketData",params:{symbol:m[1]}};
  m=/^\/api\/indicators\/([^\/]+)$/.exec(pathname);if(m)return{name:"indicators",params:{symbol:m[1]}};
  m=/^\/api\/ai\/council\/([^\/]+)$/.exec(pathname);if(m)return{name:"aiCouncil",params:{symbol:m[1]}};
  if(pathname==="/api/portfolio")return{name:"portfolio",params:{}};
  if(pathname==="/api/journal")return{name:"journal",params:{}};
  if(pathname==="/api/journal/entry")return{name:"addJournalEntry",params:{}};
  if(pathname==="/api/backtest")return{name:"backtest",params:{}};
  if(pathname==="/api/orders")return{name:"orders",params:{}};
  if(pathname==="/api/paper/orders")return{name:"submitPaperOrder",params:{}};
  if(pathname==="/api/risk/status")return{name:"riskStatus",params:{}};
  if(pathname==="/api/strategy/lab")return{name:"strategyLab",params:{}};
  return null;
}

export function createNovaServer({fetchImpl=globalThis.fetch,now=()=>Date.now(),stateFile=join(REPO_ROOT,"db","paper-state.json"),executionStateFile=join(REPO_ROOT,"db","paper-orders.json"),store,webRoot=join(REPO_ROOT,"web"),tradingMode="paper",log=null}={}){
  if(tradingMode!=="paper")throw new Error("Trading Nova web server is paper-only; non-paper modes are blocked.");
  const market=createMarketService({fetchImpl,now});const startedAt=now();const api=createApi({market,stateFile,executionStateFile,store,now,tradingMode:"paper",startedAt});const orderLimiters=new Map();const tutorLimiters=new Map();const tutorChat=createTradingTutor({fetchImpl,now});const accessGuard=createAccessGuard({password:process.env.NOVA_ACCESS_PASSWORD,secret:process.env.NOVA_SESSION_SECRET,production:process.env.NODE_ENV==="production",now});
  const server=createServer(async(req,res)=>{const method=req.method||"GET";try{
    if(typeof req.url!=="string"||req.url.length===0||req.url.length>MAX_URL_LENGTH){sendJson(res,400,{ok:false,state:"error",error:{code:"bad-request",message:"malformed request target"}},{omitBody:method==="HEAD"});return;}
    let url;try{url=new URL(req.url,"http://127.0.0.1");}catch{sendJson(res,400,{ok:false,state:"error",error:{code:"bad-request",message:"malformed request target"}},{omitBody:method==="HEAD"});return;}
    const pathname=url.pathname;
    if(await accessGuard.handle(req,res,pathname,readRequestBody))return;
    if(pathname==="/api/auth/status") { if(method!=="GET"&&method!=="HEAD"){sendJson(res,405,{ok:false,state:"error",error:{code:"method-not-allowed",message:"method not allowed"}},{Allow:"GET, HEAD"});return;} sendJson(res,200,{ok:true,data:{privateAccessEnabled:accessGuard.enabled}},{omitBody:method==="HEAD"});return; }
    if(pathname.startsWith("/api/")){
      const route=matchApi(pathname);
      if(!route){sendJson(res,404,{ok:false,state:"error",error:{code:"not-found",message:"unknown API route"}},{omitBody:method==="HEAD"});return;}
      const allowed=(route.name==="submitPaperOrder"||route.name==="addJournalEntry"||route.name==="tutorChat")?["POST"]:["GET","HEAD"];
      if(!allowed.includes(method)){sendJson(res,405,{ok:false,state:"error",error:{code:"method-not-allowed",message:"method not allowed"}},{Allow:allowed.join(", ")});return;}
      if(route.name==="tutorChat"){
        const clientKey=req.socket.remoteAddress||"unknown";const limiter=getBoundedTokenBucket(tutorLimiters,clientKey,{capacity:10,refillPerSecond:1/12,now});if(!limiter.consume()){sendJson(res,429,{ok:false,state:"error",error:{code:"rate-limited",message:"AI Tutor requests are temporarily rate limited."}},{ "Retry-After":"12" });return;}
        const request=await readRequestBody(req);if(request.tooLarge){res.shouldKeepAlive=false;sendJson(res,413,{ok:false,state:"error",error:{code:"body-too-large",message:"request body exceeds the allowed size"}},{Connection:"close"});return;}
        let input;try{input=JSON.parse(request.body||"");}catch{sendJson(res,400,{ok:false,state:"error",error:{code:"invalid-json",message:"request body must be valid JSON"}});return;}
        // Validate before fetching optional market context so malformed chat requests cannot spend provider quota.
        const validated=validateInput(input);if(!validated.ok){sendJson(res,400,{ok:false,state:"error",error:{code:validated.code,message:validated.message}});return;}
        // Fail closed on tutor configuration before spending any market-data quota.
        // Keep this guard aligned with createTradingTutor configuration validation.
        const configuredKey=process.env.GEMINI_API_KEY;
        const configuredModel=process.env.GEMINI_MODEL;
        if(typeof configuredKey!=="string"||!configuredKey.trim()||(configuredModel!==undefined&&!/^[A-Za-z0-9._-]{1,80}$/.test(configuredModel))){
          const out=await tutorChat({...input,message:validated.message,history:input.history??[]},null);sendJson(res,out.status,out.body);return;
        }
        let context=null;const symbol=typeof input?.symbol==="string"?input.symbol.trim().toUpperCase():"";if(/^[A-Z0-9]{2,24}$/.test(symbol)){try{const quote=await market.getTicker(symbol);if(quote?.data){context={symbol,marketState:quote.state,stale:Boolean(quote.stale),ageMs:Number.isFinite(quote.ageMs)?quote.ageMs:null,ticker:{last:quote.data.last,bid:quote.data.bid,ask:quote.data.ask,changePct24h:quote.data.changePct24h,quoteVolume24h:quote.data.quoteVolume24h}};}}catch{context={symbol,marketState:"unavailable",stale:true};}}
        const out=await tutorChat({...input,message:validated.message,history:input.history??[]},context);sendJson(res,out.status,out.body);return;
      }
      if(route.name==="submitPaperOrder"){
        const clientKey=req.socket.remoteAddress||"unknown";const limiter=getBoundedTokenBucket(orderLimiters,clientKey,{capacity:PAPER_ORDER_RATE_CAPACITY,refillPerSecond:PAPER_ORDER_RATE_REFILL_PER_SECOND,now});if(!limiter.consume()){sendJson(res,429,{ok:false,state:"error",error:{code:"rate-limited",message:"too many paper-order requests"}},{"Retry-After":"2"});return;}
        const request=await readRequestBody(req);if(request.tooLarge){res.shouldKeepAlive=false;sendJson(res,413,{ok:false,state:"error",error:{code:"body-too-large",message:"request body exceeds the allowed size"}},{Connection:"close"});return;}
        const out=await api.submitPaperOrder(request.body);sendJson(res,out.status,out.body);return;
      }
      if(route.name==="addJournalEntry"){
        const request=await readRequestBody(req);if(request.tooLarge){res.shouldKeepAlive=false;sendJson(res,413,{ok:false,state:"error",error:{code:"body-too-large",message:"request body exceeds the allowed size"}},{Connection:"close"});return;}
        const out=await api.addJournalEntry(request.body);sendJson(res,out.status,out.body);return;
      }
      let out;if(route.name==="marketData"||route.name==="indicators"||route.name==="aiCouncil")out=await api[route.name](url.searchParams,route.params.symbol);else out=await api[route.name](url.searchParams);sendJson(res,out.status,out.body,{omitBody:method==="HEAD"});return;}
    if(method!=="GET"&&method!=="HEAD"){sendJson(res,405,{ok:false,state:"error",error:{code:"method-not-allowed",message:"method not allowed"}},{Allow:"GET, HEAD"});return;}
    const file=await readStatic(webRoot,pathname);res.writeHead(file.status,{...SECURITY_HEADERS,"Content-Type":file.type,"Cache-Control":"no-cache","Content-Length":Buffer.byteLength(file.body)});res.end(method==="HEAD"?undefined:file.body);
  }catch(err){if(log)log("request-error",{message:err&&err.message?String(err.message):"unknown"});if(!res.headersSent)sendJson(res,500,{ok:false,state:"error",error:{code:"internal-error",message:"internal error"}});else res.end();}});
  server.on("clientError",(_err,socket)=>{if(socket.writable)socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");});return server;
}
export {SECURITY_HEADERS,REPO_ROOT,matchApi};
