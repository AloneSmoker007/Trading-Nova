// server/app.js — thin localhost HTTP server for the Trading-Nova dashboard.
import {createServer} from "node:http";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {createMarketService} from "./market.js";
import {createApi} from "./api.js";
import {readStatic} from "./static.js";
import {getBoundedTokenBucket} from "../src/security/client-rate-limiters.js";
import {createTradingTutor,validateInput,tutorConfigurationStatus} from "./tutor.js";
import {createAccessGuard} from "./access-guard.js";
import {paperExecutionCostConfigFromEnv, validatePaperExecutionCostConfig} from "../src/execution/costs.js";

const REPO_ROOT=join(dirname(fileURLToPath(import.meta.url)),"..");
const MAX_URL_LENGTH=2048;
const MAX_BODY_LENGTH=16384;
const PAPER_ORDER_RATE_CAPACITY=30;
const PAPER_ORDER_RATE_REFILL_PER_SECOND=0.5;
const SECURITY_HEADERS=Object.freeze({
  "Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss://stream.binance.com:9443; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY","Cross-Origin-Opener-Policy":"same-origin"
});
function readRequestBody(req){return new Promise((resolve,reject)=>{const chunks=[];let size=0,complete=false,tooLarge=false;req.on("data",chunk=>{if(tooLarge)return;size+=chunk.length;if(size>MAX_BODY_LENGTH){tooLarge=true;complete=true;chunks.length=0;resolve({tooLarge:true});return;}chunks.push(chunk);});req.on("end",()=>{if(complete)return;complete=true;resolve({body:Buffer.concat(chunks).toString("utf8")});});req.on("error",error=>{if(complete)return;complete=true;reject(error);});});}

function sendJson(res,status,body,extra={}){const {omitBody=false,...headers}=extra;const payload=JSON.stringify(body);res.writeHead(status,{...SECURITY_HEADERS,"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Content-Length":Buffer.byteLength(payload),...headers});res.end(omitBody?undefined:payload);}

function matchApi(pathname){
  if(pathname==="/api/health")return{name:"health",params:{}};
  if(pathname==="/api/tutor/chat")return{name:"tutorChat",params:{}};
  if(pathname==="/api/tutor/status")return{name:"tutorStatus",params:{}};
  if(pathname==="/api/markets")return{name:"markets",params:{}};
  if(pathname==="/api/watchlist")return{name:"watchlist",params:{}};
  let m=/^\/api\/market\/([^\/]+)$/.exec(pathname);if(m)return{name:"marketData",params:{symbol:m[1]}};
  m=/^\/api\/indicators\/([^\/]+)$/.exec(pathname);if(m)return{name:"indicators",params:{symbol:m[1]}};
  m=/^\/api\/ai\/council\/([^\/]+)$/.exec(pathname);if(m)return{name:"aiCouncil",params:{symbol:m[1]}};
  if(pathname==="/api/portfolio")return{name:"portfolio",params:{}};
  if(pathname==="/api/journal")return{name:"journal",params:{}};
  if(pathname==="/api/journal/entry")return{name:"addJournalEntry",params:{}};
  if(pathname==="/api/backtest")return{name:"backtest",params:{}};
  if(pathname==="/api/orders")return{name:"orders",params:{}};
  if(pathname==="/api/learning/outcomes")return{name:"learningOutcomes",params:{}};
  if(pathname==="/api/paper/orders")return{name:"paperOrders",params:{}};
  let mCancel=/^\/api\/paper\/orders\/([^/]+)\/cancel$/.exec(pathname);if(mCancel)return{name:"cancelPaperOrder",params:{orderId:decodeURIComponent(mCancel[1])}};
  if(pathname==="/api/risk/status")return{name:"riskStatus",params:{}};
  if(pathname==="/api/strategy/lab")return{name:"strategyLab",params:{}};
  return null;
}

