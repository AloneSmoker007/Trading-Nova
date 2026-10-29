import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, writeFile, rm} from "node:fs/promises";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createWatchlistService, DEFAULT_WATCHLIST} from "../server/watchlist.js";
import {createApi} from "../server/api.js";
import {createNovaServer} from "../server/app.js";

async function temporary(work) {
  const dir = await mkdtemp(join(tmpdir(), "nova-watchlist-"));
  try { await work(dir); } finally { await rm(dir, {recursive: true, force: true}); }
}

test("watchlist defaults are read-only until an explicit edit; order and empty state survive recreation", async () => temporary(async dir => {
  const file = join(dir, "watchlist.json");
  const service = createWatchlistService({file, now: () => 123});
  const initial = await service.read();
  assert.deepEqual(initial.symbols, DEFAULT_WATCHLIST);
  assert.equal(initial.revision, 0);
  assert.equal(existsSync(file), false);
  const saved = await service.save({symbols: [" ethusdt ", "btcusdt"], revision: 0});
  assert.deepEqual(saved.symbols, ["ETHUSDT", "BTCUSDT"]);
  assert.equal(saved.revision, 1);
  assert.equal(saved.updatedAt, 123);
  const restarted = createWatchlistService({file});
  assert.deepEqual(await restarted.read(), saved);
  await restarted.save({symbols: [], revision: 1});
  const empty = await createWatchlistService({file}).read();
  assert.deepEqual(empty.symbols, []);
  assert.equal(empty.revision, 2);
  assert.equal(empty.isDefault, false);
}));

test("watchlist validation rejects duplicates, unsafe/unbounded symbols and invalid revisions before writes", async () => temporary(async dir => {
  const file = join(dir, "watchlist.json");
  const service = createWatchlistService({file});
  for (const input of [null, [], {}, {symbols: [], revision: "0"}, {symbols: [], revision: -1},
    {symbols: ["BTCUSDT", "btcusdt"], revision: 0}, {symbols: ["../secret"], revision: 0},
    {symbols: ["<script>"], revision: 0}, {symbols: ["A".repeat(25)], revision: 0},
    {symbols: ["ETHBTC"], revision: 0},
    {symbols: Array.from({length: 21}, (_, i) => "SYM" + i + "USDT"), revision: 0}]) {
    await assert.rejects(service.save(input), {code: "invalid-watchlist"});
  }
  assert.equal(existsSync(file), false);
  const boundary = await service.save({symbols: Array.from({length: 20}, (_, i) => "SYM" + i + "USDT"), revision: 0});
  assert.equal(boundary.symbols.length, 20);
}));

test("concurrent local edits across service instances reject a stale revision instead of losing an update", async () => temporary(async dir => {
  const file = join(dir, "watchlist.json");
  const a = createWatchlistService({file});
  const b = createWatchlistService({file});
  const outcomes = await Promise.allSettled([
    a.save({symbols: ["BTCUSDT"], revision: 0}), b.save({symbols: ["ETHUSDT"], revision: 0})
  ]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(result => result.status === "rejected").reason.code, "watchlist-conflict");
  assert.equal((await a.read()).revision, 1);
  await b.save({symbols: ["SOLUSDT"], revision: 1});
  assert.equal((await a.read()).revision, 2);
}));

test("corrupt saved watchlists are unavailable and edits cannot silently reset them", async () => temporary(async dir => {
  const file = join(dir, "watchlist.json");
  const service = createWatchlistService({file});
  for (const text of ["{broken", "null", "[]", JSON.stringify({version: 1, revision: 1, updatedAt: 123, symbols: ["../bad"]})]) {
    await writeFile(file, text);
    await assert.rejects(service.read(), {code: "watchlist-unavailable"});
    await assert.rejects(service.save({symbols: [], revision: 0}), {code: "watchlist-unavailable"});
    assert.equal(await readFile(file, "utf8"), text);
  }
}));

test("configured database failure never falls back to a local default or file write", async () => temporary(async dir => {
  const file = join(dir, "watchlist.json");
  const store = {get: async () => {throw new Error("database unavailable");}, withTransaction: work => work({query: async () => ({})})};
  const service = createWatchlistService({file, store});
  await assert.rejects(service.read());
  await assert.rejects(service.save({symbols: [], revision: 0}));
  assert.equal(existsSync(file), false);
}));

