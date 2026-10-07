import test from "node:test";
import assert from "node:assert/strict";
import {DurableStore} from "../src/persistence/store.js";
import {approveRiskConfig,assertApprovedRiskConfig} from "../src/persistence/risk-config.js";
import {transitionExecution,isExecutionSafe} from "../src/reconciliation/state-machine.js";
import {createCheckpoint,restoreCheckpoint} from "../src/recovery/checkpoint.js";

test("idempotency returns exactly one logical result",async()=>{
  const s=new DurableStore(); let calls=0;
  const a=await s.transactIdempotent("order-1",()=>{calls++;return {status:"accepted"}});
  const b=await s.transactIdempotent("order-1",()=>{calls++;return {status:"different"}});
  assert.deepEqual(a,b); assert.equal(calls,1);
});

test("audit journal survives checkpoint and rejects tampering",()=>{
  const s=new DurableStore(); s.appendAudit({type:"ORDER",id:"1"}); s.appendAudit({type:"FILL",id:"1"});
  const cp=createCheckpoint(s); const restored=new DurableStore(); restoreCheckpoint(restored,cp);
  assert.equal(restored.verify(),true); cp.snapshot.journal[0].entry.id="tampered";
  assert.throws(()=>restoreCheckpoint(new DurableStore(),cp),/integrity/);
});

test("risk approval is human-bound and hash protected",()=>{
  const r=approveRiskConfig({
    version:"2",
    maxPositionNotional:100,
    maxGrossExposure:1000,
    maxDailyLoss:100,
    maxDrawdown:200,
    maxLeverage:2
  },"human-1");
  assert.equal(assertApprovedRiskConfig(r),true);
  const tampered={...r,config:{...r.config,maxPositionNotional:999}};
  assert.throws(()=>assertApprovedRiskConfig(tampered),/integrity/);
});

test("execution reconciliation state machine fails closed",()=>{
  assert.equal(transitionExecution("CREATED","SUBMITTED"),"SUBMITTED");
  assert.throws(()=>transitionExecution("CREATED","FILLED"),/invalid execution transition/);
  assert.equal(isExecutionSafe("FILLED"),false);
  assert.equal(isExecutionSafe("RECONCILED"),true);
});