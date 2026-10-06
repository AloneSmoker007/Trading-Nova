import test from "node:test";
import assert from "node:assert/strict";
import {
  createHyperliquidClient,
  toFiniteNumber,
  requestJson,
  buildLeaderboardRequest,
  buildClearinghouseStateBody,
  buildInfoRequest,
  isValidAddress,
  normaliseHyperliquidLeaderboardEntry,
  normaliseHyperliquidPosition,
  normaliseHyperliquidClearinghouseState
} from "../src/market-data/providers/hyperliquid.js";

// ---------------------------------------------------------------------------
// Offline stub transport. Every test below runs with zero network access.
// ---------------------------------------------------------------------------

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({url: String(url), init});
    return handler(String(url), init);
  };
  return {fetchImpl, calls};
}

function okJson(payload) {
  return {ok: true, status: 200, json: async () => payload};
}

const ADDR_A = "0x" + "a".repeat(40);
const ADDR_B = "0x" + "b".repeat(40);
const ADDR_C = "0x" + "c".repeat(40);

// Real entry shape served by GET https://stats-data.hyperliquid.xyz/Mainnet/leaderboard
const LB_ROW_A = {
  ethAddress: ADDR_A,
  accountValue: "1000.5",
  windowPerformances: [
    ["day", {pnl: "100.5", roi: "0.1005", vlm: "10000"}],
    ["allTime", {pnl: "900.25", roi: "0.9", vlm: "500000"}]
  ],
  prize: 0,
  displayName: null
};
const LB_ROW_B = {
  ethAddress: ADDR_B,
  accountValue: "2000.75",
  windowPerformances: [
    ["day", {pnl: "300.25", roi: "0.15", vlm: "20000"}],
    ["allTime", {pnl: "-50.5", roi: "-0.02", vlm: "700000"}]
  ],
  prize: 1,
  displayName: "traderB"
};
const LB_ROW_C = {
  ethAddress: ADDR_C,
  accountValue: "3000",
  windowPerformances: [
    ["day", {pnl: "200", roi: "0.0666", vlm: "30000"}]
  ],
  prize: 0,
  displayName: null
};

// Real position shape served by POST https://api.hyperliquid.xyz/info {"type":"clearinghouseState",...}
const CHS_STATE = {
  marginSummary: {accountValue: "2500.5", totalNtlPos: "10000.0", totalRawUsd: "2500.5", totalMarginUsed: "1200.25"},
  crossMarginSummary: {accountValue: "2500.5", totalNtlPos: "10000.0", totalRawUsd: "2500.5", totalMarginUsed: "1200.25"},
  crossMaintenanceMarginUsed: "800.125",
  withdrawable: "1300.25",
  assetPositions: [
    {
      type: "oneWay",
      position: {
        coin: "BTC", szi: "0.25", leverage: {type: "cross", value: 5}, entryPx: "64000.0",
        positionValue: "16800.0", unrealizedPnl: "750.5", returnOnEquity: "0.0555",
        liquidationPx: "52000.0", marginUsed: "3360.0", maxLeverage: 40,
        cumFunding: {allTime: "12.5", sinceOpen: "3.5", sinceChange: "1.5"}
      }
    },
    {
      type: "oneWay",
      position: {
        coin: "ETH", szi: "-2.5", leverage: {type: "cross", value: 3}, entryPx: "3200.0",
        positionValue: "7900.0", unrealizedPnl: "-100.25", returnOnEquity: "-0.0125",
        liquidationPx: null, marginUsed: "2633.3333", maxLeverage: 25,
        cumFunding: {allTime: "-4.25", sinceOpen: "-1.25", sinceChange: "-0.5"}
      }
    }
  ],
  time: 1791246394974
};

// ---------------------------------------------------------------------------
// Pure helpers and URL/body builders
// ---------------------------------------------------------------------------