export function createNovaServer({fetchImpl=globalThis.fetch,now=()=>Date.now(),stateFile=join(REPO_ROOT,"db","paper-state.json"),executionStateFile=join(REPO_ROOT,"db","paper-orders.json"),store,webRoot=join(REPO_ROOT,"web"),tradingMode="paper",log=null,paperFeeRate,paperSlippageBps}={}){
  if(tradingMode!=="paper")throw new Error("Trading Nova web server is paper-only; non-paper modes are blocked.");
  const environmentCosts=paperExecutionCostConfigFromEnv();
  const executionCosts=validatePaperExecutionCostConfig({
    feeRate:paperFeeRate===undefined?environmentCosts.feeRate:paperFeeRate,
    slippageBps:paperSlippageBps===undefined?environmentCosts.slippageBps:paperSlippageBps
  });
  const market=createMarketService({fetchImpl,now});const startedAt=now();const api=createApi({market,stateFile,executionStateFile,store,now,tradingMode:"paper",startedAt,paperFeeRate:executionCosts.feeRate,paperSlippageBps:executionCosts.slippageBps});const orderLimiters=new Map();const tutorLimiters=new Map();const watchlistLimiters=new Map();const tutorChat=createTradingTutor({fetchImpl,now});const accessGuard=createAccessGuard({password:process.env.NOVA_ACCESS_PASSWORD,secret:process.env.NOVA_SESSION_SECRET,production:process.env.NODE_ENV==="production",now});
  const server=createServer(async(req,res)=>{const method=req.method||"GET";try{
    if(typeof req.url!=="string"||req.url.length===0||req.url.length>MAX_URL_LENGTH){sendJson(res,400,{ok:false,state:"error",error:{code:"bad-request",message:"malformed request target"}},{omitBody:method==="HEAD"});return;}
    let url;try{url=new URL(req.url,"http://127.0.0.1");}catch{sendJson(res,400,{ok:false,state:"error",error:{code:"bad-request",message:"malformed request target"}},{omitBody:method==="HEAD"});return;}
    const pathname=url.pathname;
    if(await accessGuard.handle(req,res,pathname,readRequestBody))return;
    if(pathname==="/api/auth/status") { if(method!=="GET"&&method!=="HEAD"){sendJson(res,405,{ok:false,state:"error",error:{code:"method-not-allowed",message:"method not allowed"}},{Allow:"GET, HEAD"});return;} sendJson(res,200,{ok:true,data:{privateAccessEnabled:accessGuard.enabled}},{omitBody:method==="HEAD"});return; }
    if(pathname.startsWith("/api/")){
      const route=matchApi(pathname);
      if(!route){sendJson(res,404,{ok:false,state:"error",error:{code:"not-found",message:"unknown API route"}},{omitBody:method==="HEAD"});return;}
      const allowed=route.name==="paperOrders"?["GET","HEAD","POST"]
        :(route.name==="watchlist"?["GET","HEAD","PUT"]
        :(["cancelPaperOrder","addJournalEntry","tutorChat"].includes(route.name)?["POST"]:["GET","HEAD"]));
      if(!allowed.includes(method)){sendJson(res,405,{ok:false,state:"error",error:{code:"method-not-allowed",message:"method not allowed"}},{Allow:allowed.join(", ")});return;}
      if(route.name==="watchlist"&&method==="PUT"){
        const limiter=getBoundedTokenBucket(watchlistLimiters,req.socket.remoteAddress||"unknown",{capacity:30,refillPerSecond:0.5,now});
        if(!limiter.consume()){sendJson(res,429,{ok:false,state:"error",error:{code:"rate-limited",message:"Watchlist edits are temporarily rate limited."}},{"Retry-After":"2"});return;}
        const request=await readRequestBody(req);if(request.tooLarge){res.shouldKeepAlive=false;sendJson(res,413,{ok:false,state:"error",error:{code:"body-too-large",message:"Watchlist request is too large."}},{Connection:"close"});return;}
        const out=await api.saveWatchlist(request.body);sendJson(res,out.status,out.body);return;
      }
      if(route.name==="tutorStatus"){
        sendJson(res,200,{ok:true,data:tutorConfigurationStatus()},{omitBody:method==="HEAD"});return;
      }
      if(route.name==="tutorChat"){
        const clientKey=req.socket.remoteAddress||"unknown";const limiter=getBoundedTokenBucket(tutorLimiters,clientKey,{capacity:10,refillPerSecond:1/12,now});if(!limiter.consume()){sendJson(res,429,{ok:false,state:"error",error:{code:"rate-limited",message:"AI Tutor requests are temporarily rate limited."}},{ "Retry-After":"12" });return;}
        const request=await readRequestBody(req);if(request.tooLarge){res.shouldKeepAlive=false;sendJson(res,413,{ok:false,state:"error",error:{code:"body-too-large",message:"request body exceeds the allowed size"}},{Connection:"close"});return;}
        let input;try{input=JSON.parse(request.body||"");}catch{sendJson(res,400,{ok:false,state:"error",error:{code:"invalid-json",message:"request body must be valid JSON"}});return;}
        // Validate before fetching optional market context so malformed chat requests cannot spend provider quota.
        const validated=validateInput(input);if(!validated.ok){sendJson(res,400,{ok:false,state:"error",error:{code:validated.code,message:validated.message}});return;}
        // Fail closed on tutor configuration before spending any market-data quota.
        // Keep this guard aligned with createTradingTutor configuration validation.
        const configuration=tutorConfigurationStatus();
        if(!configuration.configured||(validated.researchMode==="required-sources"&&!configuration.webResearchEnabled)){
          const out=await tutorChat({...input,message:validated.message,history:input.history??[]},null);sendJson(res,out.status,out.body);return;
        }
        let context=null;
        const symbol=typeof input?.symbol==="string"?input.symbol.trim().toUpperCase():"";
        if(/^[A-Z0-9]{2,24}$/.test(symbol)){
          try{
            const quote=await market.getTicker(symbol);
            if(quote?.data){
              context={
                symbol,
                marketState:quote.state,
                stale:Boolean(quote.stale),
                ageMs:Number.isFinite(quote.ageMs)?quote.ageMs:null,
                ticker:{
                  last:quote.data.last,
                  bid:quote.data.bid,
                  ask:quote.data.ask,
                  changePct24h:quote.data.changePct24h,
                  quoteVolume24h:quote.data.quoteVolume24h
                }
              };
            }
          }catch{
            context={symbol,marketState:"unavailable",stale:true};
          }
        }

        // Give Gemini context from saved learning notes only when the append-only
        // journal hash chain verifies. Journal text remains untrusted data.
        try{
          const journalSnapshot=await api.journal();
          const journalData=journalSnapshot?.status===200&&journalSnapshot.body?.ok===true
            ?journalSnapshot.body.data:null;
          if(journalData?.verified===true&&Array.isArray(journalData.entries)){
            const entries=journalData.entries.slice(-5).map((record)=>{
              const entry=record?.entry&&typeof record.entry==="object"?record.entry:record;
              return {
                recordHash:typeof record?.hash==="string"?record.hash:null,
                recordIndex:Number.isSafeInteger(record?.index)?record.index:null,
                timestamp:Number.isFinite(entry?.timestamp)?entry.timestamp:null,
                type:typeof entry?.type==="string"?entry.type.slice(0,40):"note",
                symbol:typeof entry?.symbol==="string"?entry.symbol.slice(0,24):"GENERAL",
                title:typeof entry?.title==="string"?entry.title.slice(0,120):"Saved note",
                text:typeof entry?.text==="string"?entry.text.slice(0,350):""
              };
            });
            context={...(context||{}),learningMemory:{
              state:entries.length?"verified-recent-notes":"verified-but-empty",
              journalIntegrity:"verified",
              entries,
              outcomeState:"unavailable",
              executionOutcomes:[],
              lossAutopsies:[]
            }};
            try{
              const learningSnapshot=await api.learningOutcomes();
              const learningData=learningSnapshot?.status===200&&learningSnapshot.body?.ok===true
                ?learningSnapshot.body.data:null;
              if(learningData&&Array.isArray(learningData.outcomes)){
                const recentHashes=new Set(entries.map((entry)=>entry.recordHash).filter(Boolean));
                const executionOutcomes=learningData.outcomes
                  .filter((outcome)=>recentHashes.has(outcome?.thesisRef?.hash))
                  .slice(-5)
                  .map((outcome)=>({
                    outcomeId:typeof outcome.outcomeId==="string"?outcome.outcomeId:null,
                    thesisHash:outcome.thesisRef.hash,
                    symbol:outcome.symbol,
                    direction:outcome.direction,
                    quantity:outcome.quantity,
                    openedAt:outcome.openedAt,
                    closedAt:outcome.closedAt,
                    grossPnl:outcome.grossPnl,
                    fees:outcome.fees,
                    netPnl:outcome.netPnl,
                    result:outcome.result,
                    source:outcome.source
                  }));
                context.learningMemory.outcomeState=executionOutcomes.length?"server-derived-paper-outcomes":"no-realized-linked-outcomes";
                context.learningMemory.executionOutcomes=executionOutcomes;
                const outcomeIds=new Set(executionOutcomes.map((outcome)=>outcome.outcomeId).filter(Boolean));
                context.learningMemory.lossAutopsies=(Array.isArray(learningData.lossAutopsies)?learningData.lossAutopsies:[])
                  .filter((review)=>outcomeIds.has(review?.outcomeId))
                  .slice(-5)
                  .map((review)=>({
                    outcomeId:review.outcomeId,
                    thesisHash:review.thesisHash,
                    symbol:review.symbol,
                    title:typeof review.title==="string"?review.title.slice(0,120):"Loss autopsy",
                    text:typeof review.text==="string"?review.text.slice(0,350):"",
                    tags:Array.isArray(review.tags)?review.tags.slice(0,20):[],
                    source:"user-authored-loss-autopsy"
                  }));
              }
            }catch{
              // Keep verified notes available while marking execution outcomes unavailable.
            }
          }else{
            context={...(context||{}),learningMemory:{
              state:"unavailable-or-unverified",
              journalIntegrity:"not-verified",
              entries:[]
            }};
          }
        }catch{
          context={...(context||{}),learningMemory:{
            state:"unavailable",
            journalIntegrity:"not-verified",
            entries:[]
          }};
        }
        const out=await tutorChat({...input,message:validated.message,history:input.history??[]},context);sendJson(res,out.status,out.body);return;
      }
      if(route.name==="paperOrders"&&method==="POST"){
        const clientKey=req.socket.remoteAddress||"unknown";const limiter=getBoundedTokenBucket(orderLimiters,clientKey,{capacity:PAPER_ORDER_RATE_CAPACITY,refillPerSecond:PAPER_ORDER_RATE_REFILL_PER_SECOND,now});if(!limiter.consume()){sendJson(res,429,{ok:false,state:"error",error:{code:"rate-limited",message:"too many paper-order requests"}},{"Retry-After":"2"});return;}
        const request=await readRequestBody(req);if(request.tooLarge){res.shouldKeepAlive=false;sendJson(res,413,{ok:false,state:"error",error:{code:"body-too-large",message:"request body exceeds the allowed size"}},{Connection:"close"});return;}
        const out=await api.submitPaperOrder(request.body);sendJson(res,out.status,out.body);return;
      }
      if(route.name==="cancelPaperOrder"){
        const clientKey=req.socket.remoteAddress||"unknown";const limiter=getBoundedTokenBucket(orderLimiters,clientKey,{capacity:PAPER_ORDER_RATE_CAPACITY,refillPerSecond:PAPER_ORDER_RATE_REFILL_PER_SECOND,now});if(!limiter.consume()){sendJson(res,429,{ok:false,state:"error",error:{code:"rate-limited",message:"too many paper-order requests"}},{"Retry-After":"2"});return;}
        const out=await api.cancelPaperOrder(route.params.orderId);sendJson(res,out.status,out.body);return;
      }
      if(route.name==="addJournalEntry"){
        const request=await readRequestBody(req);if(request.tooLarge){res.shouldKeepAlive=false;sendJson(res,413,{ok:false,state:"error",error:{code:"body-too-large",message:"request body exceeds the allowed size"}},{Connection:"close"});return;}
        const out=await api.addJournalEntry(request.body);sendJson(res,out.status,out.body);return;
      }
      let out;if(route.name==="marketData"||route.name==="indicators"||route.name==="aiCouncil")out=await api[route.name](url.searchParams,route.params.symbol);else out=await api[route.name](url.searchParams);sendJson(res,out.status,out.body,{omitBody:method==="HEAD"});return;}
    if(method!=="GET"&&method!=="HEAD"){sendJson(res,405,{ok:false,state:"error",error:{code:"method-not-allowed",message:"method not allowed"}},{Allow:"GET, HEAD"});return;}
    const file=await readStatic(webRoot,pathname);res.writeHead(file.status,{...SECURITY_HEADERS,"Content-Type":file.type,"Cache-Control":"no-cache","Content-Length":Buffer.byteLength(file.body)});res.end(method==="HEAD"?undefined:file.body);
  }catch(err){if(log)log("request-error",{message:err&&err.message?String(err.message):"unknown"});if(!res.headersSent)sendJson(res,500,{ok:false,state:"error",error:{code:"internal-error",message:"internal error"}});else res.end();}});
  const orderProcessingTimer=setInterval(()=>{void api.processPaperOrders().catch(()=>{});},5000);
  orderProcessingTimer.unref?.();
  server.on("close",()=>clearInterval(orderProcessingTimer));
  server.on("clientError",(_err,socket)=>{if(socket.writable)socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");});return server;
}
export {SECURITY_HEADERS,REPO_ROOT,matchApi};
