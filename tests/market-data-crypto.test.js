import test from "node:test";
import assert from "node:assert/strict";
import {assertConnector} from "../src/market-data/connectors/interface.js";
import {createCryptoProvider, normaliseBinanceKline, normaliseCoinGeckoPrice, normaliseHyperliquidLeaderboardEntry} from "../src/market-data/providers/crypto.js";

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

// Binance kline row: [openTime,open,high,low,close,volume,closeTime,quoteVolume,trades,takerBuyBase,takerBuyQuote,ignore]
const KLINE_ROW = ["1700000000000", "100.5", "110.25", "90.0", "105.75", "12.5", "1700000059999", "1321.875", 320, "6.0", "630.0", "0"];

const COINGECKO_ROW = {
  id: "bitcoin",
  symbol: "btc",
  name: "Bitcoin",
  current_price: 67000.25,
  market_cap: 1320000000000,
  total_volume: 28500000000,
  price_change_percentage_24h: 1.85,
  last_updated: "2024-01-01T00:00:00.000Z"
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

// ---------------------------------------------------------------------------
// Pure normalisers
// ---------------------------------------------------------------------------

test("normaliseBinanceKline maps a valid row with hand-computed values", () => {
  const c = normaliseBinanceKline(KLINE_ROW);
  assert.equal(c.ts, 1700000000000);
  assert.equal(c.open, 100.5);
  assert.equal(c.high, 110.25);
  assert.equal(c.low, 90);
  assert.equal(c.close, 105.75);
  assert.equal(c.volume, 12.5);
  assert.deepEqual(Object.keys(c).sort(), ["close", "high", "low", "open", "ts", "volume"]);
});

test("normaliseBinanceKline accepts numeric cells and rows without closeTime", () => {
  const c = normaliseBinanceKline([1700000000000, 1, 2, 0.5, 1.5, 10]);
  assert.deepEqual(c, {ts: 1700000000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10});
});

test("normaliseBinanceKline is fail-closed on garbage, truncation and bad numbers", () => {
  assert.equal(normaliseBinanceKline(null), null);
  assert.equal(normaliseBinanceKline("1700000000000,100,110,90,105,12"), null); // CSV / HTML-ish string
  assert.equal(normaliseBinanceKline("<html>429 Too Many Requests</html>"), null);
  assert.equal(normaliseBinanceKline({0: 1, length: 7}), null); // array-like object
  assert.equal(normaliseBinanceKline([]), null); // truncated: no cells
  assert.equal(normaliseBinanceKline(["1700000000000", "100"]), null); // truncated: 2 cells
  assert.equal(normaliseBinanceKline(["1700000000000", "100", "110", "90", "105"]), null); // truncated: 5 cells
  assert.equal(normaliseBinanceKline(["abc", "100", "110", "90", "105", "12", "1700000059999"]), null); // non-numeric ts
  assert.equal(normaliseBinanceKline(["1700000000000", "oops", "110", "90", "105", "12", "1700000059999"]), null); // non-numeric open
  assert.equal(normaliseBinanceKline(["1700000000000", "Infinity", "110", "90", "105", "12", "1700000059999"]), null);
  assert.equal(normaliseBinanceKline(["1700000000000", "100", "NaN", "90", "105", "12", "1700000059999"]), null);
  assert.equal(normaliseBinanceKline(["1700000000000", "0x10", "110", "90", "105", "12", "1700000059999"]), null); // hex string is not a price
  assert.equal(normaliseBinanceKline(["1700000000000", "100", "110", "90", "105", "-12", "1700000059999"]), null); // negative volume
  assert.equal(normaliseBinanceKline(["1700000000000", "100", "80", "90", "105", "12", "1700000059999"]), null); // high < low
  assert.equal(normaliseBinanceKline(["1700000000000", "100", "110", "90", "120", "12", "1700000059999"]), null); // close above high
  assert.equal(normaliseBinanceKline(["1700000000000", "100", "110", "90", "105", "12", "1699999999999"]), null); // closeTime before openTime (look-ahead guard)
});

test("normaliseCoinGeckoPrice maps a markets row with hand-computed values", () => {
  const p = normaliseCoinGeckoPrice(COINGECKO_ROW);
  assert.equal(p.id, "bitcoin");
  assert.equal(p.symbol, "btc");
  assert.equal(p.name, "Bitcoin");
  assert.equal(p.price, 67000.25);
  assert.equal(p.marketCap, 1320000000000);
  assert.equal(p.volume24h, 28500000000);
  assert.equal(p.change24hPct, 1.85);
  assert.equal(p.updatedAt, 1704067200000); // 2024-01-01T00:00:00.000Z exactly
});

test("normaliseCoinGeckoPrice is fail-closed on missing/invalid price fields", () => {
  assert.equal(normaliseCoinGeckoPrice(null), null);
  assert.equal(normaliseCoinGeckoPrice("<html>error</html>"), null);
  assert.equal(normaliseCoinGeckoPrice([COINGECKO_ROW]), null);
  assert.equal(normaliseCoinGeckoPrice({...COINGECKO_ROW, id: ""}), null);
  assert.equal(normaliseCoinGeckoPrice({...COINGECKO_ROW, id: 42}), null);
  assert.equal(normaliseCoinGeckoPrice({...COINGECKO_ROW, current_price: undefined}), null); // missing price
  assert.equal(normaliseCoinGeckoPrice({...COINGECKO_ROW, current_price: "N/A"}), null); // non-numeric price
  assert.equal(normaliseCoinGeckoPrice({...COINGECKO_ROW, current_price: "Infinity"}), null);
  assert.equal(normaliseCoinGeckoPrice({...COINGECKO_ROW, current_price: 0}), null);
});

test("normaliseCoinGeckoPrice tolerates a garbage timestamp but never invents one", () => {
  const p = normaliseCoinGeckoPrice({...COINGECKO_ROW, last_updated: "yesterday-ish", price_change_percentage_24h: null});
  assert.equal(p.price, 67000.25);
  assert.equal(p.updatedAt, null);
  assert.equal(p.change24hPct, null);
});

test("crypto.js re-exports the pure Hyperliquid entry normaliser", () => {
  const e = normaliseHyperliquidLeaderboardEntry(LB_ROW_B, {window: "day", rank: 7});
  assert.deepEqual(e, {address: ADDR_B, accountSize: 2000.75, pnl: 300.25, roi: 0.15, volume: 20000, rank: 7});
});

// ---------------------------------------------------------------------------
// Provider: interface compatibility + I/O via stub transport only
// ---------------------------------------------------------------------------

test("provider satisfies the existing connector interface", () => {
  const {fetchImpl} = stubFetch(() => okJson([]));
  assert.doesNotThrow(() => assertConnector(createCryptoProvider({fetchImpl})));
});

test("getKlines returns normalised candles sorted ascending from the public endpoint", async () => {
  const rows = [
    ["1700000060000", "105.5", "115", "100", "110", "20", "1700000119999"],
    ["1700000000000", "100.5", "110.25", "90.0", "105.75", "12.5", "1700000059999"],
    ["1700000120000", "110", "120", "105", "115", "30", "1700000179999"]
  ];
  const {fetchImpl, calls} = stubFetch(() => okJson(rows));
  const provider = createCryptoProvider({fetchImpl});
  const res = await provider.getKlines({symbol: "btcusdt", interval: "1m", limit: 3});
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=3");
  assert.equal(res.data.length, 3);
  // defensive sort: rows arrived out of order; ts values are kept from the source
  assert.deepEqual(res.data.map((c) => c.ts), [1700000000000, 1700000060000, 1700000120000]);
  assert.equal(res.data[0].open, 100.5);
  assert.equal(res.data[1].close, 110);
  assert.equal(res.data[2].volume, 30);
});

test("getKlines fails closed on a payload with any malformed row", async () => {
  const {fetchImpl} = stubFetch(() => okJson([KLINE_ROW, ["1700000060000", "oops"]]));
  const res = await createCryptoProvider({fetchImpl}).getKlines({symbol: "BTCUSDT"});
  assert.deepEqual(res, {ok: false, reason: "invalid-payload"});
});

test("getKlines validates inputs without touching the network", async () => {
  const {fetchImpl, calls} = stubFetch(() => okJson([]));
  const provider = createCryptoProvider({fetchImpl});
  assert.deepEqual(await provider.getKlines({symbol: "%%"}), {ok: false, reason: "invalid-symbol"});
  assert.deepEqual(await provider.getKlines({symbol: ""}), {ok: false, reason: "invalid-symbol"});
  assert.deepEqual(await provider.getKlines({symbol: "BTCUSDT", interval: "7m"}), {ok: false, reason: "invalid-interval"});
  assert.deepEqual(await provider.getKlines({symbol: "BTCUSDT", interval: "1M"}), {ok: false, reason: "invalid-interval"});
  assert.deepEqual(await provider.getKlines({symbol: "BTCUSDT", limit: 0}), {ok: false, reason: "invalid-limit"});
  assert.deepEqual(await provider.getKlines({symbol: "BTCUSDT", limit: 2000}), {ok: false, reason: "invalid-limit"});
  assert.deepEqual(await provider.getKlines({symbol: "BTCUSDT", limit: 1.5}), {ok: false, reason: "invalid-limit"});
  assert.equal(calls.length, 0);
});

test("provider transport failures are fail-closed, never thrown", async () => {
  const cases = [
    {handler: () => ({ok: false, status: 429, json: async () => ({})}), want: {ok: false, reason: "rate-limited", status: 429}},
    {handler: () => ({ok: false, status: 500, json: async () => ({})}), want: {ok: false, reason: "http-error", status: 500}},
    {handler: () => ({ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); }}), want: {ok: false, reason: "invalid-json"}},
    {handler: async () => { throw new Error("ECONNREFUSED"); }, want: {ok: false, reason: "network-error"}},
    {handler: () => okJson({not: "an array"}), want: {ok: false, reason: "invalid-payload"}},
    {handler: () => okJson(null), want: {ok: false, reason: "invalid-payload"}}
  ];
  for (const c of cases) {
    const {fetchImpl} = stubFetch(c.handler);
    const res = await createCryptoProvider({fetchImpl}).getKlines({symbol: "BTCUSDT"});
    assert.deepEqual(res, c.want);
  }
});