test("toFiniteNumber coerces decimal cells only, never NaN/Infinity", () => {
  assert.equal(toFiniteNumber(12.5), 12.5);
  assert.equal(toFiniteNumber(-0.25), -0.25);
  assert.equal(toFiniteNumber("12"), 12);
  assert.equal(toFiniteNumber(" 12.5 "), 12.5);
  assert.equal(toFiniteNumber("-0.002008518"), -0.002008518);
  assert.equal(toFiniteNumber("1e3"), 1000);
  assert.equal(toFiniteNumber(""), null);
  assert.equal(toFiniteNumber("abc"), null);
  assert.equal(toFiniteNumber("12abc"), null);
  assert.equal(toFiniteNumber("0x10"), null); // hex strings are not numbers here
  assert.equal(toFiniteNumber("NaN"), null);
  assert.equal(toFiniteNumber("Infinity"), null);
  assert.equal(toFiniteNumber(Infinity), null);
  assert.equal(toFiniteNumber(NaN), null);
  assert.equal(toFiniteNumber(null), null);
  assert.equal(toFiniteNumber(undefined), null);
  assert.equal(toFiniteNumber(true), null);
  assert.equal(toFiniteNumber([]), null);
  assert.equal(toFiniteNumber({}), null);
});

test("buildClearinghouseStateBody builds the documented read-only query", () => {
  assert.deepEqual(buildClearinghouseStateBody(ADDR_A), {type: "clearinghouseState", user: ADDR_A});
  assert.equal(isValidAddress(ADDR_A), true);
  assert.equal(isValidAddress("0x123"), false);
  assert.throws(() => buildClearinghouseStateBody("0x123"), TypeError);
  assert.throws(() => buildClearinghouseStateBody("0x" + "z".repeat(40)), TypeError);
  assert.throws(() => buildClearinghouseStateBody(null), TypeError);
});

test("buildInfoRequest and buildLeaderboardRequest are credential-free", () => {
  const info = buildInfoRequest(ADDR_A, {infoUrl: "https://hl.test/info"});
  assert.equal(info.url, "https://hl.test/info");
  assert.equal(info.init.method, "POST");
  assert.deepEqual(info.init.headers, {"Content-Type": "application/json"});
  assert.deepEqual(JSON.parse(info.init.body), {type: "clearinghouseState", user: ADDR_A});
  const serialized = JSON.stringify(info.init);
  assert.equal(/authorization|api[-_]?key|token|secret/i.test(serialized), false);
  const lb = buildLeaderboardRequest({leaderboardUrl: "https://lb.test/rows"});
  assert.deepEqual(lb, {url: "https://lb.test/rows", init: {method: "GET"}});
  assert.deepEqual(buildLeaderboardRequest().url, "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard");
});

test("requestJson is fail-closed for every transport failure", async () => {
  assert.deepEqual(await requestJson(async () => { throw new Error("boom"); }, "https://x.test", {}), {ok: false, reason: "network-error"});
  assert.deepEqual(await requestJson(async () => null, "https://x.test", {}), {ok: false, reason: "network-error"});
  assert.deepEqual(await requestJson(async () => ({ok: false, status: 429, json: async () => ({})}), "https://x.test", {}), {ok: false, reason: "rate-limited", status: 429});
  assert.deepEqual(await requestJson(async () => ({ok: false, status: 403, json: async () => ({})}), "https://x.test", {}), {ok: false, reason: "http-error", status: 403});
  assert.deepEqual(await requestJson(async () => ({ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); }}), "https://x.test", {}), {ok: false, reason: "invalid-json"});
});

// ---------------------------------------------------------------------------
// Pure normalisers
// ---------------------------------------------------------------------------

test("normaliseHyperliquidLeaderboardEntry maps a real row with hand-computed values", () => {
  const e = normaliseHyperliquidLeaderboardEntry(LB_ROW_B, {window: "day", rank: 7});
  assert.deepEqual(e, {address: ADDR_B, accountSize: 2000.75, pnl: 300.25, roi: 0.15, volume: 20000, rank: 7});
  const all = normaliseHyperliquidLeaderboardEntry(LB_ROW_B, {window: "allTime"});
  assert.deepEqual(all, {address: ADDR_B, accountSize: 2000.75, pnl: -50.5, roi: -0.02, volume: 700000, rank: null});
  assert.equal(all.pnl, -50.5); // sign preserved exactly as served
});

