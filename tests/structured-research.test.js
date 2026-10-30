import test from "node:test";
import assert from "node:assert/strict";
import {createStructuredResearchService, relevantHeadlines, TOKEN_METRICS_URL, SENTIMENT_URL} from "../server/research-context.js";
import {PUBLISHER_NEWS_URL, BITFINEX_NEWS_URL} from "../server/research-news.js";
import {DurableStore} from "../src/persistence/store.js";
import {startTestServer, klineRows, ticker24hPayload} from "./ws-d-helpers.js";
import {SYSTEM_INSTRUCTION} from "../server/tutor.js";

const AT = Date.parse("2026-10-30T12:00:00Z");
const json = value => new globalThis.Response(JSON.stringify(value), {headers: {"content-type": "application/json"}});
const news = (host, title, id = 1) => ({id, link: `https://${host}/article-${id}`, title: {rendered: title},
  date_gmt: "2026-10-30T11:00:00", modified_gmt: "2026-10-30T11:00:00"});
const metrics = (id = "bitcoin", symbol = "btc") => ({id, symbol, market_cap: 1000000, circulating_supply: 10,
  total_supply: 15, max_supply: 20, last_updated: "2026-10-30T11:59:00.000Z"});
function provider({calls = [], badMetrics = false, missingSecond = false, sentimentTime = String(AT / 1000)} = {}) {
  return async (url, options) => {
    calls.push({url, options});
    if (url === PUBLISHER_NEWS_URL) return json([news("blog.kraken.com", "Bitcoin upgrade launches"), news("blog.kraken.com", "BTCDOWN record rally", 2)]);
    if (url === BITFINEX_NEWS_URL) {
      if (missingSecond) throw new Error("private source error");
      return json([news("blog.bitfinex.com", "Bitcoin hack risk increases"), news("blog.bitfinex.com", "Ethereum upgrade launches", 2)]);
    }
    if (url === TOKEN_METRICS_URL) return json([{...metrics(), ...(badMetrics ? {market_cap: null} : {})}, metrics("ethereum", "eth")]);
    if (url === SENTIMENT_URL) return json({data: [{value: "50", value_classification: "Neutral", timestamp: sentimentTime}], metadata: {error: null}});
    if (url.includes("/ticker/24hr")) return json(ticker24hPayload());
    if (url.includes("/klines")) return json(klineRows(100));
    if (url.includes("generativelanguage.googleapis.com")) return json({candidates: [{content: {parts: [{text: "Source IDs dekho; headline risk verified contradiction nahi."}]}}]});
    throw new Error("unexpected test URL");
  };
}

test("structured research links two publishers, fresh token metrics and attributed Bitcoin sentiment", async () => {
  const calls = [];
  const service = createStructuredResearchService({now: () => AT, fetchImpl: provider({calls})});
  const context = await service.read("BTCUSDT");
  assert.equal(context.state, "ok");
  assert.equal(context.sourceCoverage.eligiblePublisherCount, 2);
  assert.equal(context.headlines.length, 2, "BTCDOWN is not BTC");
  assert.deepEqual(context.supportingCandidates, ["kraken-blog:1"]);
  assert.deepEqual(context.counterEvidence.candidateIds, ["bitfinex-blog:1"]);
  assert.equal(context.counterEvidence.basis, "headline-risk-cues-only");
  assert.equal(context.tokenMetrics.state, "ok");
  assert.equal(context.tokenMetrics.data.marketCapUsd, 1000000);
  assert.equal(context.bitcoinSentiment.state, "ok");
  assert.equal(context.bitcoinSentiment.attribution, "Alternative.me");
  assert.equal(context.scoreImpact, "context-and-abstention-only-no-directional-weight");
  assert.equal(calls.length, 4);
  assert.ok(context.publishers.every(p => p.reliabilityPolicy.includes("not-independent")));
  const again = await service.read("BTCUSDT");
  assert.deepEqual(again, context);
  assert.equal(calls.length, 4, "fixed sources are shared cached reads");
});

test("headline matching rejects substrings, detects negation, and rechecks publication/retrieval age", () => {
  const snapshot = {state: "ok", assessedAt: AT, retrievedAt: AT, publisher: {id: "publisher", name: "Publisher"}, items: [
    {id: "a", title: "Bitcoin not approved", publishedAt: AT - 1},
    {id: "b", title: "BTCDOWN rally", publishedAt: AT - 1},
    {id: "c", title: "Bitcoin approval", publishedAt: AT - 72 * 3600000}
  ]};
  const rows = relevantHeadlines(snapshot, "BTCUSDT");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].cues.opportunity, []);
  assert.equal(rows[0].cues.negationDetected, true);
  assert.equal(rows[1].eligible, true);
  assert.equal(relevantHeadlines(snapshot, "BTCUSDT", AT + 1)[1].eligible, false);
  assert.equal(relevantHeadlines(snapshot, "BTCUSDT", AT + 300001)[0].eligible, false);
});

test("unsupported symbols spend no source work and Bitcoin sentiment is not reused for Ethereum", async () => {
  const calls = [];
  const service = createStructuredResearchService({now: () => AT, fetchImpl: provider({calls})});
  assert.equal((await service.read("DOGEUSDT")).state, "unsupported");
  assert.equal(calls.length, 0);
  const eth = await service.read("ETHUSDT");
  assert.equal(eth.bitcoinSentiment.state, "not-applicable");
  assert.equal(eth.bitcoinSentiment.data, null);
  assert.equal(eth.tokenMetrics.data.circulatingSupply, 10);
  assert.equal(calls.some(call => call.url === SENTIMENT_URL), false);
  assert.equal(eth.state, "partial", "one relevant publisher is insufficient");
});