test("getTicker normalises the 24hr ticker with hand-computed values", async () => {
  const payload = {symbol: "btcusdt", lastPrice: "67001", bidPrice: "67000.5", askPrice: "67001.25", highPrice: "68000", lowPrice: "66000", volume: "1234.5", quoteVolume: "82745000", priceChangePercent: "1.52"};
  const {fetchImpl, calls} = stubFetch(() => okJson(payload));
  const res = await createCryptoProvider({fetchImpl}).getTicker("BTCUSDT");
  assert.equal(res.ok, true);
  assert.equal(calls[0].url, "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT");
  assert.deepEqual(res.data, {symbol: "BTCUSDT", last: 67001, bid: 67000.5, ask: 67001.25, high24h: 68000, low24h: 66000, volume24h: 1234.5, quoteVolume24h: 82745000, changePct24h: 1.52});
});

test("getTicker is fail-closed on missing bidPrice and crossed books", async () => {
  const {fetchImpl} = stubFetch(() => okJson({symbol: "BTCUSDT", lastPrice: "67001", askPrice: "67001.25", highPrice: "68000", lowPrice: "66000"}));
  assert.deepEqual(await createCryptoProvider({fetchImpl}).getTicker("BTCUSDT"), {ok: false, reason: "invalid-payload"});
  const crossed = stubFetch(() => okJson({symbol: "BTCUSDT", lastPrice: "67001", bidPrice: "67002", askPrice: "67001"}));
  assert.deepEqual(await createCryptoProvider({fetchImpl: crossed.fetchImpl}).getTicker("BTCUSDT"), {ok: false, reason: "invalid-payload"});
});

