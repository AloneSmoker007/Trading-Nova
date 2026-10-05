import test from "node:test";
import assert from "node:assert/strict";
import {createRiskConfig,evaluateRiskGate,hashRiskConfig} from "../src/risk/gate.js";
import {createPaperExecution} from "../src/execution/paper.js";
import {approveRiskConfig,assertApprovedRiskConfig} from "../src/persistence/risk-config.js";
import {createCheckpoint,restoreCheckpoint} from "../src/recovery/checkpoint.js";
import {DurableStore} from "../src/persistence/store.js";
import {unknownMeansStop,independentSafetyDecision} from "../src/reliability/common-mode.js";

test("Task 24 risk gate requires approved config and valid side",()=>{
 const p={equity:10000,cash:10000,positions:[],grossExposure:0,netExposure:0,dailyPnl:0,drawdown:0};
 const {config,hash}=createRiskConfig({version:"24",maxPositionNotional:1000,maxGrossExposure:3000,maxDailyLoss:500,maxDrawdown:.2,maxLeverage:1});
 assert.equal(evaluateRiskGate({order:{symbol:"BTC",side:"BUY",quantity:1,price:500},portfolio:p,riskConfig:config}).decision,"NO_TRADE");
 assert.equal(evaluateRiskGate({order:{symbol:"BTC",side:"HOLD",quantity:1,price:500},portfolio:p,riskConfig:config,approvedConfigHash:hash}).decision,"NO_TRADE");
 assert.equal(evaluateRiskGate({order:{symbol:"BTC",side:"BUY",quantity:1,price:500},portfolio:p,riskConfig:config,approvedConfigHash:hash}).decision,"ALLOW");
});
test("Task 24 risk config hashing is key-order stable",()=>{
 assert.equal(hashRiskConfig({b:2,a:{d:4,c:3}}),hashRiskConfig({a:{c:3,d:4},b:2}));
 const approved=approveRiskConfig({version:"1",maxPositionNotional:100,maxGrossExposure:200,maxDailyLoss:20,maxDrawdown:.1,maxLeverage:1}," human ");
 assert.equal(approved.approvedBy,"human");
 assert.equal(assertApprovedRiskConfig(approved),true);
});
test("Task 24 paper execution rejects invalid orders and deduplicates idempotency keys",()=>{
 const ex=createPaperExecution();
 assert.throws(()=>ex.submit({symbol:"BTC",side:"HOLD",quantity:1,price:1}),/invalid paper order/);
 const a=ex.submit({symbol:"BTC",side:"BUY",quantity:1,price:1,idempotencyKey:"k"});
 const b=ex.submit({symbol:"BTC",side:"BUY",quantity:1,price:1,idempotencyKey:"k"});
 assert.equal(a.id,b.id);
 assert.equal(ex.get(a.id).symbol,"BTC");
});
test("Task 24 recovery rejects tampered journal state",()=>{
 const s=new DurableStore(); s.appendAudit({type:"ORDER",id:"1"});
 const cp=createCheckpoint(s); cp.snapshot.journal[0].entry.id="tampered";
 assert.throws(()=>restoreCheckpoint(new DurableStore(),cp),/integrity/);
});
test("Task 24 independent safety remains able to veto",()=>{
 assert.equal(unknownMeansStop("UNKNOWN"),true);
 assert.deepEqual(independentSafetyDecision({primaryAllowed:true,independentChecks:[true,false]}),{allowed:false,blockedByIndependentSafety:true});
});

test("reduce-only closes a long position even when kill switch, drawdown and daily loss are active",()=>{
 const p={equity:10000,cash:0,positions:[{symbol:"BTC",quantity:2,markPrice:5000}],grossExposure:10000,netExposure:10000,dailyPnl:-1000,drawdown:.2};
 const {config,hash}=createRiskConfig({version:"reduce-long",maxPositionNotional:500,maxGrossExposure:1000,maxDailyLoss:500,maxDrawdown:.1,maxLeverage:.1,maxConcentrationNotional:0});
 const r=evaluateRiskGate({order:{symbol:"BTC",side:"SELL",quantity:1,price:5000,reduceOnly:true},portfolio:p,riskConfig:config,approvedConfigHash:hash,killSwitch:true});
 assert.equal(r.decision,"ALLOW");
 assert.equal(r.validReduction,true);
 assert.equal(r.projectedGrossExposure,5000);
});

