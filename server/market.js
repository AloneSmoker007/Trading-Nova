// server/market.js — market-data facade for the read-only API.
//
// Wraps the real provider (src/market-data/providers/crypto.js) and gives every
// caller an HONEST state instead of a bare value:
//   {state:"ok",          data, stale:false, ageMs}       fresh from upstream (or a fresh cache hit)
//   {state:"stale",       data, stale:true,  ageMs, reason} upstream failed; the last known
//                                                          good value is served inside the stale window
//   {state:"unavailable", reason}                        upstream failed and nothing usable is cached
//
// Freshness is measured with the engine's own assessor
// (src/market-data/quality.js `assessFreshness`) — no ad-hoc age math here.
// Transport is injectable (`fetchImpl`) so tests never touch the network.

import {createCryptoProvider} from "../src/market-data/providers/crypto.js";
import {assessFreshness} from "../src/market-data/quality.js";

const DEFAULT_TTL_MS = 5000;          // serve from cache for 5s (protects the public upstream)
const DEFAULT_STALE_WINDOW_MS = 300000; // after upstream failure, serve stale for up to 5min

export function createMarketService({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  staleWindowMs = DEFAULT_STALE_WINDOW_MS,
  sources
} = {}) {
  const provider = createCryptoProvider({fetchImpl, sources, now});
  const cache = new Map(); // key -> {data, at}
  let lastSuccessAt = null;

  async function read(key, fetcher) {
    const t = now();
    const hit = cache.get(key);
    if (hit && t - hit.at <= ttlMs) {
      return {state: "ok", data: hit.data, stale: false, ageMs: t - hit.at, cached: true};
    }
    let res;
    try {
      res = await fetcher();
    } catch {
      res = {ok: false, reason: "network-error"};
    }
    if (res && res.ok === true) {
      cache.set(key, {data: res.data, at: t});
      lastSuccessAt = t;
      return {state: "ok", data: res.data, stale: false, ageMs: 0, cached: false};
    }
    const reason = res && typeof res.reason === "string" ? res.reason : "unavailable";
    if (hit && t - hit.at <= staleWindowMs) {
      return {state: "stale", data: hit.data, stale: true, ageMs: t - hit.at, cached: true, reason};
    }
    return {state: "unavailable", reason};
  }

  return {
    // Wall-clock time of the last successful upstream read (for /api/health).
    lastSuccessAt: () => lastSuccessAt,

    getTicker(symbol) {
      return read("ticker:" + symbol, () => provider.getTicker(symbol));
    },

    getCandles(symbol, {interval, limit} = {}) {
      return read(`candles:${symbol}:${interval}:${limit}`, () => provider.getCandles(symbol, {interval, limit}));
    },

    // Freshness envelope from the engine's own assessor.
    freshness(observedAt, maxAgeMs) {
      try {
        return assessFreshness(observedAt, now(), maxAgeMs);
      } catch {
        return {ageMs: null, fresh: false, status: "stale"};
      }
    }
  };
}

export {DEFAULT_TTL_MS, DEFAULT_STALE_WINDOW_MS};
