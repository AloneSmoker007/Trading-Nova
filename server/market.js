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

const DEFAULT_TTL_MS = 5000;          // serve from cache for 5s (protects the public upstream)
const DEFAULT_STALE_WINDOW_MS = 300000; // after upstream failure, serve stale for up to 5min

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
  sources
} = {}) {
  const provider = createCryptoProvider({fetchImpl, sources, now});
  const cache = new Map(); // key -> {data, at}
  let lastSuccessAt = null;
  let primarySuccessAt = null;
  let fallbackSuccessAt = null;

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

export {DEFAULT_TTL_MS, DEFAULT_STALE_WINDOW_MS};
