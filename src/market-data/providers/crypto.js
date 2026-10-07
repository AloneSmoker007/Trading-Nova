// src/market-data/providers/crypto.js
//
// Crypto market-data provider aggregator: Binance public REST + Hyperliquid + CoinGecko.
// Transport-injectable (pass `fetchImpl`) and fail-closed end to end.
//
// Upstream endpoints (all PUBLIC, read-only, NO API key, NO auth headers, NO signing):
//   1. GET https://api.binance.com/api/v3/klines?symbol&interval&limit
//        -> [[openTime,open,high,low,close,volume,closeTime,...],...]  (public candles)
//   2. GET https://api.binance.com/api/v3/ticker/24hr?symbol
//        -> {symbol,lastPrice,bidPrice,askPrice,highPrice,lowPrice,volume,quoteVolume,priceChangePercent,...}
//   3. GET https://api.binance.com/api/v3/ticker/bookTicker?symbol
//        -> {symbol,bidPrice,bidQty,askPrice,askQty}  (public best bid/ask)
//   4. GET https://stats-data.hyperliquid.xyz/Mainnet/leaderboard
//        -> {leaderboardRows:[...]}  (public leaderboard; see ./hyperliquid.js)
//   5. POST https://api.hyperliquid.xyz/info   body {"type":"clearinghouseState","user":"0x…"}
//        (read-only on-chain query; see ./hyperliquid.js)
//   6. GET https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=<id>&per_page=1&page=1
//        -> [{id,symbol,name,current_price,market_cap,total_volume,price_change_percentage_24h,last_updated}]
//
// Fail-closed contract: every async method resolves to {ok:true,data} or
// {ok:false,reason} — never throws on upstream data, never emits NaN/Infinity.
// Pure normalisers are deterministic (no Date.now()/Math.random(); the only clock
// use is `now()` when stamping live quote/candle receipts, exactly like
// src/market-data/connectors/binance.js).
//
// The returned provider carries getQuote/getCandles so it satisfies
// src/market-data/connectors/interface.js (assertConnector), with fail-closed
// result envelopes instead of the throwing contract of the raw interface helpers.

import {normalizeQuote, normalizeCandle} from "../connectors/interface.js";
import {detectCandleGap} from "../quality.js";
import {DEFAULT_INFO_URL, DEFAULT_LEADERBOARD_URL, createHyperliquidClient, requestJson, toFiniteNumber, normaliseHyperliquidLeaderboardEntry} from "./hyperliquid.js";

export {normaliseHyperliquidLeaderboardEntry};

const DEFAULT_SOURCES = Object.freeze({
  binance: Object.freeze({baseUrl: "https://api.binance.com"}),
  hyperliquid: Object.freeze({infoUrl: DEFAULT_INFO_URL, leaderboardUrl: DEFAULT_LEADERBOARD_URL}),
  coingecko: Object.freeze({baseUrl: "https://api.coingecko.com"})
});

