import test from "node:test";
import assert from "node:assert/strict";
import {createTradingTutor, tutorConfigurationStatus, validateInput} from "../server/tutor.js";
import {createNovaServer} from "../server/app.js";

const keyName = ["GEMINI", "API_KEY"].join("_");
const credential = ["fixture", "research", "credential"].join("-");
const configuredEnv = (extra = {}) => ({[keyName]: credential, ...extra});
const response = (sources = []) => ({ok: true, json: async () => ({candidates: [{
  content: {parts: [{text: "Unverified fixture answer"}]},
  groundingMetadata: {groundingChunks: sources.map(uri => ({web: {uri, title: "Fixture source"}}))}
}]})});

test("setup projection distinguishes configuration from live connection and never exposes values", () => {
  assert.equal(tutorConfigurationStatus({}).configured, false);
  const configured = tutorConfigurationStatus(configuredEnv());
  assert.equal(configured.configured, true);
  assert.equal(configured.configuration, "configured");
  assert.equal(configured.connection, "not-checked");
  assert.equal(configured.webResearchEnabled, true);
  assert.equal(configured.mode, "paper-only");
  assert.equal(JSON.stringify(configured).includes(credential), false);
  for (const model of ["", null, 123, "bad/model", "a".repeat(81)]) {
    const status = tutorConfigurationStatus(configuredEnv({GEMINI_MODEL: model}));
    assert.equal(status.configured, false);
    assert.equal(status.configuration, "invalid-configuration");
    assert.equal(status.connection, "not-checked");
  }
});

test("sources-required input is explicit and unknown modes fail before provider calls", async () => {
  assert.equal(validateInput({message: "hello"}).researchMode, "auto");
  assert.equal(validateInput({message: "hello", researchMode: "required-sources"}).researchMode, "required-sources");
  assert.equal(validateInput({message: "hello", researchMode: "required-claims"}).researchMode, "required-claims");
  let calls = 0;
  const tutor = createTradingTutor({env: configuredEnv(), fetchImpl: async () => {calls++; return response();}});
  for (const researchMode of [null, true, {}, "anything"]) {
    const result = await tutor({message: "hello", researchMode});
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "invalid-research-mode");
  }
  assert.equal(calls, 0);
});

test("sources-required mode fails without any egress when web research is disabled", async () => {
  let calls = 0;
  for (const flag of ["false", "0"]) {
    const tutor = createTradingTutor({env: configuredEnv({GEMINI_WEB_RESEARCH: flag}),
      fetchImpl: async () => {calls++; return response();}});
    for (const researchMode of ["required-sources", "required-claims"]) {
      const result = await tutor({message: "Current research", researchMode});
      assert.equal(result.status, 503);
      assert.equal(result.body.error.code, "tutor-research-disabled");
    }
  }
  assert.equal(calls, 0);
});

test("sources-required mode withholds uncited answers and ignores unusable grounding URLs", async () => {
  const credentialedFixtureUrl = ["https://", "fixture-user", ":", "fixture-value", "@example.com/research"].join("");
  for (const sources of [[], ["javascript:alert(1)", "not-a-url", credentialedFixtureUrl]]) {
    const tutor = createTradingTutor({env: configuredEnv(), fetchImpl: async () => response(sources)});
    const result = await tutor({message: "Current research", researchMode: "required-sources"});
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, "tutor-sources-unavailable");
    assert.equal(result.body.data, undefined);
    assert.equal(JSON.stringify(result).includes("Unverified fixture answer"), false);
  }
});

test("sources-required success returns actual grounding links and keeps ordinary tutoring compatible", async () => {
  let sent;
  const tutor = createTradingTutor({env: configuredEnv(), fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return response(["https://example.com/research"]);
  }});
  const result = await tutor({message: "Current research", researchMode: "required-sources"});
  assert.equal(result.status, 200);
  assert.equal(result.body.data.researchMode, "required-sources");
  assert.equal(result.body.data.research, "grounded");
  assert.equal(result.body.data.sources[0].url, "https://example.com/research");
  assert.deepEqual(sent.tools, [{google_search: {}}]);
  assert.match(sent.contents.at(-1).parts[0].text, /CURRENT RESEARCH REQUEST/);
  const ordinary = await createTradingTutor({env: configuredEnv(), fetchImpl: async () => response()})({message: "Explain RSI"});
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.body.data.researchMode, "auto");
  assert.equal(ordinary.body.data.research, "enabled-no-sources");
});

async function withServer(operation, {web = "true", keyed = true, providerResponse = response} = {}) {
  const changes = {[keyName]: keyed ? credential : undefined, GEMINI_MODEL: undefined,
    GEMINI_WEB_RESEARCH: web, NODE_ENV: "development"};
  const previous = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  let calls = 0;
  const server = createNovaServer({fetchImpl: async () => {calls++; return providerResponse();},
    stateFile: "/nonexistent/tutor-status-state.json", executionStateFile: "/nonexistent/tutor-status-orders.json"});
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    await operation("http://127.0.0.1:" + server.address().port, () => calls);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("HTTP setup check supports GET/HEAD, rejects writes and performs no provider or market work", async () => {
  await withServer(async (base, calls) => {
    const get = await fetch(base + "/api/tutor/status");
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("cache-control"), "no-store");
    const body = await get.json();
    assert.equal(body.data.configured, true);
    assert.equal(body.data.connection, "not-checked");
    assert.equal(JSON.stringify(body).includes(credential), false);
    const head = await fetch(base + "/api/tutor/status", {method: "HEAD"});
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const post = await fetch(base + "/api/tutor/status", {method: "POST"});
    assert.equal(post.status, 405);
    assert.equal(calls(), 0);
  });
  await withServer(async (base, calls) => {
    const body = await fetch(base + "/api/tutor/status").then(r => r.json());
    assert.equal(body.data.configured, false);
    assert.equal(body.data.configuration, "missing-credentials");
    assert.equal(calls(), 0);
  }, {keyed: false});
});

test("HTTP sources-required disabled preflight rejects before optional market lookup", async () => {
  await withServer(async (base, calls) => {
    for (const researchMode of ["required-sources", "required-claims"]) {
      const result = await fetch(base + "/api/tutor/chat", {method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({message: "Current research", symbol: "BTCUSDT", includeResearchContext: true, researchMode})});
      assert.equal(result.status, 503);
      assert.equal((await result.json()).error.code, "tutor-research-disabled");
    }
    assert.equal(calls(), 0);
  }, {web: "false"});
});

test("HTTP required-claims withholds links-only answers while required-sources remains compatible", async () => {
  await withServer(async (base, calls) => {
    for (const researchMode of ["required-claims", "required-sources"]) {
      const result = await fetch(base + "/api/tutor/chat", {method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({message: "Research", researchMode})});
      const body = await result.json();
      if (researchMode === "required-claims") {
        assert.equal(result.status, 503);
        assert.equal(body.error.code, "tutor-claims-unavailable");
        assert.equal(body.data, undefined);
      } else {
        assert.equal(result.status, 200);
        assert.equal(body.data.evidence.state, "sources-only");
      }
    }
    assert.equal(calls(), 2);
  }, {providerResponse: () => response(["https://example.com/research"])});
});
