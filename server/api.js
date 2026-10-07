// server/api.js — JSON API over the real engine modules (src/).
//
// Envelope convention (every response is JSON):
//   success: {ok: true,  data: {...}}                  — data.state: "ok" | "stale" | "empty"
//   failure: {ok: false, state: "error" | "unavailable" | "not-implemented",
//             error: {code, message, reason?}}
//
// Honest states, always:
//   "stale"       = a cached value is being served past its freshness window
//   "unavailable" = upstream/state genuinely cannot provide data right now (HTTP 503)
//   "error"       = bad request (400) or server-side failure (500) — never leaks internals
//
// GOLDEN SAFETY RULE: Paper/shadow only. Real money OFF.
// POST /api/paper/orders is GATED by Risk Gate enforcement. No execution without an ALLOW artifact.

import {healthSnapshot} from "../src/observability/health.js";
import {runBacktestV2} from "../src/backtest/engine-v2.js";
import {computeIndicators} from "./indicators.js";
import {loadPaperState} from "./state.js";
import {createStrategy, STRATEGY_DESCRIPTIONS} from "./strategies.js";
import {parseSymbol, parseInterval, parseLimit, parseStrategy} from "./validate.js";
import {paperOrders} from "./orders.js";

const FRESH_MAX_AGE_MS = 10000; // "fresh" for market payloads = data age <= 10s

const ok = (data) => ({status: 200, body: {ok: true, data}});
const fail = (status, state, code, message, reason) => ({
  status,
  body: {ok: false, state, error: reason === undefined ? {code, message} : {code, message, reason}}
});

function num(v) {
  return Number.isFinite(v) ? v : null;
}

