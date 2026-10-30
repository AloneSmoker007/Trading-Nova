import test from "node:test";
import assert from "node:assert/strict";
import {createPublisherNewsService, normalizePublisherPosts, PUBLISHER_NEWS_URL, NEWS_PUBLICATION_WINDOW_MS} from "../server/research-news.js";
import {startTestServer} from "./ws-d-helpers.js";

const AT = Date.parse("2026-10-30T12:00:00Z");
const post = (overrides = {}) => ({id: 1, title: {rendered: "Publisher headline"},
  link: "https://blog.kraken.com/test-post", date_gmt: "2026-10-30T11:00:00", modified_gmt: "2026-10-30T11:30:00", ...overrides});
const json = (value, options = {}) => new globalThis.Response(JSON.stringify(value), {headers: {"content-type": "application/json"}, ...options});

test("publisher UTC dates are strictly parsed; invalid dates stay unknown and links stay on the fixed publisher", () => {
  const payload = [post(), post({id: 2, link: "https://blog.kraken.com/unknown", date_gmt: "2026-02-30T11:00:00"}),
    post({id: 3, link: "https://blog.kraken.com/offset", date_gmt: "2026-10-30T11:00:00+05:00"}),
    post({id: 4, link: "http://127.0.0.1/private"}), post({id: 5, link: "https://blog.kraken.com.evil.test/private"}),
    post({id: 6, link: ["https://", "dummy-user", ":", "dummy-password", "@blog.kraken.com/private"].join("")}),
    post({id: 7, link: "javascript:alert(1)"}), post()];
  const normalized = normalizePublisherPosts(payload);
  assert.equal(normalized.items.length, 3);
  assert.equal(normalized.rejectedCount, 5);
  assert.equal(normalized.items[0].publishedAt, AT - 3600000);
  assert.equal(normalized.items[0].modifiedAt, AT - 1800000);
  assert.equal(normalized.items[1].publishedAt, null);
  assert.equal(normalized.items[2].publishedAt, null);
  assert.throws(() => normalizePublisherPosts({items: []}), /invalid publisher/);
  assert.throws(() => normalizePublisherPosts(Array.from({length: 11}, () => post())), /invalid publisher/);
});

test("publication freshness ages even on cache hits and never uses modified/retrieval time as publication time", async () => {
  let clock = AT;
  let calls = 0;
  const service = createPublisherNewsService({now: () => clock, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, PUBLISHER_NEWS_URL);
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.deepEqual(options.headers, {accept: "application/json"});
    return json([
      post({date_gmt: "2026-10-27T12:00:00", modified_gmt: "2026-10-30T12:00:00"}),
      post({id: 2, link: "https://blog.kraken.com/unknown", date_gmt: null}),
      post({id: 3, link: "https://blog.kraken.com/future", date_gmt: "2026-11-01T12:00:00"})
    ]);
  }});
  const first = await service.read();
  assert.equal(first.state, "ok");
  assert.equal(first.items[0].publicationAgeMs, NEWS_PUBLICATION_WINDOW_MS);
  assert.equal(first.items[0].publicationFreshness, "within-window");
  assert.equal(first.items[1].publicationFreshness, "unknown");
  assert.equal(first.items[2].publicationFreshness, "future-date");
  assert.equal(first.items[2].publicationAgeMs, null);
  clock++;
  const aged = await service.read();
  assert.equal(calls, 1);
  assert.equal(aged.items[0].publicationFreshness, "older-than-window");
  assert.equal(aged.retrievalAgeMs, 1);
  assert.equal(aged.retrievedAt, AT);
  assert.equal(aged.publisher.independence, "not-independent");
  assert.equal(aged.scoreImpact, "none");
  assert.equal(aged.counterEvidence, "not-collected");
});

test("publisher reads coalesce and failed refreshes serve only explicitly stale bounded cache", async () => {
  let clock = AT;
  let calls = 0;
  let release;
  const waiting = new Promise(resolve => {release = resolve;});
  const service = createPublisherNewsService({now: () => clock, fetchImpl: async () => {
    calls++;
    if (calls > 1) throw new Error("private upstream error must stay internal");
    await waiting;
    return json([post()]);
  }});
  const a = service.read(), b = service.read();
  release();
  assert.deepEqual(await a, await b);
  assert.equal(calls, 1);
  clock += 300001;
  const stale = await service.read();
  assert.equal(stale.state, "stale");
  assert.equal(stale.retrievedAt, AT);
  assert.equal(stale.retrievalAgeMs, 300001);
  assert.equal(calls, 2);
  assert.equal((await service.read()).state, "stale");
  assert.equal(calls, 2, "failure cooldown prevents retry storms");
  clock = AT + 1800001;
  const expired = await service.read();
  assert.equal(expired.state, "unavailable");
  assert.deepEqual(expired.items, []);
  assert.equal(expired.retrievedAt, null);
  assert.equal(JSON.stringify(expired).includes("private upstream"), false);
});

