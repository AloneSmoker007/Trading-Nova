import test from "node:test";
import assert from "node:assert/strict";
import {createRiskConfig,evaluateRiskGate,hashRiskConfig} from "../src/risk/gate.js";
import {createPaperExecution} from "../src/execution/paper.js";
import {approveRiskConfig,assertApprovedRiskConfig} from "../src/persistence/risk-config.js";
import {createCheckpoint,restoreCheckpoint} from "../src/recovery/checkpoint.js";
import {DurableStore} from "../src/persistence/store.js";
import {unknownMeansStop,independentSafetyDecision} from "../src/reliability/common-mode.js";

test("Task 24 risk gate requires approved config and valid side",()=>{
 const p={equity:10000,cash:10000,positions:[],grossExposure:0,dailyPnl:0,drawdown:0};
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