export function createApi({market, stateFile, now = () => Date.now(), tradingMode = "paper", startedAt = Date.now()}) {
  const paperNote = "Paper/shadow only. Real money OFF. This API is read-only for GET endpoints.";

  async function health() {
    const t = now();
    const lastMarketEventAt = market.lastSuccessAt();
    const paperState = await loadPaperState(stateFile, t);
    const dependencies = {
      engine: true,
      marketData: lastMarketEventAt !== null && t - lastMarketEventAt <= FRESH_MAX_AGE_MS,
      paperState: paperState.state !== "error"
    };
    const snap = healthSnapshot({dependencies, lastMarketEventAt, now: t, maxMarketAgeMs: FRESH_MAX_AGE_MS});
    return ok({
      state: "ok",
      status: snap.status,
      marketFresh: snap.marketFresh,
      dependencies: snap.dependencies,
      checkedAt: snap.checkedAt,
      tradingMode,
      paperOnly: true,
      readOnly: false,
      orderSubmission: "paper-gated",
      uptimeMs: Math.max(0, t - startedAt),
      note: paperNote
    });
  }

  async function marketData(query, symbolRaw) {
    const sym = parseSymbol(symbolRaw);
    if (!sym.ok) return fail(400, "error", sym.code, sym.message);
    const res = await market.getTicker(sym.symbol);
    if (res.state === "unavailable") {
      return fail(503, "unavailable", "market-unavailable", "market data unavailable", res.reason);
    }
    const t = res.data;
    const freshness = market.freshness(now() - res.ageMs, FRESH_MAX_AGE_MS);
    return ok({
      state: res.state,
      symbol: sym.symbol,
      stale: res.stale,
      ageMs: res.ageMs,
      freshness,
      ticker: {
        symbol: t.symbol,
        last: num(t.last),
        bid: num(t.bid),
        ask: num(t.ask),
        high24h: num(t.high24h),
        low24h: num(t.low24h),
        volume24h: num(t.volume24h),
        quoteVolume24h: num(t.quoteVolume24h),
        changePct24h: num(t.changePct24h)
      },
      note: res.state === "stale" ? `Upstream unavailable — serving data that is ${res.ageMs}ms old.` : paperNote
    });
  }

  async function indicators(query, symbolRaw) {
    const sym = parseSymbol(symbolRaw);
    if (!sym.ok) return fail(400, "error", sym.code, sym.message);
    const interval = parseInterval(query.get("interval"));
    if (!interval.ok) return fail(400, "error", interval.code, interval.message);
    const limit = parseLimit(query.get("limit"));
    if (!limit.ok) return fail(400, "error", limit.code, limit.message);
    const res = await market.getCandles(sym.symbol, {interval: interval.interval, limit: limit.limit});
    if (res.state === "unavailable") {
      return fail(503, "unavailable", "candles-unavailable", "candle history unavailable", res.reason);
    }
    const candles = res.data;
    return ok({
      state: res.state,
      symbol: sym.symbol,
      interval: interval.interval,
      limit: limit.limit,
      stale: res.stale,
      ageMs: res.ageMs,
      candleCount: candles.length,
      indicators: computeIndicators(candles),
      note: "Indicator values are computed from real candles via src/indicators. null = not computable from this window (warm-up / insufficient data), never a guess."
    });
  }

  async function portfolio() {
    const s = await loadPaperState(stateFile, now());
    if (s.state === "error") return fail(500, "error", "paper-state-error", "paper state could not be read", s.reason);
    if (s.state === "empty") {
      return ok({
        state: "empty",
        portfolio: null,
        limits: null,
        updatedAt: null,
        ageMs: null,
        note: "No paper state on disk yet. " + paperNote
      });
    }
    return ok({
      state: "ok",
      portfolio: s.portfolio,
      limits: s.limits,
      updatedAt: s.updatedAt,
      ageMs: s.ageMs,
      note: paperNote
    });
  }

  async function journal() {
    const s = await loadPaperState(stateFile, now());
    if (s.state === "error") return fail(500, "error", "paper-state-error", "paper state could not be read", s.reason);
    if (s.state === "empty") {
      return ok({
        state: "empty",
        entries: [],
        total: 0,
        returned: 0,
        verified: true,
        integrity: "verified",
        updatedAt: null,
        ageMs: null,
        note: "No journal on disk yet. " + paperNote
      });
    }
    return ok({
      state: "ok",
      entries: s.journal.entries,
      total: s.journal.total,
      returned: s.journal.returned,
      verified: s.journal.verified,
      integrity: s.journal.integrity,
      updatedAt: s.updatedAt,
      ageMs: s.ageMs,
      note: s.journal.verified
        ? "Hash-chained journal verified by src/journal/journal.js verifyJournal."
        : "WARNING: journal hash chain does NOT verify — treat this history as untrusted."
    });
  }

  async function backtest(query) {
    const sym = parseSymbol(query.get("symbol"));
    if (!sym.ok) return fail(400, "error", sym.code, sym.message);
    const interval = parseInterval(query.get("interval"));
    if (!interval.ok) return fail(400, "error", interval.code, interval.message);
    const limit = parseLimit(query.get("limit"), 300);
    if (!limit.ok) return fail(400, "error", limit.code, limit.message);
    const strat = parseStrategy(query.get("strategy"));
    if (!strat.ok) return fail(400, "error", strat.code, strat.message);

    const res = await market.getCandles(sym.symbol, {interval: interval.interval, limit: limit.limit});
    if (res.state === "unavailable") {
      return fail(503, "unavailable", "candles-unavailable", "candle history unavailable", res.reason);
    }
    const candles = res.data;
    if (candles.length < 35) {
      return fail(503, "unavailable", "insufficient-data", "not enough candles to backtest", `candleCount=${candles.length}`);
    }
    const strategy = createStrategy(strat.strategy);
    const startingCash = 10000;
    let result;
    try {
      // Real engine: src/backtest/engine-v2.js (fees + slippage included, no look-ahead).
      result = runBacktestV2({candles, strategy, startingCash, feeRate: 0.001, slippageBps: 5});
    } catch {
      return fail(500, "error", "backtest-failed", "backtest could not be computed");
    }
    return ok({
      state: res.state,
      symbol: sym.symbol,
      interval: interval.interval,
      candleCount: candles.length,
      stale: res.stale,
      ageMs: res.ageMs,
      strategy: {name: strat.strategy, description: STRATEGY_DESCRIPTIONS[strat.strategy] || ""},
      parameters: result.parameters,
      startingCash,
      inSample: result.inSample,
      outOfSample: result.outOfSample,
      reproducible: result.reproducible,
      note: "Backtest over real historical candles (paper/shadow only). Past performance ≠ future results. Real money OFF."
    });
  }

  // POST /api/paper/orders — paper execution gated by Risk Gate.
  async function submitPaperOrder(body) {
    try {
      const parsedBody = typeof body === "string" ? JSON.parse(body) : body;
      return await paperOrders(parsedBody, stateFile, now, tradingMode);
    } catch (err) {
      return fail(400, "error", "invalid-json", "request body must be valid JSON");
    }
  }

  return {health, marketData, indicators, portfolio, journal, backtest, submitPaperOrder};
}

export {FRESH_MAX_AGE_MS, ok, fail, num};
