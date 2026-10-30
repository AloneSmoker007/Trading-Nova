import test from "node:test";
import assert from "node:assert/strict";
import {createTradingTutor} from "../server/tutor.js";

const env = {[["GEMINI", "API_KEY"].join("_")]: ["fixture", "only"].join("-")};
const payload = {candidates: [{content: {parts: [{text: "Bounded answer"}]}}]};
const invoke = fetchImpl => createTradingTutor({env, fetchImpl})({message: "Explain risk"});

test("tutor rejects an oversized provider envelope even with a small visible answer", async () => {
  const response = await invoke(async () => new globalThis.Response(JSON.stringify({...payload, padding: "x".repeat(300000)})));
  assert.equal(response.status, 503);
  assert.equal(response.body.data, undefined);
  assert.equal(JSON.stringify(response).includes("Bounded answer"), false);
});

test("streaming tutor payload is bounded without trusting content-length and cancels on overflow", async () => {
  let cancelled = false;
  const response = await invoke(async () => new globalThis.Response(new globalThis.ReadableStream({
    start(controller) {controller.enqueue(new globalThis.TextEncoder().encode(JSON.stringify({...payload, padding: "x".repeat(300000)})));},
    cancel() {cancelled = true;}
  })));
  assert.equal(response.status, 503);
  assert.equal(cancelled, true);
});

test("bounded native and injected JSON transports retain valid answers", async () => {
  for (const fetchImpl of [async () => new globalThis.Response(JSON.stringify(payload)), async () => ({ok: true, json: async () => payload})]) {
    const response = await invoke(fetchImpl);
    assert.equal(response.status, 200);
    assert.equal(response.body.data.answer, "Bounded answer");
  }
});

test("provider byte boundary is exact and injected transports cannot bypass it", async () => {
  const overhead = JSON.stringify({...payload, padding: ""}).length;
  for (const extra of [0, 1]) {
    const value = {...payload, padding: "x".repeat(256 * 1024 - overhead + extra)};
    for (const fetchImpl of [async () => new globalThis.Response(JSON.stringify(value), {headers: {"content-length": "1"}}),
      async () => ({ok: true, json: async () => value})]) {
      assert.equal((await invoke(fetchImpl)).status, extra ? 503 : 200);
    }
  }
});

test("oversized declared lengths cancel without reading and invalid UTF8 fails closed", async () => {
  let cancelled = false;
  const result = await invoke(async () => new globalThis.Response(new globalThis.ReadableStream({cancel() {cancelled = true;}}),
    {headers: {"content-length": String(256 * 1024 + 1)}}));
  assert.equal(result.status, 503);
  assert.equal(cancelled, true);
  assert.equal((await invoke(async () => new globalThis.Response(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125])))).status, 503);
});

test("existing tutor deadline cancels a stalled native response body", async () => {
  let cancelled = false;
  const result = await createTradingTutor({env, timeoutMs: 5, fetchImpl: async () => new globalThis.Response(new globalThis.ReadableStream({
    cancel() {cancelled = true;}
  }))})({message: "Explain risk"});
  assert.equal(result.status, 503);
  assert.equal(cancelled, true);
});
