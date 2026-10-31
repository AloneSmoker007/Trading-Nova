import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {parseArgs,loadEvidence,buildReport,formatReport} from "../scripts/validate-evidence.js";
import {REQUIRED_EVIDENCE} from "../scripts/evidence-schema.js";

const CLI=path.join(path.dirname(fileURLToPath(import.meta.url)),"..","scripts","validate-evidence.js");

function record(id,overrides={}){
  const base={id,environment:"production",timestamp:"2026-10-30T00:00:00.000Z",operator:"human",artifact:`artifact/${id}`,result:"PASS",...overrides};
  if(id==="backup-restore-rto-rpo"){
    return {rtoMs:900000,rpoMs:300000,artifactSha256:"b".repeat(64),productionEligible:true,...base};
  }
  return base;
}

async function withDir(files,fn){
  const dir=await mkdtemp(path.join(tmpdir(),"evidence-validate-"));
  try{
    for(const [name,content] of Object.entries(files)){
      await writeFile(path.join(dir,name),typeof content==="string"?content:JSON.stringify(content));
    }
    return await fn(dir);
  }finally{
    await rm(dir,{recursive:true,force:true});
  }
}

function run(args){
  return spawnSync(process.execPath,[CLI,...args],{encoding:"utf8"});
}

test("parseArgs rejects unknown flags and empty --dir",()=>{
  assert.throws(()=>parseArgs(["--nope"]),/unknown argument/);
  assert.throws(()=>parseArgs(["--dir"]),/requires a path/);
  assert.deepEqual({...parseArgs(["--dir=out","--json"])},{dir:"out",json:true,allowIncomplete:false,help:false});
});

test("a missing evidence directory reports every requirement as missing",async()=>{
  const loaded=await loadEvidence(path.join(tmpdir(),"evidence-validate-does-not-exist"));
  const report=buildReport(loaded);
  assert.equal(report.certified,false);
  assert.deepEqual(report.missing,[...REQUIRED_EVIDENCE]);
  assert.match(formatReport(report),/NOT CERTIFIED/);
});

test("a complete valid pack is certified",async()=>{
  await withDir({"pack.json":REQUIRED_EVIDENCE.map(id=>record(id))},async dir=>{
    const report=buildReport(await loadEvidence(dir));
    assert.equal(report.certified,true);
    assert.match(formatReport(report),/^EVIDENCE PACK: CERTIFIED/);
    assert.equal(run(["--dir",dir]).status,0);
  });
});

test("a BLOCKED record is not production evidence and blocks certification",async()=>{
  const records=REQUIRED_EVIDENCE.map(id=>record(id));
  records[1]=record("backup-restore-rto-rpo",{result:"BLOCKED",blockedReason:"drill host is local"});
  await withDir({"pack.json":records},async dir=>{
    const report=buildReport(await loadEvidence(dir));
    assert.equal(report.certified,false);
    assert.deepEqual(report.blocked,["backup-restore-rto-rpo"]);
    assert.match(formatReport(report),/blocked: backup-restore-rto-rpo - drill host is local/);
    const result=run(["--dir",dir]);
    assert.equal(result.status,1);
    assert.match(result.stdout,/NOT CERTIFIED/);
  });
});

test("a PASS backup/restore record without measured RTO/RPO is not certification evidence",async()=>{
  const records=REQUIRED_EVIDENCE.map(id=>record(id));
  records[1]=record("backup-restore-rto-rpo",{rtoMs:undefined,rpoMs:undefined,artifactSha256:undefined});
  await withDir({"pack.json":records},async dir=>{
    const report=buildReport(await loadEvidence(dir));
    assert.equal(report.certified,false);
    assert.equal(report.invalid.length,0,"the record is well-formed, it is just unsupported");
    assert.deepEqual(report.unsupported,["backup-restore-rto-rpo"]);
    const text=formatReport(report);
    assert.match(text,/unsupported: backup-restore-rto-rpo/);
    assert.match(text,/rtoMs must be a measured duration/);
    assert.equal(run(["--dir",dir]).status,1);
  });
});

test("a PASS record that was not produced in production cannot certify",async()=>{
  const records=REQUIRED_EVIDENCE.map(id=>record(id));
  records[1]=record("backup-restore-rto-rpo",{productionEligible:false});
  await withDir({"pack.json":records},async dir=>{
    const report=buildReport(await loadEvidence(dir));
    assert.equal(report.certified,false);
    assert.match(formatReport(report),/PASS requires productionEligible:true/);
  });
});

test("a BLOCKED record must say why it is blocked",async()=>{
  const records=REQUIRED_EVIDENCE.map(id=>record(id));
  records[3]=record("observability",{result:"BLOCKED"});
  await withDir({"pack.json":records},async dir=>{
    const report=buildReport(await loadEvidence(dir));
    assert.equal(report.certified,false);
    assert.match(formatReport(report),/unsupported: observability .*BLOCKED without blockedReason/);
    assert.equal(run(["--dir",dir]).status,1);
  });
});

test("duplicate ids across files fail closed instead of last-write-wins",async()=>{
  const records=REQUIRED_EVIDENCE.map(id=>record(id));
  await withDir({"a.json":records,"b.json":record("observability")},async dir=>{
    const report=buildReport(await loadEvidence(dir));
    assert.equal(report.certified,false);
    assert.equal(report.duplicates.length,1);
    assert.equal(report.duplicates[0].id,"observability");
    assert.match(formatReport(report),/duplicate id: observability/);
    assert.equal(run(["--dir",dir]).status,1);
  });
});

test("invalid JSON exits 2 and names the offending file",async()=>{
  await withDir({"broken.json":"{not json"},async dir=>{
    const result=run(["--dir",dir]);
    assert.equal(result.status,2);
    assert.match(result.stderr+result.stdout,/broken\.json/);
  });
});

test("an invalid record lists the fields it is missing",async()=>{
  const records=REQUIRED_EVIDENCE.map(id=>record(id));
  records[2]=record("observability",{artifact:undefined,result:"UNKNOWN"});
  await withDir({"pack.json":records},async dir=>{
    const text=formatReport(buildReport(await loadEvidence(dir)));
    assert.match(text,/invalid: observability .*fields: artifact; result not PASS\/FAIL\/BLOCKED\/NOT_RUN/);
  });
});

test("--allow-incomplete reports status but exits 0",async()=>{
  await withDir({"one.json":record("observability")},async dir=>{
    const result=run(["--dir",dir,"--allow-incomplete"]);
    assert.equal(result.status,0);
    assert.match(result.stdout,/NOT CERTIFIED/);
  });
});

test("--json emits the machine-readable report",async()=>{
  await withDir({"one.json":record("observability")},async dir=>{
    const result=run(["--dir",dir,"--json","--allow-incomplete"]);
    const parsed=JSON.parse(result.stdout);
    assert.equal(parsed.certified,false);
    assert.ok(parsed.missing.includes("human-approval"));
  });
});
