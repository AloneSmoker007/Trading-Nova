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
import {sourceHealth} from "../src/market-data/source-health.js";

const DEFAULT_TTL_MS = 5000;             // serve from cache for 5s (protects the public upstream)
const DEFAULT_STALE_WINDOW_MS = 300000;  // after upstream failure, serve stale for up to 5min
const DEFAULT_MAX_CACHE_ENTRIES = 1000;  // hard memory bound for user-controlled symbol/cache keys
const DEFAULT_MAX_IN_FLIGHT = 32;       // hard bound for simultaneous distinct upstream reads

const SYMBOL_TO_COINGECKO_ID = Object.freeze({
  BTCUSDT: "bitcoin",
  ETHUSDT: "ethereum",
  SOLUSDT: "solana"
});

export function createMarketService({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  staleWindowMs = DEFAULT_STALE_WINDOW_MS,
  maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
  maxInFlight = DEFAULT_MAX_IN_FLIGHT,
  sources
} = {}) {
  if (!Number.isInteger(maxCacheEntries) || maxCacheEntries < 1) {
    throw new TypeError("maxCacheEntries must be a positive integer");
  }
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new TypeError("maxInFlight must be a positive integer");
  }
  const provider = createCryptoProvider({fetchImpl, sources, now});
  const cache = new Map(); // insertion order is LRU order; key -> {data, at}
  const inFlight = new Map(); // coalesce concurrent upstream reads for the same key
  let lastSuccessAt = null;
  let primarySuccessAt = null;
  let fallbackSuccessAt = null;

  function touch(key, value) {
    cache.delete(key);
    cache.set(key, value);
  }

  function remember(key, value) {
    // Evict exactly the least-recently-used entry before adding a new key.
    // This is a data cache (not a rate limiter): eviction only causes a refetch;
    // it cannot reset security state or alter trading/risk decisions.
    if (!cache.has(key) && cache.size >= maxCacheEntries) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    touch(key, value);
  }

  async function read(key, fetcher) {
    const t = now();
    const hit = cache.get(key);
    if (hit && t - hit.at <= ttlMs) {
      touch(key, hit);
      return {state: "ok", data: hit.data, stale: false, ageMs: t - hit.at, cached: true};
    }

    const pending = inFlight.get(key);
    if (pending) {
      const shared = await pending;
      return {...shared, cached: true};
    }

    // Different cache keys cannot coalesce. Cap their simultaneous upstream
    // work so a burst of unique symbols cannot grow inFlight without bound.
    if (inFlight.size >= maxInFlight) {
      if (hit && t - hit.at <= staleWindowMs) {
        touch(key, hit);
        return {state: "stale", data: hit.data, stale: true, ageMs: t - hit.at, cached: true, reason: "upstream-capacity"};
      }
      return {state: "unavailable", reason: "upstream-capacity"};
    }

    const request = (async () => {
      let res;
      try {
        res = await fetcher();
      } catch {
        res = {ok: false, reason: "network-error"};
      }
      if (res && res.ok === true) {
        // A cache entry becomes fresh when the upstream read completes, not
        // when it begins; otherwise slow fetches make new data look older.
        const completedAt = now();
        remember(key, {data: res.data, at: completedAt});
        lastSuccessAt = completedAt;
        return {state: "ok", data: res.data, stale: false, ageMs: Math.max(0, now() - completedAt), cached: false};
      }
      const reason = res && typeof res.reason === "string" ? res.reason : "unavailable";
      if (hit && t - hit.at <= staleWindowMs) {
        touch(key, hit);
        return {state: "stale", data: hit.data, stale: true, ageMs: t - hit.at, cached: true, reason};
      }
      return {state: "unavailable", reason};
    })();

    inFlight.set(key, request);
    try {
      return await request;
    } finally {
      if (inFlight.get(key) === request) inFlight.delete(key);
    }
  }

  return {
    // Wall-clock time of the last successful upstream read (for /api/health).
    lastSuccessAt: () => lastSuccessAt,

    async getTicker(symbol) {
      const sym = typeof symbol === "string" ? symbol.toUpperCase() : "";
      const result = await read("ticker:" + sym, async () => {
        const primary = await provider.getTicker(sym);
        if (primary.ok) {
          primarySuccessAt = now();
          return primary;
        }
        // Secondary fallback to CoinGecko price if primary Binance fails
        const coinId = SYMBOL_TO_COINGECKO_ID[sym];
        if (coinId) {
          const fallback = await provider.getCoinPrice(coinId);
          if (fallback.ok && fallback.data) {
            fallbackSuccessAt = now();
            return {
              ok: true,
              data: {
                symbol: sym,
                last: fallback.data.price,
                bid: fallback.data.price * 0.9995,
                ask: fallback.data.price * 1.0005,
                volume24h: fallback.data.volume24h,
                changePct24h: fallback.data.change24hPct,
                source: "coingecko-fallback"
              }
            };
          }
        }
        return primary;
      });
      return result;
    },

    getCandles(symbol, {interval, limit} = {}) {
      return read(`candles:${symbol}:${interval}:${limit}`, () => provider.getCandles(symbol, {interval, limit}));
    },

    getSourceHealth() {
      const t = now();
      return sourceHealth([
        {name: "binance-primary", enabled: true, lastEventAt: primarySuccessAt, maxAgeMs: staleWindowMs, trust: 0.95},
        {name: "coingecko-fallback", enabled: true, lastEventAt: fallbackSuccessAt, maxAgeMs: staleWindowMs, trust: 0.80}
      ], t);
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

export {DEFAULT_TTL_MS, DEFAULT_STALE_WINDOW_MS, DEFAULT_MAX_CACHE_ENTRIES, DEFAULT_MAX_IN_FLIGHT};
