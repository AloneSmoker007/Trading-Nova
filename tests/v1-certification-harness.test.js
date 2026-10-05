import test from "node:test";
import assert from "node:assert/strict";
import {validateEvidenceRecord,validateCertificationEvidence,REQUIRED_EVIDENCE} from "../scripts/evidence-schema.js";

test("evidence record rejects missing artifact and invalid result",()=>{
  const x=validateEvidenceRecord({id:"x",environment:"ci",timestamp:new Date().toISOString(),operator:"test",result:"PASS"});
  assert.equal(x.valid,false);
  assert.ok(x.missing.includes("artifact"));
});

test("certification evidence fails closed when records are missing",()=>{
  const x=validateCertificationEvidence([]);
  assert.equal(x.certified,false);
  assert.deepEqual(x.missing,REQUIRED_EVIDENCE);
});

test("certification evidence passes only with complete valid records",()=>{
  const records=REQUIRED_EVIDENCE.map(id=>({id,environment:"controlled",timestamp:new Date().toISOString(),operator:"human",artifact:"artifact/"+id,result:"PASS"}));
  assert.equal(validateCertificationEvidence(records).certified,true);
});