// Binance interval -> milliseconds (no calendar months: "1M" is not fixed-length).
const BINANCE_INTERVAL_MS = Object.freeze({"1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000, "30m": 1800000, "1h": 3600000, "2h": 7200000, "4h": 14400000, "6h": 21600000, "8h": 28800000, "12h": 43200000, "1d": 86400000, "3d": 259200000, "1w": 604800000});
const SYMBOL_RE = /^[A-Z0-9]{2,24}$/;
const COINGECKO_ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

// ---------------------------------------------------------------------------
// Pure normalisers (no I/O, deterministic, fail-closed -> null)
// ---------------------------------------------------------------------------

// raw = one Binance kline array row:
// [openTime,open,high,low,close,volume,closeTime,trades?,...].
// Returns the canonical candle {ts,open,high,low,close,volume} (ts = open time
// taken verbatim from the source — no clock involved, no reordering) or null.
// Rejects truncated rows, non-decimal strings, inverted ranges, out-of-bounds
// OHLC and closeTime earlier than openTime (look-ahead guard).
export function normaliseBinanceKline(raw) {
  if (!Array.isArray(raw) || raw.length < 6) return null;
  const ts = toFiniteNumber(raw[0]);
  const open = toFiniteNumber(raw[1]);
  const high = toFiniteNumber(raw[2]);
  const low = toFiniteNumber(raw[3]);
  const close = toFiniteNumber(raw[4]);
  const volume = toFiniteNumber(raw[5]);
  if (ts === null || ts < 0) return null;
  if ([open, high, low, close].some((v) => v === null || v <= 0)) return null;
  if (volume === null || volume < 0) return null;
  if (high < low || open < low || open > high || close < low || close > high) return null;
  if (raw.length > 6 && raw[6] !== undefined && raw[6] !== null) {
    const closeTime = toFiniteNumber(raw[6]);
    if (closeTime === null || closeTime < ts) return null;
  }
  return Object.freeze({ts, open, high, low, close, volume});
}

// raw = one CoinGecko /coins/markets row.
// Returns {id,symbol,name,price,marketCap,volume24h,change24hPct,updatedAt} or null.
// updatedAt is epoch ms parsed from the source ISO string (pure Date.parse),
// or null when the source string is absent/unparseable.
export function normaliseCoinGeckoPrice(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  const price = toFiniteNumber(raw.current_price);
  if (price === null || price <= 0) return null;
  let updatedAt = null;
  if (typeof raw.last_updated === "string") {
    const parsed = Date.parse(raw.last_updated);
    if (Number.isFinite(parsed)) updatedAt = parsed;
  }
  return Object.freeze({
    id: raw.id.trim(),
    symbol: typeof raw.symbol === "string" ? raw.symbol : null,
    name: typeof raw.name === "string" ? raw.name : null,
    price,
    marketCap: toFiniteNumber(raw.market_cap),
    volume24h: toFiniteNumber(raw.total_volume),
    change24hPct: toFiniteNumber(raw.price_change_percentage_24h),
    updatedAt
  });
}

// Internal: /api/v3/ticker/24hr payload -> ticker or null. Missing/non-numeric
// prices (e.g. no bidPrice) fail closed.
function normaliseBinanceTicker(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.symbol !== "string" || !raw.symbol.trim()) return null;
  const last = toFiniteNumber(raw.lastPrice);
  const bid = toFiniteNumber(raw.bidPrice);
  const ask = toFiniteNumber(raw.askPrice);
  if (last === null || last <= 0) return null;
  if (bid === null || ask === null || bid <= 0 || ask <= 0 || bid > ask) return null;
  return Object.freeze({
    symbol: raw.symbol.trim().toUpperCase(),
    last,
    bid,
    ask,
    high24h: toFiniteNumber(raw.highPrice),
    low24h: toFiniteNumber(raw.lowPrice),
    volume24h: toFiniteNumber(raw.volume),
    quoteVolume24h: toFiniteNumber(raw.quoteVolume),
    changePct24h: toFiniteNumber(raw.priceChangePercent)
  });
}

// Internal: /api/v3/ticker/bookTicker payload -> {symbol,bid,ask} or null.
function normaliseBinanceBookTicker(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const bid = toFiniteNumber(raw.bidPrice);
  const ask = toFiniteNumber(raw.askPrice);
  if (bid === null || ask === null || bid <= 0 || ask <= 0 || bid > ask) return null;
  const symbol = typeof raw.symbol === "string" && raw.symbol.trim() ? raw.symbol.trim().toUpperCase() : null;
  return {symbol, bid, ask};
}

// Internal: GET url builder with query string (no URLSearchParams dependency).
function buildUrl(base, path, params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v)))
    .join("&");
  return base + path + (qs ? "?" + qs : "");
}

function resolveSources(sources) {
  const s = sources && typeof sources === "object" ? sources : {};
  return {
    binance: {...DEFAULT_SOURCES.binance, ...(s.binance || {})},
    hyperliquid: {...DEFAULT_SOURCES.hyperliquid, ...(s.hyperliquid || {})},
    coingecko: {...DEFAULT_SOURCES.coingecko, ...(s.coingecko || {})}
  };
}

function validateSymbol(symbol) {
  const sym = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
  return SYMBOL_RE.test(sym) ? sym : null;
}

// Continuity audit over a sorted candle list: every non-contiguous neighbour
// pair is reported (with the number of missing bars) so callers can fail closed
// via dataQualityGate instead of silently computing indicators across an outage
// window. Uses the shared quality.js `detectCandleGap` predicate.
function candleGaps(candles, intervalMs) {
  const gaps = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    if (detectCandleGap({openTime: prev.ts}, {openTime: cur.ts}, intervalMs)) {
      gaps.push(Object.freeze({fromTs: prev.ts, toTs: cur.ts, missingBars: Math.max(0, Math.round((cur.ts - prev.ts) / intervalMs) - 1)}));
    }
  }
  return Object.freeze(gaps);
}

// ---------------------------------------------------------------------------
// Provider factory (transport-injectable)
// ---------------------------------------------------------------------------