test("normaliseHyperliquidLeaderboardEntry keeps entries without stats but nulls their numbers", () => {
  const e = normaliseHyperliquidLeaderboardEntry(LB_ROW_C, {window: "week", rank: 3});
  assert.deepEqual(e, {address: ADDR_C, accountSize: 3000, pnl: null, roi: null, volume: null, rank: 3});
  const truncated = normaliseHyperliquidLeaderboardEntry({...LB_ROW_C, windowPerformances: [["day"]]}, {window: "day"});
  assert.equal(truncated.pnl, null);
  assert.equal(truncated.accountSize, 3000);
});

test("normaliseHyperliquidLeaderboardEntry is fail-closed on malformed entries", () => {
  assert.equal(normaliseHyperliquidLeaderboardEntry(null), null);
  assert.equal(normaliseHyperliquidLeaderboardEntry("leader"), null);
  assert.equal(normaliseHyperliquidLeaderboardEntry([LB_ROW_A]), null);
  assert.equal(normaliseHyperliquidLeaderboardEntry({accountValue: "1000"}), null); // no address
  assert.equal(normaliseHyperliquidLeaderboardEntry({ethAddress: "0x123", accountValue: "1000"}), null); // short address
  assert.equal(normaliseHyperliquidLeaderboardEntry({ethAddress: 42, accountValue: "1000"}), null);
  assert.equal(normaliseHyperliquidLeaderboardEntry({ethAddress: ADDR_A}), null); // no accountValue
  assert.equal(normaliseHyperliquidLeaderboardEntry({ethAddress: ADDR_A, accountValue: "abc"}), null); // non-numeric
  assert.equal(normaliseHyperliquidLeaderboardEntry({ethAddress: ADDR_A, accountValue: "Infinity"}), null);
  assert.equal(normaliseHyperliquidLeaderboardEntry({ethAddress: ADDR_A, accountValue: "-1"}), null); // negative size
});

test("normaliseHyperliquidLeaderboardEntry never invents a rank", () => {
  assert.equal(normaliseHyperliquidLeaderboardEntry(LB_ROW_A).rank, null);
  assert.equal(normaliseHyperliquidLeaderboardEntry(LB_ROW_A, {rank: 0}).rank, null);
  assert.equal(normaliseHyperliquidLeaderboardEntry(LB_ROW_A, {rank: "1"}).rank, null);
  assert.equal(normaliseHyperliquidLeaderboardEntry(LB_ROW_A, {rank: 2}).rank, 2);
});

test("normaliseHyperliquidPosition maps long and short positions with hand-computed values", () => {
  const [long, short] = CHS_STATE.assetPositions;
  assert.deepEqual(normaliseHyperliquidPosition(long), {
    coin: "BTC", side: "long", size: 0.25, entryPrice: 64000, positionValue: 16800,
    unrealizedPnl: 750.5, roe: 0.0555, leverage: 5, liquidationPrice: 52000, marginUsed: 3360
  });
  assert.deepEqual(normaliseHyperliquidPosition(short), {
    coin: "ETH", side: "short", size: -2.5, entryPrice: 3200, positionValue: 7900,
    unrealizedPnl: -100.25, roe: -0.0125, leverage: 3, liquidationPrice: null, marginUsed: 2633.3333
  });
});

test("normaliseHyperliquidPosition is fail-closed on malformed positions", () => {
  assert.equal(normaliseHyperliquidPosition(null), null);
  assert.equal(normaliseHyperliquidPosition({type: "oneWay"}), null); // no position object
  assert.equal(normaliseHyperliquidPosition({position: "BTC"}), null);
  assert.equal(normaliseHyperliquidPosition({position: {coin: "", szi: "1", entryPx: "10"}}), null);
  assert.equal(normaliseHyperliquidPosition({position: {coin: "BTC", entryPx: "10"}}), null); // no szi
  assert.equal(normaliseHyperliquidPosition({position: {coin: "BTC", szi: "abc", entryPx: "10"}}), null); // non-numeric size
  assert.equal(normaliseHyperliquidPosition({position: {coin: "BTC", szi: "0", entryPx: "10"}}), null); // flat is not a position
  assert.equal(normaliseHyperliquidPosition({position: {coin: "BTC", szi: "1", entryPx: "0"}}), null); // invalid entry price
  assert.equal(normaliseHyperliquidPosition({position: {coin: "BTC", szi: "1", entryPx: "oops"}}), null);
});

