// src/market-data/providers/hyperliquid.js
//
// Hyperliquid public data client: leaderboard + per-wallet perpetual positions.
//
// Upstream endpoints (PUBLIC, read-only, NO API key, NO auth headers, NO signing):
//   1. GET  https://stats-data.hyperliquid.xyz/Mainnet/leaderboard
//        -> {leaderboardRows:[{ethAddress,accountValue,
//             windowPerformances:[[window,{pnl,roi,vlm}],...],prize,displayName}]}
//        windows are "day" | "week" | "month" | "allTime"; pnl/vlm are USD figures,
//        roi is a decimal ratio (0.05 == 5%). Served to app.hyperliquid.xyz/leaderboard.
//   2. POST https://api.hyperliquid.xyz/info   JSON body {"type":"clearinghouseState","user":"0x…"}
//        -> {marginSummary,crossMarginSummary,crossMaintenanceMarginUsed,withdrawable,
//            assetPositions:[{type,position:{coin,szi,leverage:{type,value},entryPx,
//            positionValue,unrealizedPnl,returnOnEquity,liquidationPx,marginUsed,...}}],time}
//        Documented read-only "info" query of public on-chain perp state
//        (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint).
//        The POST body is a JSON *query* only — no credentials, no wallet, no signature.
//
// Fail-closed contract: malformed / HTML / rate-limited / null upstream data yields
// {ok:false,reason} or null — never a throw on upstream data, never NaN/Infinity.
// Normalisers are pure and deterministic (no Date.now(), no Math.random()).

export const DEFAULT_INFO_URL = "https://api.hyperliquid.xyz/info";
export const DEFAULT_LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
export const LEADERBOARD_WINDOWS = Object.freeze(["day", "week", "month", "allTime"]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Strict decimal coercion: accepts numbers and decimal strings ("12", "1.5", "-0.25", "1e3").
// Everything else (null, undefined, "", "abc", "NaN", "Infinity", "0x10", booleans,
// objects, arrays) -> null. Guarantees no NaN/Infinity ever escapes.
export function toFiniteNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Shared fail-closed JSON transport. Accepts any fetch-compatible function.
// Returns {ok:true,data} | {ok:false,reason,status?}. Never throws.
export async function requestJson(fetchImpl, url, init) {
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch {
    return {ok: false, reason: "network-error"};
  }
  if (!res || typeof res !== "object") return {ok: false, reason: "network-error"};
  const status = Number.isFinite(res.status) ? res.status : 0;
  if (res.ok !== true) return {ok: false, reason: status === 429 ? "rate-limited" : "http-error", status};
  let data;
  try {
    data = await res.json();
  } catch {
    return {ok: false, reason: "invalid-json"};
  }
  return {ok: true, data};
}

// URL/body builders (pure). These throw TypeError on programmer error (invalid
// address) exactly like src/market-data/schema.js does on invalid input; they
// never see upstream data.
export function buildLeaderboardRequest({leaderboardUrl = DEFAULT_LEADERBOARD_URL} = {}) {
  return {url: leaderboardUrl, init: {method: "GET"}};
}

export function buildClearinghouseStateBody(user) {
  if (typeof user !== "string" || !ADDRESS_RE.test(user)) throw new TypeError("invalid wallet address");
  return {type: "clearinghouseState", user};
}

export function buildInfoRequest(user, {infoUrl = DEFAULT_INFO_URL} = {}) {
  return {url: infoUrl, init: {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(buildClearinghouseStateBody(user))}};
}

export function isValidAddress(user) {
  return typeof user === "string" && ADDRESS_RE.test(user);
}

// ---------------------------------------------------------------------------
// Response normalisers (pure, deterministic, fail-closed -> null)
// ---------------------------------------------------------------------------

function windowPerformance(windowPerformances, window) {
  const none = {pnl: null, roi: null, volume: null};
  if (!Array.isArray(windowPerformances)) return none;
  for (const entry of windowPerformances) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [label, perf] = entry;
    if (label !== window || !perf || typeof perf !== "object" || Array.isArray(perf)) continue;
    return {pnl: toFiniteNumber(perf.pnl), roi: toFiniteNumber(perf.roi), volume: toFiniteNumber(perf.vlm)};
  }
  return none;
}

// raw = one leaderboardRows element. `rank` is positional metadata supplied by the
// caller (the upstream payload carries none); `window` selects the performance window.
// Returns {address, accountSize, pnl, roi, volume, rank} or null.
// Missing window performance -> pnl/roi/volume null (entry is kept: an account with
// no stats in that window is still a real account).
export function normaliseHyperliquidLeaderboardEntry(raw, {rank = null, window = "allTime"} = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const address = typeof raw.ethAddress === "string" && ADDRESS_RE.test(raw.ethAddress) ? raw.ethAddress : null;
  if (!address) return null;
  const accountSize = toFiniteNumber(raw.accountValue);
  if (accountSize === null || accountSize < 0) return null;
  const perf = windowPerformance(raw.windowPerformances, window);
  return Object.freeze({
    address,
    accountSize,
    pnl: perf.pnl,
    roi: perf.roi,
    volume: perf.volume,
    rank: Number.isInteger(rank) && rank >= 1 ? rank : null
  });
}

