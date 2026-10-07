import test from "node:test";
import assert from "node:assert/strict";
import {buildPortfolioState} from "../src/risk/portfolio.js";
import {createRiskConfig,evaluateRiskGate} from "../src/risk/gate.js";
import {createPaperExecution} from "../src/execution/paper.js";
import {reconcileOrder,requireReconciled} from "../src/reconciliation/reconcile.js";
import {appendJournalEntry,verifyJournal} from "../src/journal/journal.js";
import {runBacktest} from "../src/backtest/engine.js";
import {scoreOpportunity,calibratedProbability} from "../src/research/opportunity.js";
import {createStrategy,promoteStrategy} from "../src/lifecycle/registry.js";
import {createCircuitBreaker} from "../src/reliability/circuit-breaker.js";
import {classifyRegime} from "../src/intelligence/regime.js";

test("risk gate fails closed and enforces limits",()=>{
 const p=buildPortfolioState({cash:10000,positions:[],startingEquity:10000});
 const {config,hash}=createRiskConfig({version:"1",maxPositionNotional:1000,maxGrossExposure:3000,maxDailyLoss:500,maxDrawdown:.2,maxLeverage:1,maxConcentrationNotional:1000});
 assert.equal(evaluateRiskGate({order:{symbol:"BTC",side:"BUY",quantity:2,price:600},portfolio:p,riskConfig:config,approvedConfigHash:hash}).decision,"NO_TRADE");
 assert.equal(evaluateRiskGate({order:{symbol:"BTC",side:"BUY",quantity:1,price:500},portfolio:p,riskConfig:config,approvedConfigHash:hash}).decision,"ALLOW");
 assert.equal(evaluateRiskGate({order:{symbol:"BTC",side:"BUY",quantity:1,price:500},portfolio:p,riskConfig:config,approvedConfigHash:hash,dataFresh:false}).decision,"NO_TRADE");
});
test("paper execution reconciles",()=>{
 const p=buildPortfolioState({cash:10000,positions:[],startingEquity:10000});
 const {config,hash}=createRiskConfig({version:"1",maxPositionNotional:1000,maxGrossExposure:3000,maxDailyLoss:500,maxDrawdown:.2,maxLeverage:1,maxConcentrationNotional:1000});
 const ex=createPaperExecution(), order={symbol:"BTC",side:"BUY",quantity:1,price:500};
 const verdict=evaluateRiskGate({order,portfolio:p,riskConfig:config,approvedConfigHash:hash});
 const fill=ex.submit(order,{gateArtifact:verdict.artifact}); const r=reconcileOrder({order,fill}); assert.equal(r.status,"RECONCILED"); assert.equal(requireReconciled(r),true);
});
test("journal is append-only verifiable",()=>{const c=[];appendJournalEntry(c,{type:"THESIS",id:1});appendJournalEntry(c,{type:"ORDER",id:2});assert.equal(verifyJournal(c),true);c[0].entry.id=9;assert.equal(verifyJournal(c),false);});
test("backtest is deterministic",()=>{const candles=[{close:100},{close:110},{close:120}];const a=runBacktest({candles,startingCash:1000,strategy:(c,s)=>c.close===100?{side:"BUY",quantity:2}:{side:"SELL",quantity:2}});const b=runBacktest({candles,startingCash:1000,strategy:(c,s)=>c.close===100?{side:"BUY",quantity:2}:{side:"SELL",quantity:2}});assert.deepEqual(a,b);});
test("opportunity score separates score and calibrated probability",()=>{assert.equal(scoreOpportunity({technical:90,macro:60}).score,75);assert.equal(calibratedProbability({wins:67,losses:33,minSamples:100}),.67);assert.equal(calibratedProbability({wins:6,losses:4,minSamples:100}),null);});
test("promotion requires certificate and tests",()=>{let s=createStrategy("mean-reversion","1");assert.throws(()=>promoteStrategy(s,"validated"),/certificate/);s=promoteStrategy(s,"validated",{certificate:true,testsPassed:true});assert.equal(s.state,"validated");});
test("circuit breaker and regime classifier are deterministic",()=>{const b=createCircuitBreaker({maxFailures:2,cooldownMs:1000});b.recordFailure();assert.equal(b.isOpen(),false);b.recordFailure();assert.equal(b.isOpen(),true);assert.equal(classifyRegime({trend:.8,volatility:.2,volume:1}),"UPTREND");});