test("normaliseHyperliquidClearinghouseState maps the documented payload", () => {
  const s = normaliseHyperliquidClearinghouseState(CHS_STATE);
  assert.equal(s.accountValue, 2500.5);
  assert.equal(s.withdrawable, 1300.25);
  assert.equal(s.positions.length, 2);
  assert.equal(s.positions[0].coin, "BTC");
  assert.equal(s.positions[1].side, "short");
  const empty = normaliseHyperliquidClearinghouseState({...CHS_STATE, assetPositions: []});
  assert.deepEqual(empty.positions, []);
});

test("normaliseHyperliquidClearinghouseState fails closed on truncated or garbage state", () => {
  assert.equal(normaliseHyperliquidClearinghouseState(null), null);
  assert.equal(normaliseHyperliquidClearinghouseState("<html>error</html>"), null);
  assert.equal(normaliseHyperliquidClearinghouseState({marginSummary: {accountValue: "1"}}), null); // assetPositions missing
  assert.equal(normaliseHyperliquidClearinghouseState({assetPositions: {}}), null); // not an array
  // one unparseable position == unknown exposure == reject the whole state
  assert.equal(normaliseHyperliquidClearinghouseState({assetPositions: [CHS_STATE.assetPositions[0], {position: {coin: "BTC"}}]}), null);
  assert.equal(normaliseHyperliquidClearinghouseState({assetPositions: []}).accountValue, null); // no marginSummary -> null, not NaN
});

// ---------------------------------------------------------------------------
// Client I/O via stub transport only
// ---------------------------------------------------------------------------

test("getTopTraders ranks by descending PnL for the chosen window", async () => {
  const {fetchImpl, calls} = stubFetch(() => okJson({leaderboardRows: [LB_ROW_A, LB_ROW_B, LB_ROW_C]}));
  const client = createHyperliquidClient({fetchImpl, leaderboardUrl: "https://lb.test/rows"});
  const res = await client.getTopTraders({limit: 2, window: "day"});
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(res.data, [
    {address: ADDR_B, accountSize: 2000.75, pnl: 300.25, roi: 0.15, volume: 20000, rank: 1},
    {address: ADDR_C, accountSize: 3000, pnl: 200, roi: 0.0666, volume: 30000, rank: 2}
  ]);
});

test("getTopTraders sorts window-less entries last and keeps source order on ties", async () => {
  const {fetchImpl} = stubFetch(() => okJson({leaderboardRows: [LB_ROW_C, LB_ROW_A, LB_ROW_B]}));
  const client = createHyperliquidClient({fetchImpl});
  const res = await client.getTopTraders({limit: 10, window: "allTime"});
  assert.deepEqual(res.data.map((e) => e.rank), [1, 2, 3]);
  assert.deepEqual(res.data.map((e) => e.address), [ADDR_A, ADDR_B, ADDR_C]); // A 900.25, B -50.5, C no stats
  assert.equal(res.data[2].pnl, null);
  assert.equal(res.data[0].pnl, 900.25);
  assert.equal(res.data[1].pnl, -50.5);
});

test("getTopTraders rejects bad windows and limits without touching the network", async () => {
  const {fetchImpl, calls} = stubFetch(() => okJson({leaderboardRows: []}));
  const client = createHyperliquidClient({fetchImpl});
  assert.deepEqual(await client.getTopTraders({window: "decade"}), {ok: false, reason: "invalid-window"});
  assert.deepEqual(await client.getTopTraders({limit: 0}), {ok: false, reason: "invalid-limit"});
  assert.deepEqual(await client.getTopTraders({limit: 101}), {ok: false, reason: "invalid-limit"});
  assert.deepEqual(await client.getTopTraders({limit: 2.5}), {ok: false, reason: "invalid-limit"});
  assert.equal(calls.length, 0);
});