export function createCryptoProvider({fetchImpl = globalThis.fetch, sources, now = () => Date.now(), http = {}} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const cfg = resolveSources(sources);
  // Bounded HTTP transport: per-attempt AbortSignal.timeout + deadline-aware
  // retries on transient failures (never on 429).
  const httpOpts = {timeoutMs: 10000, retries: 2, retryDelayMs: 100, deadlineMs: 30000, ...http};
  const hyperliquid = createHyperliquidClient({fetchImpl, infoUrl: cfg.hyperliquid.infoUrl, leaderboardUrl: cfg.hyperliquid.leaderboardUrl, http: httpOpts});

  // Normalised candles {ts,open,high,low,close,volume}, sorted ascending by ts.
  async function getKlines({symbol, interval = "1m", limit = 100} = {}) {
    const sym = validateSymbol(symbol);
    if (!sym) return {ok: false, reason: "invalid-symbol"};
    if (!Object.hasOwn(BINANCE_INTERVAL_MS, interval)) return {ok: false, reason: "invalid-interval"};
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return {ok: false, reason: "invalid-limit"};
    const res = await requestJson(fetchImpl, buildUrl(cfg.binance.baseUrl, "/api/v3/klines", {symbol: sym, interval, limit}), undefined, httpOpts);
    if (!res.ok) return res;
    if (!Array.isArray(res.data)) return {ok: false, reason: "invalid-payload"};
    const candles = [];
    for (const row of res.data) {
      const candle = normaliseBinanceKline(row);
      if (!candle) return {ok: false, reason: "invalid-payload"};
      candles.push(candle);
    }
    candles.sort((a, b) => a.ts - b.ts);
    // Robust gap handling: surface discontinuities instead of pretending the
    // series is continuous (empty `gaps` == no holes).
    return {ok: true, data: candles, gaps: candleGaps(candles, BINANCE_INTERVAL_MS[interval])};
  }

  async function getTicker(symbol) {
    const sym = validateSymbol(symbol);
    if (!sym) return {ok: false, reason: "invalid-symbol"};
    const res = await requestJson(fetchImpl, buildUrl(cfg.binance.baseUrl, "/api/v3/ticker/24hr", {symbol: sym}), undefined, httpOpts);
    if (!res.ok) return res;
    const ticker = normaliseBinanceTicker(res.data);
    return ticker ? {ok: true, data: ticker} : {ok: false, reason: "invalid-payload"};
  }

  // Interface-compatible quote (see connectors/interface.js), fail-closed envelope.
  async function getQuote(symbol) {
    const sym = validateSymbol(symbol);
    if (!sym) return {ok: false, reason: "invalid-symbol"};
    const res = await requestJson(fetchImpl, buildUrl(cfg.binance.baseUrl, "/api/v3/ticker/bookTicker", {symbol: sym}), undefined, httpOpts);
    if (!res.ok) return res;
    const book = normaliseBinanceBookTicker(res.data);
    if (!book || !book.symbol) return {ok: false, reason: "invalid-payload"};
    const t = now();
    try {
      return {ok: true, data: normalizeQuote({source: "binance-public", symbol: book.symbol, bid: book.bid, ask: book.ask, timestamp: t, receivedAt: t})};
    } catch {
      return {ok: false, reason: "invalid-payload"};
    }
  }

  // Interface-compatible candles (see connectors/interface.js), fail-closed envelope.
  // closeTime is derived as ts + intervalMs - 1 (the same convention Binance uses).
  async function getCandles(symbol, {interval = "1m", limit = 100} = {}) {
    const sym = validateSymbol(symbol);
    if (!sym) return {ok: false, reason: "invalid-symbol"};
    const res = await getKlines({symbol: sym, interval, limit});
    if (!res.ok) return res;
    const intervalMs = BINANCE_INTERVAL_MS[interval];
    const receivedAt = now();
    try {
      return {
        ok: true,
        data: res.data.map((c) => normalizeCandle({source: "binance-public", symbol: sym, openTime: c.ts, closeTime: c.ts + intervalMs - 1, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, receivedAt})),
        gaps: res.gaps
      };
    } catch {
      return {ok: false, reason: "invalid-payload"};
    }
  }

  // CoinGecko market row for one coin id (e.g. "bitcoin").
  async function getCoinPrice(id) {
    const coinId = typeof id === "string" ? id.trim() : "";
    if (!COINGECKO_ID_RE.test(coinId)) return {ok: false, reason: "invalid-id"};
    const res = await requestJson(fetchImpl, buildUrl(cfg.coingecko.baseUrl, "/api/v3/coins/markets", {vs_currency: "usd", ids: coinId, per_page: 1, page: 1}), undefined, httpOpts);
    if (!res.ok) return res;
    if (!Array.isArray(res.data) || res.data.length === 0) return {ok: false, reason: "invalid-payload"};
    const price = normaliseCoinGeckoPrice(res.data[0]);
    return price ? {ok: true, data: price} : {ok: false, reason: "invalid-payload"};
  }

  // Real traders' live leaderboard: {address,accountSize,pnl,roi,volume,rank}[].
  async function getTopTraders(options) {
    return hyperliquid.getTopTraders(options);
  }

  // Real trader's live positions: {address,accountValue,withdrawable,positions}.
  async function getWalletPositions(address) {
    return hyperliquid.getWalletPositions(address);
  }

  return Object.freeze({getKlines, getTicker, getQuote, getCandles, getCoinPrice, getTopTraders, getWalletPositions});
}
