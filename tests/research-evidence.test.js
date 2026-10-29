import test from "node:test";
import assert from "node:assert/strict";
import {researchEvidence} from "../server/research-evidence.js";
import {createTradingTutor} from "../server/tutor.js";
const web = uri => ({web: {uri, title: "Source"}});
const support = (text, startIndex, endIndex, indices = [0], partIndex = 0) => ({segment: {text, startIndex, endIndex, partIndex}, groundingChunkIndices: indices});
const grounding = (supports, chunks = [web("https://example.com/research")]) => ({groundingChunks: chunks, groundingSupports: supports});

test("maps UTF8 Urdu/emoji bytes to exact trimmed multipart answer offsets", () => {
  const text = "قیمت 📈 up";
  const r = researchEvidence([{text: "  Intro. "}, {thought: true, text: "hidden"}, {text}], grounding([
    support(text, 0, Buffer.byteLength(text), [0], 2)
  ]), 123);
  assert.equal(r.answer, "Intro. " + text);
  assert.deepEqual(r.evidence.claims, [{text, start: 7, end: r.answer.length, sourceIds: ["S1"]}]);
  assert.equal(r.evidence.sourceDetails[0].retrievedAt, 123);
  assert.equal(r.evidence.sourceDetails[0].publishedAt, null);
  assert.equal(r.evidence.publicationFreshness, "unknown");
});

test("source filtering and dedup preserve original chunk indices without shifting attribution", () => {
  const r = researchEvidence([{text: "ABC"}], grounding([support("ABC", 0, 3, [0, 1, 2, 3, 9])],
    [web("javascript:bad"), web("https://example.com/a"), web("https://example.com/a"), web("https://example.com/b")]), 1);
  assert.equal(r.sources.length, 2);
  assert.deepEqual(r.evidence.claims[0].sourceIds, ["S1", "S2"]);
});

test("rejects malformed ranges, mismatched text, hidden parts and unsafe/absent references", () => {
  const bad = [support("é", 1, 2), support("wrong", 0, 2), support("é", -1, 2),
    support("é", 0, 99), support("é", 0, 2, [99]), support("é", 0, 2, [0], 99),
    support("é", 0.5, 2), support("é", 0, 2, ["0"]), support("secret", 0, 6, [0], 1)];
  const r = researchEvidence([{text: "é"}, {text: "secret", thought: true}], grounding(bad), 1);
  assert.equal(r.evidence.state, "sources-only");
  assert.deepEqual(r.evidence.claims, []);
  const unsafe = researchEvidence([{text: "é"}], grounding([support("é", 0, 2)], [web("data:text/html,bad")]), 1);
  assert.equal(unsafe.evidence.state, "unavailable");
});

test("overlapping/duplicate supports do not inflate coverage; source and claim counts are bounded", () => {
  const r = researchEvidence([{text: "abcdef"}], grounding([support("abcd", 0, 4), support("abcd", 0, 4), support("cdef", 2, 6)]), 1);
  assert.equal(r.evidence.claims.length, 2);
  assert.equal(r.evidence.coveredCharacters, 6);
  const chunks = Array.from({length: 20}, (_, i) => web(`https://example.com/${i}`));
  const many = researchEvidence([{text: "x".repeat(50)}], grounding(Array.from({length: 50}, (_, i) => support("x", i, i + 1, [0, 19])), chunks), 1);
  assert.equal(many.sources.length, 8);
  assert.equal(many.evidence.claims.length, 32);
  assert.deepEqual(many.evidence.claims[0].sourceIds, ["S1"]);
});

test("missing or wrong-shaped grounding remains explicit without invented claims", () => {
  for (const g of [undefined, {}, {groundingSupports: {}, groundingChunks: {}}]) {
    const r = researchEvidence([{text: "answer"}], g, 1);
    assert.equal(r.evidence.state, "unavailable");
    assert.deepEqual(r.evidence.claims, []);
  }
});

test("tutor API carries safe claim evidence, omits thought text and retains sources-only compatibility", async () => {
  const env = {[["GEMINI", "API_KEY"].join("_")]: ["fixture", "only"].join("-")};
  for (const mapped of [true, false]) {
    const tutor = createTradingTutor({env, now: () => 99, fetchImpl: async () => ({ok: true, json: async () => ({candidates: [{
      content: {parts: [{text: "Answer"}, {text: "private thought", thought: true}]},
      groundingMetadata: grounding(mapped ? [support("Answer", 0, 6)] : [])
    }]})})});
    const r = await tutor({message: "Research", researchMode: "required-sources"});
    assert.equal(r.status, 200);
    assert.equal(r.body.data.answer, "Answer");
    assert.equal(r.body.data.evidence.state, mapped ? "claim-attributed" : "sources-only");
    assert.equal(r.body.data.evidence.sourceDetails[0].retrievedAt, r.body.data.generatedAt);
  }
});