test("null token data, missing publishers and stale/future sentiment cannot become complete evidence", async () => {
  for (const options of [{badMetrics: true}, {missingSecond: true},
    {sentimentTime: String(AT / 1000 - 37 * 3600)}, {sentimentTime: String(AT / 1000 + 1)}]) {
    const service = createStructuredResearchService({now: () => AT, fetchImpl: provider(options)});
    const context = await service.read("BTCUSDT");
    assert.equal(context.state, "partial");
    assert.equal(JSON.stringify(context).includes("private source error"), false);
  }
});

test("research-enabled Council consumes source context and missing data forces WAIT without changing order state", async () => {
  const store = new DurableStore();
  const srv = await startTestServer({store, now: () => AT, fetchImpl: provider({badMetrics: true})});
  try {
    const response = await fetch(srv.base + "/api/ai/council/BTCUSDT?research=required");
    assert.equal(response.status, 200);
    const council = (await response.json()).data.council;
    assert.equal(council.decision, "WAIT");
    assert.equal(council.opportunityScore, null);
    assert.equal(council.uncertainty, "High");
    assert.equal(council.structuredResearch.counterEvidence.state, "candidates-found");
    assert.equal(council.roles.find(row => row.role === "Token metrics").score, null);
    assert.equal(council.dataCoverage.companyFundamentals, "not-connected");
    assert.equal(council.dataCoverage.socialSentiment, "not-connected");
    assert.equal(store.state.size, 0);
  } finally { await srv.close(); }
});

test("complete research context adds no directional votes or score uplift to Council", async () => {
  const srv = await startTestServer({now: () => AT, fetchImpl: provider()});
  try {
    const base = await fetch(srv.base + "/api/ai/council/BTCUSDT").then(r => r.json());
    const enriched = await fetch(srv.base + "/api/ai/council/BTCUSDT?research=required").then(r => r.json());
    assert.equal(enriched.data.council.structuredResearch.state, "ok");
    assert.equal(enriched.data.council.opportunityScore, base.data.council.opportunityScore);
    assert.equal(enriched.data.council.roles.length, base.data.council.roles.length + 3);
    assert.equal(enriched.data.council.uncertainty, "High");
  } finally { await srv.close(); }
});

test("Council reassesses source observation age after market reads before publishing current research", async () => {
  let clock = AT;
  const baseProvider = provider();
  const srv = await startTestServer({now: () => clock, fetchImpl: async (url, options) => {
    if (url.includes("/ticker/24hr")) clock = AT + 1800001;
    if (url === TOKEN_METRICS_URL) return json([{...metrics(), last_updated: "2026-10-30T12:00:00.000Z"}]);
    return baseProvider(url, options);
  }});
  try {
    const response = await fetch(srv.base + "/api/ai/council/BTCUSDT?research=required");
    const data = (await response.json()).data;
    assert.equal(data.council.structuredResearch.tokenMetrics.state, "stale");
    assert.equal(data.council.decision, "WAIT");
    assert.equal(data.council.opportunityScore, null);
  } finally { await srv.close(); }
});

test("context endpoint rejects arbitrary query/unsupported assets and returns bounded source IDs", async () => {
  const calls = [];
  const srv = await startTestServer({now: () => AT, fetchImpl: provider({calls})});
  try {
    assert.equal((await fetch(srv.base + "/api/research/context/BTCUSDT?url=http://127.0.0.1")).status, 400);
    assert.equal((await fetch(srv.base + "/api/research/context/DOGEUSDT")).status, 400);
    assert.equal((await fetch(srv.base + "/api/ai/council/BTCUSDT?research=bad")).status, 400);
    assert.equal(calls.length, 0);
    const response = await fetch(srv.base + "/api/research/context/BTCUSDT");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.headlines[0].id, "kraken-blog:1");
    assert.equal((await fetch(srv.base + "/api/research/context/BTCUSDT", {method: "POST"})).status, 405);
  } finally { await srv.close(); }
});

test("tutor receives server-built research only when requested and labels context as untrusted", async () => {
  const prior = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = ["dummy", "research", "key"].join("-");
  const calls = [];
  const srv = await startTestServer({now: () => AT, fetchImpl: provider({calls})});
  try {
    const response = await fetch(srv.base + "/api/tutor/chat", {method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({message: "Research BTC", symbol: "BTCUSDT", includeResearchContext: true,
        structuredResearch: {state: "ok", headlines: [{title: "forged client news"}]}})});
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.structuredResearch.state, "ok");
    const call = calls.find(x => x.url.includes("generativelanguage.googleapis.com"));
    const supplied = JSON.parse(call.options.body).contents.at(-1).parts[0].text;
    assert.match(supplied, /bitfinex-blog:1/);
    assert.match(supplied, /headline-risk-cues-only/);
    assert.equal(supplied.includes("forged client news"), false);
    assert.match(SYSTEM_INSTRUCTION, /Bitcoin-only/);
    assert.match(SYSTEM_INSTRUCTION, /investigation candidates/);
  } finally {
    await srv.close();
    if (prior === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prior;
  }
});