test("market overview preserves saved order, unavailable symbols and stale quote labels", async () => temporary(async dir => {
  let calls = 0;
  const api = createApi({stateFile: join(dir, "state.json"), market: {getTicker: async symbol => {
    calls++;
    if (symbol === "MISSINGUSDT") return {state: "unavailable"};
    return {state: symbol === "ETHUSDT" ? "stale" : "ok", stale: symbol === "ETHUSDT", ageMs: symbol === "ETHUSDT" ? 60000 : 0,
      data: {last: 100, changePct24h: 1, volume24h: 5, quoteVolume24h: 500}};
  }}});
  const saved = await api.saveWatchlist({symbols: ["ETHUSDT", "BTCUSDT", "MISSINGUSDT"], revision: 0});
  assert.equal(saved.status, 200);
  const overview = await api.markets();
  assert.deepEqual(overview.body.data.markets.map(row => row.symbol), ["ETHUSDT", "BTCUSDT", "MISSINGUSDT"]);
  assert.equal(overview.body.data.state, "stale");
  assert.equal(overview.body.data.markets[0].state, "stale");
  assert.equal(overview.body.data.markets[1].quoteVolume24h, 500);
  assert.equal(overview.body.data.markets[2].last, null);
  assert.equal(overview.body.data.markets[2].state, "unavailable");
  const conflict = await api.saveWatchlist({symbols: [], revision: 0});
  assert.equal(conflict.status, 409);
  assert.equal((await api.saveWatchlist({symbols: [], revision: 1})).status, 200);
  const before = calls;
  assert.equal((await api.markets()).body.data.state, "empty");
  assert.equal(calls, before, "empty watchlist must not fetch any market quotes");
}));

test("overview accounts for quote age while a slower symbol finishes", async () => temporary(async dir => {
  const clock = {t: 1700000000000};
  const api = createApi({stateFile: join(dir, "state.json"), now: () => clock.t,
    market: {getTicker: async symbol => {
      if (symbol === "ETHUSDT") {await new Promise(resolve => setTimeout(resolve, 0)); clock.t += 20000;}
      return {state: "ok", stale: false, ageMs: 0, data: {last: 100}};
    }}});
  await api.saveWatchlist({symbols: ["BTCUSDT", "ETHUSDT"], revision: 0});
  const rows = (await api.markets()).body.data.markets;
  assert.equal(rows[0].ageMs, 20000);
  assert.equal(rows[0].state, "stale");
  assert.equal(rows[1].ageMs, 0);
  assert.equal(rows[1].state, "ok");
}));

test("HTTP watchlist validates writes and survives a server restart without touching execution or provider APIs", async () => temporary(async dir => {
  let providerCalls = 0;
  const stateFile = join(dir, "state.json");
  const executionStateFile = join(dir, "orders.json");
  async function serverFor(work) {
    const server = createNovaServer({stateFile, executionStateFile, now: () => 1700000000000,
      fetchImpl: async () => {providerCalls++; throw new Error("unexpected provider call");}});
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { await work("http://127.0.0.1:" + server.address().port); }
    finally {server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));}
  }
  await serverFor(async base => {
    const initial = await fetch(base + "/api/watchlist").then(r => r.json());
    assert.equal(initial.data.revision, 0);
    const invalid = await fetch(base + "/api/watchlist", {method: "PUT", body: JSON.stringify({symbols: ["../bad"], revision: 0})});
    assert.equal(invalid.status, 400);
    const saved = await fetch(base + "/api/watchlist", {method: "PUT", headers: {"content-type": "application/json"},
      body: JSON.stringify({symbols: ["SOLUSDT", "BTCUSDT"], revision: 0})});
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).data.revision, 1);
    const head = await fetch(base + "/api/watchlist", {method: "HEAD"});
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await fetch(base + "/api/watchlist", {method: "POST"})).status, 405);
    assert.equal((await fetch(base + "/api/watchlist", {method: "PUT", body: "x".repeat(17000)})).status, 413);
    let limited;
    for (let i = 0; i < 28; i++) limited = await fetch(base + "/api/watchlist", {method: "PUT", body: "{}"});
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "2");
    assert.equal((await fetch(base + "/api/watchlist")).status, 200, "edit limiting must not block reads");
  });
  await serverFor(async base => {
    const recovered = await fetch(base + "/api/watchlist").then(r => r.json());
    assert.deepEqual(recovered.data.symbols, ["SOLUSDT", "BTCUSDT"]);
    assert.equal(recovered.data.revision, 1);
  });
  assert.equal(providerCalls, 0);
  assert.equal(existsSync(stateFile), false);
  assert.equal(existsSync(executionStateFile), false);
}));
