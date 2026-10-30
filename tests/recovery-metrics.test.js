import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyEnvironment,computeRto,computeRpo,buildBackupRestoreEvidence,labelLocalEvidence,BACKUP_RESTORE_EVIDENCE_ID
} from "../scripts/lib/recovery-metrics.js";

test("environment classification is derived from the connection host, not from env", () => {
  assert.equal(classifyEnvironment("postgres://localhost:5432/nova").productionEligible,false);
  assert.equal(classifyEnvironment("postgres://127.0.0.1:5432/nova").productionEligible,false);
  assert.equal(classifyEnvironment("postgres://db.internal.local:5432/nova").productionEligible,false);
  const hosted=classifyEnvironment("postgres://db.prod.example.com:5432/nova");
  assert.equal(hosted.productionEligible,true);
  assert.equal(hosted.environment,"production");
  assert.equal(hosted.host,"db.prod.example.com");
  assert.throws(()=>classifyEnvironment("not a url"),/invalid connection string/);
});

test("RTO is measured from the earliest phase start to service-ready", () => {
  const rto=computeRto([
    {name:"restore",startMs:1000,endMs:7000},
    {name:"verify",startMs:7000,endMs:8500}
  ]);
  assert.equal(rto.rtoMs,7500);
  assert.deepEqual(rto.phases.map(p=>[p.name,p.durationMs]),[["restore",6000],["verify",1500]]);
});

test("RTO rejects missing or inverted timings instead of guessing", () => {
  assert.throws(()=>computeRto([]),/at least one phase/);
  assert.throws(()=>computeRto([{name:"restore",startMs:1000}]),/numeric start and end/);
  assert.throws(()=>computeRto([{name:"restore",startMs:9000,endMs:1000}]),/ends before it starts/);
});

test("RPO is the confirmed data-loss window between last durable write and recovery point", () => {
  const rpo=computeRpo({lastDurableAt:100000,recoveryPointAt:100450});
  assert.equal(rpo.rpoMs,450);
  assert.throws(()=>computeRpo({recoveryPointAt:100450}),/last durable write/);
  assert.throws(()=>computeRpo({lastDurableAt:100500,recoveryPointAt:100450}),/precedes the last durable write/);
});

test("evidence record carries measured RTO/RPO and validates against the evidence schema", () => {
  const rto=computeRto([{name:"restore",startMs:0,endMs:4000}]);
  const rpo=computeRpo({lastDurableAt:5000,recoveryPointAt:5200});
  const record=buildBackupRestoreEvidence({
    environment:"production",productionEligible:true,operator:"ops@nova",artifact:"backup.dump",
    drillStartedAt:1000,rto,rpo,incidentToReadyMs:4000
  });
  assert.equal(record.id,BACKUP_RESTORE_EVIDENCE_ID);
  assert.equal(record.result,"PASS");
  assert.equal(record.rtoMs,4000);
  assert.equal(record.rpoMs,200);
  assert.equal(record.timestamp,new Date(1000).toISOString());
  assert.equal(record.rpoWindow.lastDurableAt,new Date(5000).toISOString());
});

test("a local drill can never be recorded as production certification evidence", () => {
  const rto=computeRto([{name:"restore",startMs:0,endMs:10}]);
  const rpo=computeRpo({lastDurableAt:0,recoveryPointAt:10});
  const local=buildBackupRestoreEvidence({
    environment:"local",productionEligible:false,operator:"dev",artifact:"backup.dump",
    drillStartedAt:0,rto,rpo,incidentToReadyMs:10
  });
  assert.equal(local.result,"PASS");
  const labelled=labelLocalEvidence(local);
  assert.equal(labelled.result,"BLOCKED");
  assert.match(labelled.blockedReason,/non-production/);
  const required=buildBackupRestoreEvidence({
    environment:"local",productionEligible:false,operator:"dev",artifact:"backup.dump",
    drillStartedAt:0,rto,rpo,incidentToReadyMs:10,requireProduction:true
  });
  assert.equal(required.result,"BLOCKED");
  assert.match(required.blockedReason,/production evidence requested/);
  assert.equal(labelLocalEvidence(required).result,"BLOCKED");
  assert.equal(labelLocalEvidence(buildBackupRestoreEvidence({
    environment:"production",productionEligible:true,operator:"ops",artifact:"backup.dump",
    drillStartedAt:0,rto,rpo,incidentToReadyMs:10
  })).result,"PASS");
});

test("evidence building refuses to invent measurements", () => {
  assert.throws(()=>buildBackupRestoreEvidence({environment:"production",productionEligible:true,operator:"ops",artifact:"a",drillStartedAt:0,rto:{},rpo:{rpoMs:1}}),/measured RTO/);
  assert.throws(()=>buildBackupRestoreEvidence({environment:"production",productionEligible:true,operator:"ops",artifact:"a",drillStartedAt:0,rto:{rtoMs:1},rpo:{}}),/measured RPO/);
  assert.throws(()=>buildBackupRestoreEvidence({environment:"production",productionEligible:true,operator:"",artifact:"a",drillStartedAt:0,rto:{rtoMs:1,phases:[]},rpo:{rpoMs:1}}),/evidence record invalid/);
});