test("publisher transport rejects redirects, HTML, oversized bodies, bad payloads and rate limits", async t => {
  const cases = [
    ["redirect", () => new globalThis.Response("", {status: 302, headers: {location: "http://127.0.0.1/private"}})],
    ["html", () => new globalThis.Response("<html>error</html>", {headers: {"content-type": "text/html"}})],
    ["declared too large", () => new globalThis.Response("[]", {headers: {"content-type": "application/json", "content-length": "65537"}})],
    ["actual too large", () => new globalThis.Response("x".repeat(65537), {headers: {"content-type": "application/json"}})],
    ["bad JSON", () => new globalThis.Response("broken", {headers: {"content-type": "application/json"}})],
    ["all invalid links", () => json([post({link: "https://evil.test"})])],
    ["rate limited", () => json({error: "private"}, {status: 429})]
  ];
  for (const [name, response] of cases) await t.test(name, async () => {
    let calls = 0;
    const service = createPublisherNewsService({now: () => AT, fetchImpl: async () => {calls++; return response();}});
    assert.equal((await service.read()).state, "unavailable");
    assert.equal((await service.read()).state, "unavailable");
    assert.equal(calls, 1);
  });
});

test("hard deadline bounds a publisher transport that ignores AbortSignal", async () => {
  const service = createPublisherNewsService({timeoutMs: 20, fetchImpl: async () => new Promise(() => {})});
  assert.equal((await service.read()).state, "unavailable");
});

test("hard deadline bounds stalled body reads and cancels the stream", async () => {
  let canceled = false;
  const service = createPublisherNewsService({timeoutMs: 20, fetchImpl: async () => new globalThis.Response(
    new globalThis.ReadableStream({cancel() {canceled = true;}}), {headers: {"content-type": "application/json"}})});
  assert.equal((await service.read()).state, "unavailable");
  assert.equal(canceled, true);
});

test("an empty publisher feed is explicit and a failed HTTP feed response leaks no upstream details", async () => {
  const empty = createPublisherNewsService({now: () => AT, fetchImpl: async () => json([])});
  assert.equal((await empty.read()).state, "empty");
  const srv = await startTestServer({fetchImpl: async () => {throw new Error("private upstream sentinel");}});
  try {
    const response = await fetch(srv.base + "/api/research/news");
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, "publisher-research-unavailable");
    assert.equal(JSON.stringify(body).includes("private upstream sentinel"), false);
  } finally { await srv.close(); }
});

test("private access denies publisher research before any provider request", async () => {
  const priorPassword = process.env.NOVA_ACCESS_PASSWORD;
  const priorSecret = process.env.NOVA_SESSION_SECRET;
  process.env.NOVA_ACCESS_PASSWORD = ["fixture", "private", "password"].join("-");
  process.env.NOVA_SESSION_SECRET = "dummy-session-signing".repeat(2);
  let calls = 0;
  let srv;
  try {
    srv = await startTestServer({fetchImpl: async () => {calls++; return json([post()]);}});
    const response = await fetch(srv.base + "/api/research/news");
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  } finally {
    if (srv) await srv.close();
    if (priorPassword === undefined) delete process.env.NOVA_ACCESS_PASSWORD;
    else process.env.NOVA_ACCESS_PASSWORD = priorPassword;
    if (priorSecret === undefined) delete process.env.NOVA_SESSION_SECRET;
    else process.env.NOVA_SESSION_SECRET = priorSecret;
  }
});

test("HTTP research endpoint uses fixed publisher only and blocks arbitrary queries before requests", async () => {
  const calls = [];
  const srv = await startTestServer({now: () => AT, fetchImpl: async (url, options) => {
    calls.push({url, options});
    return json([post()]);
  }});
  try {
    const bad = await fetch(srv.base + "/api/research/news?url=http://127.0.0.1/private");
    assert.equal(bad.status, 400);
    assert.equal(calls.length, 0);
    const response = await fetch(srv.base + "/api/research/news");
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.items[0].publishedAt, AT - 3600000);
    assert.equal(data.items[0].dateAttribution, "publisher-reported");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, PUBLISHER_NEWS_URL);
    assert.equal((await fetch(srv.base + "/api/research/news", {method: "HEAD"})).status, 200);
    assert.equal((await fetch(srv.base + "/api/research/news", {method: "POST"})).status, 405);
    assert.equal(calls.length, 1);
  } finally { await srv.close(); }
});