// raw = one assetPositions element ({type,position:{...}}).
// Returns {coin,side,size,entryPrice,positionValue,unrealizedPnl,roe,leverage,
//          liquidationPrice,marginUsed} or null.
// `size` keeps the source sign (szi: positive long, negative short).
export function normaliseHyperliquidPosition(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw.position;
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (typeof p.coin !== "string" || !p.coin.trim()) return null;
  const size = toFiniteNumber(p.szi);
  const entryPrice = toFiniteNumber(p.entryPx);
  if (size === null || size === 0 || entryPrice === null || entryPrice <= 0) return null;
  return Object.freeze({
    coin: p.coin.trim(),
    side: size > 0 ? "long" : "short",
    size,
    entryPrice,
    positionValue: toFiniteNumber(p.positionValue),
    unrealizedPnl: toFiniteNumber(p.unrealizedPnl),
    roe: toFiniteNumber(p.returnOnEquity),
    leverage: p.leverage && typeof p.leverage === "object" && !Array.isArray(p.leverage) ? toFiniteNumber(p.leverage.value) : null,
    liquidationPrice: toFiniteNumber(p.liquidationPx),
    marginUsed: toFiniteNumber(p.marginUsed)
  });
}

// raw = full clearinghouseState payload. Strict: one unparseable position means the
// account's real exposure is unknown -> whole state is rejected (fail closed).
export function normaliseHyperliquidClearinghouseState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!Array.isArray(raw.assetPositions)) return null;
  const positions = [];
  for (const entry of raw.assetPositions) {
    const position = normaliseHyperliquidPosition(entry);
    if (!position) return null;
    positions.push(position);
  }
  const margin = raw.marginSummary && typeof raw.marginSummary === "object" && !Array.isArray(raw.marginSummary) ? raw.marginSummary : null;
  return Object.freeze({
    accountValue: margin ? toFiniteNumber(margin.accountValue) : null,
    withdrawable: toFiniteNumber(raw.withdrawable),
    positions: Object.freeze(positions)
  });
}

// ---------------------------------------------------------------------------
// Client (transport-injectable; all I/O fail-closed)
// ---------------------------------------------------------------------------

export function createHyperliquidClient({fetchImpl = globalThis.fetch, infoUrl = DEFAULT_INFO_URL, leaderboardUrl = DEFAULT_LEADERBOARD_URL} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  async function fetchLeaderboard() {
    const req = buildLeaderboardRequest({leaderboardUrl});
    const res = await requestJson(fetchImpl, req.url, req.init);
    if (!res.ok) return res;
    if (!res.data || typeof res.data !== "object" || !Array.isArray(res.data.leaderboardRows)) return {ok: false, reason: "invalid-payload"};
    return {ok: true, rows: res.data.leaderboardRows};
  }

  async function fetchClearinghouseState(address) {
    if (!isValidAddress(address)) return {ok: false, reason: "invalid-address"};
    const req = buildInfoRequest(address, {infoUrl});
    const res = await requestJson(fetchImpl, req.url, req.init);
    if (!res.ok) return res;
    return {ok: true, state: res.data};
  }

  // Top leaderboard entries for `window`, ranked by descending PnL in that window
  // (stable sort: ties keep upstream order). `rank` is 1-based.
  async function getTopTraders({limit = 20, window = "allTime"} = {}) {
    if (!LEADERBOARD_WINDOWS.includes(window)) return {ok: false, reason: "invalid-window"};
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return {ok: false, reason: "invalid-limit"};
    const rows = await fetchLeaderboard();
    if (!rows.ok) return rows;
    const entries = [];
    for (const row of rows.rows) {
      const entry = normaliseHyperliquidLeaderboardEntry(row, {window});
      if (entry) entries.push(entry);
    }
    if (rows.rows.length > 0 && entries.length === 0) return {ok: false, reason: "invalid-payload"};
    entries.sort((a, b) => {
      const pa = a.pnl === null;
      const pb = b.pnl === null;
      if (pa !== pb) return pa ? 1 : -1;
      return (b.pnl || 0) - (a.pnl || 0);
    });
    return {ok: true, data: entries.slice(0, limit).map((entry, i) => Object.freeze({...entry, rank: i + 1}))};
  }

  // Normalised live positions + account context for one wallet.
  async function getWalletPositions(address) {
    const state = await fetchClearinghouseState(address);
    if (!state.ok) return state;
    const normalised = normaliseHyperliquidClearinghouseState(state.state);
    if (!normalised) return {ok: false, reason: "invalid-payload"};
    return {ok: true, data: Object.freeze({address, accountValue: normalised.accountValue, withdrawable: normalised.withdrawable, positions: normalised.positions})};
  }

  return Object.freeze({fetchLeaderboard, fetchClearinghouseState, getTopTraders, getWalletPositions});
}
