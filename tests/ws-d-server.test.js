// tests/ws-d-server.test.js — WS-D web foundation: localhost API shell safety.
//
// Covers the mandatory acceptance criteria:
//   * /api/health returns ok (HTTP 200 + {ok:true} envelope)
//   * unknown / malformed symbols return 400 — no crash, no leak
//   * no response ever contains secrets
//   * the order-submission endpoint is an explicit stub (501), not a live path
//   * static serving is whitelist-only (no path traversal)

import test from "node:test";
import assert from "node:assert/strict";
import {startTestServer, getJson, findSecretViolations} from "./ws-d-helpers.js";

test("GET /api/health returns ok with honest, secret-free payload", async () => {
  const srv = await startTestServer({stateFile: "/nonexistent/paper-state.json"});
  try {
    const res = await getJson(srv.base, "/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.data, "object");
    assert.ok(["ok", "degraded"].includes(res.body.data.status), `honest status, got ${res.body.data.status}`);
    assert.equal(res.body.data.paperOnly, true);
    assert.equal(res.body.data.readOnly, false);
    assert.equal(res.body.data.orderSubmission, "paper-gated");
    assert.equal(res.body.data.tradingMode, "paper");
    assert.deepEqual(findSecretViolations(res.body, res.text), []);

    // Security headers on every response.
    assert.match(res.headers.get("content-security-policy") || "", /default-src 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  } finally {
    await srv.close();
  }
});

test("malformed and unknown symbols return 400 without crashing the server", async () => {
  const srv = await startTestServer({stateFile: "/nonexistent/paper-state.json"});
  const bad = [
    "/api/market/bad%20symbol",
    "/api/market/..%2Fetc%2Fpasswd",
    "/api/market/%00",
    "/api/market/" + "A".repeat(300),
    "/api/market/%24%27%22",
    "/api/indicators/BTC%24USDT",
    "/api/indicators/%E2%9C%93"
  ];
  try {
    for (const path of bad) {
      const res = await getJson(srv.base, path);
      assert.equal(res.status, 400, `${path} must 400, got ${res.status}`);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.state, "error");
      assert.equal(res.body.error.code, "invalid-symbol");
      // 400s leak nothing beyond the validation message.
      assert.deepEqual(findSecretViolations(res.body, res.text), []);
      assert.ok(!res.text.includes("/home/"), "no filesystem paths in error payloads");
      assert.ok(!/\bat \S+\.js:\d+/.test(res.text), "no stack traces in error payloads");
    }
    // The server is still alive and healthy afterwards.
    const health = await getJson(srv.base, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
  } finally {
    await srv.close();
  }
});

test("query whitelists reject malformed interval/limit/strategy with 400", async () => {
  const srv = await startTestServer({stateFile: "/nonexistent/paper-state.json"});
  try {
    const cases = [
      "/api/indicators/BTCUSDT?interval=13m",
      "/api/indicators/BTCUSDT?interval=1h;DROP",
      "/api/indicators/BTCUSDT?limit=abc",
      "/api/indicators/BTCUSDT?limit=99999",
      "/api/indicators/BTCUSDT?limit=-1",
      "/api/backtest?symbol=BTCUSDT&strategy=dice",
      "/api/backtest?symbol=;--"
    ];
    for (const path of cases) {
      const res = await getJson(srv.base, path);
      assert.equal(res.status, 400, `${path} must 400, got ${res.status}`);
      assert.equal(res.body.ok, false);
      assert.deepEqual(findSecretViolations(res.body, res.text), []);
    }
  } finally {
    await srv.close();
  }
});

test("unknown API routes 404 as JSON; wrong methods 405 with Allow", async () => {
  const srv = await startTestServer({stateFile: "/nonexistent/paper-state.json"});
  try {
    const notFound = await getJson(srv.base, "/api/does-not-exist");
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.ok, false);
    assert.equal(notFound.body.error.code, "not-found");

    const res = await fetch(srv.base + "/api/health", {method: "POST", body: "{}"});
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
    await res.json();
  } finally {
    await srv.close();
  }
});

test("POST /api/paper/orders rejects incomplete requests and never exposes a live path", async () => {
  const srv = await startTestServer({stateFile: "/nonexistent/paper-state.json"});
  try {
    const res = await fetch(srv.base + "/api/paper/orders", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({symbol: "BTCUSDT", side: "BUY", quantity: 1})
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.state, "error");
    assert.equal(body.error.code, "invalid-price");
    assert.deepEqual(findSecretViolations(body, JSON.stringify(body)), []);

    // GET on the order endpoint is refused; it is not a generic execution route.
    const getRes = await fetch(srv.base + "/api/paper/orders");
    assert.equal(getRes.status, 405);
    await getRes.json();
  } finally {
    await srv.close();
  }
});

test("static dashboard is served; path traversal is refused", async () => {
  const srv = await startTestServer({stateFile: "/nonexistent/paper-state.json"});
  try {
    const index = await fetch(srv.base + "/");
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") || "", /text\/html/);
    const html = await index.text();
    assert.match(html, /Trading Nova/);
    assert.match(html, /PAPER \/ SHADOW ONLY/);

    const app = await fetch(srv.base + "/app.js");
    assert.equal(app.status, 200);
    await app.text();

    const alias = await fetch(srv.base + "/ui/dashboard.html");
    assert.equal(alias.status, 200);
    assert.match(await alias.text(), /Trading Nova/);

    // Traversal attempts: normalised away by the client AND encoded attempts
    // must never expose repository files (package.json is the canary).
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/%2e%2e%2fpackage.json", "/web/../package.json", "/static/../../package.json"]) {
      const res = await fetch(srv.base + path);
      const text = await res.text();
      assert.ok(!text.includes('"dependencies"'), `${path} must not expose package.json`);
      assert.ok(!text.includes('"name": "trading-nova"'), `${path} must not expose package.json`);
    }

    const missing = await fetch(srv.base + "/nope.js");
    assert.equal(missing.status, 404);
  } finally {
    await srv.close();
  }
});

test("no secrets and no environment values in any response (sentinel check)", async () => {
  process.env.WS_D_SENTINEL_KEY = "SENTINEL-c8f2d1-not-a-real-secret";
  const srv = await startTestServer({stateFile: "/nonexistent/paper-state.json"});
  try {
    const paths = [
      "/api/health",
      "/api/portfolio",
      "/api/journal",
      "/api/market/bad%20symbol",
      "/api/does-not-exist"
    ];
    for (const path of paths) {
      const res = await getJson(srv.base, path);
      assert.deepEqual(findSecretViolations(res.body, res.text), [], `${path} leaked a secret`);
      assert.ok(!res.text.includes("SENTINEL-c8f2d1-not-a-real-secret"), `${path} leaked env values`);
      assert.ok(!res.text.includes("WS_D_SENTINEL_KEY"), `${path} leaked env names`);
    }
  } finally {
    delete process.env.WS_D_SENTINEL_KEY;
    await srv.close();
  }
});