test("getQuote returns an interface-normalised quote with hand-computed bid/ask", async () => {
  const payload = {symbol: "BTCUSDT", bidPrice: "67000.5", bidQty: "1.2", askPrice: "67001.25", askQty: "0.8"};
  const {fetchImpl, calls} = stubFetch(() => okJson(payload));
  const provider = createCryptoProvider({fetchImpl, now: () => 5000});
  const res = await provider.getQuote("BTCUSDT");
  assert.equal(res.ok, true);
  assert.equal(calls[0].url, "https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT");
  assert.equal(res.data.source, "binance-public");
  assert.equal(res.data.symbol, "BTCUSDT");
  assert.equal(res.data.bid, 67000.5);
  assert.equal(res.data.ask, 67001.25);
  assert.equal(res.data.timestamp, 5000);
  assert.equal(res.data.ageMs, 0);
  assert.equal(res.data.trust, 1);
});

test("getQuote is fail-closed when bidPrice is missing", async () => {
  const {fetchImpl} = stubFetch(() => okJson({symbol: "BTCUSDT", bidQty: "1.2", askPrice: "67001.25", askQty: "0.8"}));
  assert.deepEqual(await createCryptoProvider({fetchImpl}).getQuote("BTCUSDT"), {ok: false, reason: "invalid-payload"});
});

test("getCandles derives openTime/closeTime deterministically from the source ts", async () => {
  const {fetchImpl} = stubFetch(() => okJson([KLINE_ROW]));
  const provider = createCryptoProvider({fetchImpl, now: () => 4242});
  const res = await provider.getCandles("BTCUSDT", {interval: "1m", limit: 1});
  assert.equal(res.ok, true);
  const candle = res.data[0];
  assert.equal(candle.source, "binance-public");
  assert.equal(candle.symbol, "BTCUSDT");
  assert.equal(candle.openTime, 1700000000000);
  assert.equal(candle.closeTime, 1700000059999); // ts + 60_000 - 1
  assert.equal(candle.open, 100.5);
  assert.equal(candle.close, 105.75);
  assert.equal(candle.receivedAt, 4242);
  assert.equal(Object.isFrozen(candle), true);
});