test("reduce-only closes a short position with BUY without adding gross exposure",()=>{
 const p={equity:10000,cash:20000,positions:[{symbol:"BTC",quantity:-2,markPrice:5000}],grossExposure:10000,netExposure:-10000,dailyPnl:0,drawdown:0};
 const {config,hash}=createRiskConfig({version:"reduce-short",maxPositionNotional:500,maxGrossExposure:1000,maxDailyLoss:500,maxDrawdown:.1,maxLeverage:.1,maxConcentrationNotional:0});
 const r=evaluateRiskGate({order:{symbol:"BTC",side:"BUY",quantity:1,price:5000,reduceOnly:true},portfolio:p,riskConfig:config,approvedConfigHash:hash});
 assert.equal(r.decision,"ALLOW");
 assert.equal(r.validReduction,true);
 assert.equal(r.projectedGrossExposure,5000);
});

test("reduce-only cannot flip, open, or exceed the existing position",()=>{
 const p={equity:10000,cash:0,positions:[{symbol:"BTC",quantity:2,markPrice:5000}],grossExposure:10000,netExposure:10000,dailyPnl:0,drawdown:0};
 const {config,hash}=createRiskConfig({version:"invalid-reduction",maxPositionNotional:10000,maxGrossExposure:20000,maxDailyLoss:500,maxDrawdown:.5,maxLeverage:2,maxConcentrationNotional:10000});
 assert.equal(evaluateRiskGate({order:{symbol:"BTC",side:"BUY",quantity:1,price:5000,reduceOnly:true},portfolio:p,riskConfig:config,approvedConfigHash:hash}).decision,"NO_TRADE");
 assert.equal(evaluateRiskGate({order:{symbol:"BTC",side:"SELL",quantity:3,price:5000,reduceOnly:true},portfolio:p,riskConfig:config,approvedConfigHash:hash}).decision,"NO_TRADE");
 assert.equal(evaluateRiskGate({order:{symbol:"ETH",side:"SELL",quantity:1,price:5000,reduceOnly:true},portfolio:p,riskConfig:config,approvedConfigHash:hash}).decision,"NO_TRADE");
});

test("stale critical data still blocks reduce-only and normal orders remain blocked by kill switch",()=>{
 const p={equity:10000,cash:0,positions:[{symbol:"BTC",quantity:2,markPrice:5000}],grossExposure:10000,netExposure:10000,dailyPnl:0,drawdown:0};
 const {config,hash}=createRiskConfig({version:"safety-boundary",maxPositionNotional:10000,maxGrossExposure:20000,maxDailyLoss:500,maxDrawdown:.5,maxLeverage:2,maxConcentrationNotional:10000});
 const close=evaluateRiskGate({order:{symbol:"BTC",side:"SELL",quantity:1,price:5000,reduceOnly:true},portfolio:p,riskConfig:config,approvedConfigHash:hash,dataFresh:false});
 const open=evaluateRiskGate({order:{symbol:"ETH",side:"BUY",quantity:1,price:100,reduceOnly:false},portfolio:p,riskConfig:config,approvedConfigHash:hash,killSwitch:true});
 assert.equal(close.decision,"NO_TRADE");
 assert.ok(close.reasons.includes("STALE_CRITICAL_DATA"));
 assert.equal(open.decision,"NO_TRADE");
 assert.ok(open.reasons.includes("EMERGENCY_KILL_SWITCH"));
});

test("zero concentration limit blocks new exposure",()=>{
 const p={equity:10000,cash:10000,positions:[],grossExposure:0,netExposure:0,dailyPnl:0,drawdown:0};
 const {config,hash}=createRiskConfig({version:"zero-concentration",maxPositionNotional:1000,maxGrossExposure:5000,maxDailyLoss:500,maxDrawdown:.5,maxLeverage:1,maxConcentrationNotional:0});
 const r=evaluateRiskGate({order:{symbol:"BTC",side:"BUY",quantity:1,price:100},portfolio:p,riskConfig:config,approvedConfigHash:hash});
 assert.equal(r.decision,"NO_TRADE");
 assert.ok(r.reasons.includes("MAX_CONCENTRATION"));
});