test("getTopTraders is fail-closed on malformed leaderboard payloads", async () => {
  const missing = stubFetch(() => okJson({rows: []}));
  assert.deepEqual(await createHyperliquidClient({fetchImpl: missing.fetchImpl}).getTopTraders(), {ok: false, reason: "invalid-payload"});
  const wrongType = stubFetch(() => okJson({leaderboardRows: "nope"}));
  assert.deepEqual(await createHyperliquidClient({fetchImpl: wrongType.fetchImpl}).getTopTraders(), {ok: false, reason: "invalid-payload"});
  const allBad = stubFetch(() => okJson({leaderboardRows: [{ethAddress: "0x123"}, null]}));
  assert.deepEqual(await createHyperliquidClient({fetchImpl: allBad.fetchImpl}).getTopTraders(), {ok: false, reason: "invalid-payload"});
  const html = stubFetch(() => ({ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); }}));
  assert.deepEqual(await createHyperliquidClient({fetchImpl: html.fetchImpl}).getTopTraders(), {ok: false, reason: "invalid-json"});
  const limited = stubFetch(() => ({ok: false, status: 429, json: async () => ({})}));
  assert.deepEqual(await createHyperliquidClient({fetchImpl: limited.fetchImpl}).getTopTraders(), {ok: false, reason: "rate-limited", status: 429});
});

test("getWalletPositions returns normalised live positions with hand-computed values", async () => {
  const {fetchImpl, calls} = stubFetch(() => okJson(CHS_STATE));
  const client = createHyperliquidClient({fetchImpl, infoUrl: "https://hl.test/info"});
  const res = await client.getWalletPositions(ADDR_A);
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://hl.test/info");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {type: "clearinghouseState", user: ADDR_A});
  assert.deepEqual(res.data, {
    address: ADDR_A,
    accountValue: 2500.5,
    withdrawable: 1300.25,
    positions: [
      {coin: "BTC", side: "long", size: 0.25, entryPrice: 64000, positionValue: 16800, unrealizedPnl: 750.5, roe: 0.0555, leverage: 5, liquidationPrice: 52000, marginUsed: 3360},
      {coin: "ETH", side: "short", size: -2.5, entryPrice: 3200, positionValue: 7900, unrealizedPnl: -100.25, roe: -0.0125, leverage: 3, liquidationPrice: null, marginUsed: 2633.3333}
    ]
  });
});

test("getWalletPositions validates the address before any fetch", async () => {
  const {fetchImpl, calls} = stubFetch(() => okJson(CHS_STATE));
  const client = createHyperliquidClient({fetchImpl});
  assert.deepEqual(await client.getWalletPositions("0x123"), {ok: false, reason: "invalid-address"});
  assert.deepEqual(await client.getWalletPositions("DROP TABLE users"), {ok: false, reason: "invalid-address"});
  assert.equal(calls.length, 0);
});

test("getWalletPositions is fail-closed on garbage clearinghouse state", async () => {
  const html = stubFetch(() => ({ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); }}));
  assert.deepEqual(await createHyperliquidClient({fetchImpl: html.fetchImpl}).getWalletPositions(ADDR_A), {ok: false, reason: "invalid-json"});
  const nulls = stubFetch(() => okJson(null));
  assert.deepEqual(await createHyperliquidClient({fetchImpl: nulls.fetchImpl}).getWalletPositions(ADDR_A), {ok: false, reason: "invalid-payload"});
  const badPositions = stubFetch(() => okJson({...CHS_STATE, assetPositions: [{position: {coin: "BTC", szi: "oops", entryPx: "1"}}]}));
  assert.deepEqual(await createHyperliquidClient({fetchImpl: badPositions.fetchImpl}).getWalletPositions(ADDR_A), {ok: false, reason: "invalid-payload"});
});

test("createHyperliquidClient rejects a non-function transport", () => {
  assert.throws(() => createHyperliquidClient({fetchImpl: "fetch"}), TypeError);
});