test("getCoinPrice normalises a CoinGecko markets row", async () => {
  const {fetchImpl, calls} = stubFetch(() => okJson([COINGECKO_ROW]));
  const res = await createCryptoProvider({fetchImpl}).getCoinPrice("bitcoin");
  assert.equal(res.ok, true);
  assert.equal(calls[0].url, "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&per_page=1&page=1");
  assert.equal(res.data.price, 67000.25);
  assert.equal(res.data.updatedAt, 1704067200000);
});

test("getCoinPrice is fail-closed on bad ids, empty results and HTML error pages", async () => {
  const {fetchImpl, calls} = stubFetch(() => okJson([COINGECKO_ROW]));
  const provider = createCryptoProvider({fetchImpl});
  assert.deepEqual(await provider.getCoinPrice("  "), {ok: false, reason: "invalid-id"});
  assert.deepEqual(await provider.getCoinPrice("bitcoin/../../admin"), {ok: false, reason: "invalid-id"});
  assert.equal(calls.length, 0);
  const empty = stubFetch(() => okJson([]));
  assert.deepEqual(await createCryptoProvider({fetchImpl: empty.fetchImpl}).getCoinPrice("bitcoin"), {ok: false, reason: "invalid-payload"});
  const html = stubFetch(() => ({ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); }}));
  assert.deepEqual(await createCryptoProvider({fetchImpl: html.fetchImpl}).getCoinPrice("bitcoin"), {ok: false, reason: "invalid-json"});
});

test("getTopTraders routes to the injectable Hyperliquid leaderboard source", async () => {
  const rows = [
    {ethAddress: ADDR_A, accountValue: "1000.5", windowPerformances: [["day", {pnl: "100.5", roi: "0.1005", vlm: "10000"}]]},
    LB_ROW_B,
    {ethAddress: ADDR_C, accountValue: "3000", windowPerformances: [["day", {pnl: "200", roi: "0.0666", vlm: "30000"}]]}
  ];
  const {fetchImpl, calls} = stubFetch(() => okJson({leaderboardRows: rows}));
  const provider = createCryptoProvider({fetchImpl, sources: {hyperliquid: {leaderboardUrl: "https://lb.test/rows"}}});
  const res = await provider.getTopTraders({limit: 2, window: "day"});
  assert.equal(res.ok, true);
  assert.equal(calls[0].url, "https://lb.test/rows");
  assert.deepEqual(res.data, [
    {address: ADDR_B, accountSize: 2000.75, pnl: 300.25, roi: 0.15, volume: 20000, rank: 1},
    {address: ADDR_C, accountSize: 3000, pnl: 200, roi: 0.0666, volume: 30000, rank: 2}
  ]);
});

test("getWalletPositions routes to the injectable Hyperliquid info source", async () => {
  const state = {
    marginSummary: {accountValue: "2500.5", totalNtlPos: "10000.0", totalRawUsd: "2500.5", totalMarginUsed: "1200.25"},
    crossMarginSummary: {accountValue: "2500.5", totalNtlPos: "10000.0", totalRawUsd: "2500.5", totalMarginUsed: "1200.25"},
    crossMaintenanceMarginUsed: "800.125",
    withdrawable: "1300.25",
    assetPositions: [
      {type: "oneWay", position: {coin: "BTC", szi: "0.25", leverage: {type: "cross", value: 5}, entryPx: "64000.0", positionValue: "16800.0", unrealizedPnl: "750.5", returnOnEquity: "0.0555", liquidationPx: "52000.0", marginUsed: "3360.0"}}
    ],
    time: 1791246394974
  };
  const {fetchImpl, calls} = stubFetch(() => okJson(state));
  const provider = createCryptoProvider({fetchImpl, sources: {hyperliquid: {infoUrl: "https://hl.test/info"}}});
  const res = await provider.getWalletPositions(ADDR_A);
  assert.equal(res.ok, true);
  assert.equal(calls[0].url, "https://hl.test/info");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {type: "clearinghouseState", user: ADDR_A});
  assert.deepEqual(res.data, {
    address: ADDR_A,
    accountValue: 2500.5,
    withdrawable: 1300.25,
    positions: [{coin: "BTC", side: "long", size: 0.25, entryPrice: 64000, positionValue: 16800, unrealizedPnl: 750.5, roe: 0.0555, leverage: 5, liquidationPrice: 52000, marginUsed: 3360}]
  });
});

test("getWalletPositions never calls the network on an invalid address", async () => {
  const {fetchImpl, calls} = stubFetch(() => okJson({}));
  const provider = createCryptoProvider({fetchImpl});
  assert.deepEqual(await provider.getWalletPositions("0x123"), {ok: false, reason: "invalid-address"});
  assert.deepEqual(await provider.getWalletPositions("not-an-address"), {ok: false, reason: "invalid-address"});
  assert.equal(calls.length, 0);
});
