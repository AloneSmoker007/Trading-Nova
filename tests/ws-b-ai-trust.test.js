// WS-B: AI council fail-closed behaviour (H1/H2).
// Garbage evidence (NaN, null, "", strings, out-of-range) must be REJECTED at
// ingestion and force decision "WAIT" + uncertainty "High" — never RESEARCH.
// Null/"" scores must never be coerced to 0-valued evidence in averages.
import test from "node:test";
import assert from "node:assert/strict";
import {evaluateEvidence} from "../src/research/council.js";
import {runResearchCouncil} from "../src/intelligence/multi-agent.js";
import {researchOpportunity} from "../src/research/brain.js";

const GARBAGE = [NaN, null, "", "abc", "80", true, false, 1e9, -1, 100.5, undefined, {}, []];

test("WS-B H1: evaluateEvidence rejects garbage scores and fails closed (WAIT/High)", () => {
  for (const bad of GARBAGE) {
    const e = evaluateEvidence({technical: [{score: bad}], macro: [{score: 30}]});
    assert.equal(e.decision, "WAIT", `garbage score ${String(bad)} must yield WAIT`);
    assert.equal(e.uncertainty, "High", `garbage score ${String(bad)} must yield High uncertainty`);
    assert.equal(e.invalid.length >= 1, true);
    assert.equal(e.conflicts.includes("INVALID_EVIDENCE"), true);
  }
});

test("WS-B H1: the historical NaN probe no longer produces confident RESEARCH", () => {
  // audit probe: evaluateEvidence({technical:[{score:NaN}],macro:[{score:30}]})
  // used to return {score:NaN, uncertainty:"Low", decision:"RESEARCH"}
  const e = evaluateEvidence({technical: [{score: NaN}], macro: [{score: 30}]});
  assert.notEqual(e.decision, "RESEARCH");
  assert.ok(Number.isFinite(e.score));
});

test("WS-B H1: null/blank scores are never averaged as 0", () => {
  const e = evaluateEvidence({technical: [{score: null}, {score: null}, {score: 90}], macro: [{score: 80}]});
  assert.equal(e.score, 85); // (90 + 80) / 2 — the two nulls contribute nothing
});

test("WS-B H1: clean evidence still reaches RESEARCH and stays labelled untrusted", () => {
  const e = evaluateEvidence({technical: [{score: 80, kind: "data"}], macro: [{score: 75, kind: "assumption"}], news: [{score: 70, kind: "interpretation"}]});
  assert.equal(e.decision, "RESEARCH");
  assert.equal(e.uncertainty, "Low");
  assert.deepEqual(e.invalid, []);
  assert.equal(e.untrusted, true);
  assert.deepEqual(e.provenance, {data: 1, assumption: 1, interpretation: 1});
  // unlabelled items default to the least trusted class
  const u = evaluateEvidence({technical: [{score: 80}]});
  assert.deepEqual(u.provenance, {data: 0, assumption: 0, interpretation: 1});
});

test("WS-B H1: empty evidence stays WAIT/High with a finite score", () => {
  const e = evaluateEvidence({});
  assert.equal(e.decision, "WAIT");
  assert.equal(e.uncertainty, "High");
  assert.equal(e.score, 0);
});

test("WS-B H1: researchOpportunity cannot surface RESEARCH on garbage evidence", () => {
  const x = researchOpportunity({evidence: {technical: [{score: NaN}], macro: [{score: 30}]}, regime: {score: 60}, sampleSize: 10});
  assert.equal(x.decision, "WAIT");
  assert.equal(x.uncertainty, "High");
});

test("WS-B H2: multi-agent council rejects null/blank scores and reports the holes", () => {
  // audit probe: runResearchCouncil({evidence:{technical:[{score:null},{score:null},{score:90}]}})
  // used to report technical.score = 30 with items: 3
  const r = runResearchCouncil({evidence: {technical: [{score: null}, {score: null}, {score: 90}]}});
  assert.equal(r.agents[0].score, 90);
  assert.equal(r.agents[0].items, 3);
  assert.equal(r.agents[0].invalid, 2);
  assert.equal(r.invalid, 2);
  assert.equal(r.decision, "WAIT");
  assert.equal(r.uncertainty, "High");
});

test("WS-B H2: any garbage item forces WAIT — never RESEARCH/RESEARCH_READY", () => {
  for (const bad of GARBAGE) {
    const r = runResearchCouncil({evidence: {technical: [{score: 85}], macro: [{score: 80}], derivatives: [{score: 90}], risk: [{score: bad}]}});
    assert.equal(r.decision, "WAIT", `garbage score ${String(bad)} must force WAIT`);
  }
});

test("WS-B H2: clean multi-agent evidence is unaffected", () => {
  const r = runResearchCouncil({evidence: {technical: [{score: 80, kind: "data"}], macro: [{score: 78}], derivatives: [{score: 82}], risk: [{score: 80}]}});
  assert.equal(r.invalid, 0);
  assert.equal(r.uncertainty, "low");
  assert.equal(r.decision, "RESEARCH_READY");
  assert.equal(r.untrusted, true);
  assert.deepEqual(r.agents[0].provenance, {data: 1, assumption: 0, interpretation: 0});
});
