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
import {loadPaperState, appendJournalToFile, MAX_JOURNAL_ENTRIES} from "./state.js";
import {appendJournalEntry, verifyJournal} from "../src/journal/journal.js";
import {createPaperOrderService} from "./orders.js";
import {createStrategy, STRATEGY_DESCRIPTIONS} from "./strategies.js";
import {computeAiCouncil} from "./ai.js";
import {parseSymbol, parseInterval, parseLimit, parseStrategy} from "./validate.js";

const FRESH_MAX_AGE_MS = 10000; // "fresh" for market payloads = data age <= 10s

const ok = (data) => ({status: 200, body: {ok: true, data}});
const fail = (status, state, code, message, reason) => ({
  status,
  body: {ok: false, state, error: reason === undefined ? {code, message} : {code, message, reason}}
});

function num(v) {
  return Number.isFinite(v) ? v : null;
}

function unpackJournalSnapshot(value) {
  if (!value) return null;
  if (typeof value.payload === "string") {
    try {
      const parsed = JSON.parse(value.payload);
      return parsed && typeof parsed === "object" && Array.isArray(parsed.entries) ? parsed : {invalid: true};
    } catch {
      return {invalid: true};
    }
  }
  // Compatibility with snapshots written by the first PostgreSQL-backed draft.
  return Array.isArray(value.entries) ? value : {invalid: true};
}

export function createApi({
  market,
  stateFile,
  executionStateFile,
  store,
  now = () => Date.now(),
  tradingMode = "paper",
  startedAt = Date.now()
}) {
  const paperNote = "Paper/shadow only. Real money OFF. This API is read-only for GET endpoints.";
  const paperOrderService = createPaperOrderService({market, stateFile, executionStateFile, store, now, tradingMode});

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
    const s = await paperOrderService.getPortfolio();
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
    if (store) {
      let snapshot;
      try {
        snapshot = await store.get("paper-journal", "main");
      } catch {
        return fail(503, "unavailable", "journal-unavailable", "journal storage is temporarily unavailable");
      }
      const decoded = unpackJournalSnapshot(snapshot);
      if (decoded?.invalid) return fail(503, "unavailable", "journal-invalid", "journal storage could not be verified");
      const entries = Array.isArray(decoded?.entries) ? decoded.entries : [];
      const verified = entries.length === 0 || verifyJournal(entries);
      return ok({
        state: decoded ? "ok" : "empty",
        entries: entries.slice(-MAX_JOURNAL_ENTRIES),
        total: entries.length,
        returned: Math.min(entries.length, MAX_JOURNAL_ENTRIES),
        verified,
        integrity: verified ? "verified" : "broken",
        updatedAt: Number.isFinite(decoded?.updatedAt) ? decoded.updatedAt : null,
        ageMs: Number.isFinite(decoded?.updatedAt) ? Math.max(0, now() - decoded.updatedAt) : null,
        note: !verified
          ? "WARNING: journal hash chain does NOT verify — treat this history as untrusted."
          : decoded
            ? "PostgreSQL-backed hash-chained journal verified by src/journal/journal.js."
            : "No journal entries saved yet. " + paperNote
      });
    }
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
    let parsedBody;
    try {
      parsedBody = typeof body === "string" ? JSON.parse(body) : body;
    } catch {
      return fail(400, "error", "invalid-json", "request body must be valid JSON");
    }
    try {
      return await paperOrderService.submit(parsedBody);
    } catch {
      return fail(500, "error", "internal-error", "paper order could not be safely processed");
    }
  }

  async function markets() {
    const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "ADAUSDT"];
    const results = [];
    for (const sym of symbols) {
      try {
        const res = await market.getTicker(sym);
        if (res.state === "ok" && res.data) {
          const t = res.data;
          results.push({
            symbol: sym,
            last: num(t.last),
            bid: num(t.bid),
            ask: num(t.ask),
            volume24h: num(t.volume24h),
            changePct24h: num(t.changePct24h),
            stale: res.stale
          });
        }
      } catch {
        // skip unavailable
      }
    }
    return ok({state: "ok", count: results.length, markets: results, note: paperNote});
  }

  async function aiCouncil(query, symbolRaw) {
    const sym = parseSymbol(symbolRaw);
    if (!sym.ok) return fail(400, "error", sym.code, sym.message);
    const tickerRes = await market.getTicker(sym.symbol);
    const candlesRes = await market.getCandles(sym.symbol, {interval: "1h", limit: 100});
    const pState = await paperOrderService.getPortfolio();

    const council = computeAiCouncil({
      ticker: tickerRes.data,
      candles: candlesRes.data || [],
      portfolio: pState.portfolio,
      limits: pState.limits
    });

    return ok({state: "ok", council, note: "Advisory AI multi-brain research council. Cannot bypass Risk Gate."});
  }

  async function orders() {
    const res = await paperOrderService.getOrders();
    if (res.state === "error") return fail(500, "error", "paper-orders-error", "could not fetch orders");
    return ok({state: "ok", fills: res.fills, total: res.total, note: paperNote});
  }

  async function riskStatus() {
    const pState = await paperOrderService.getPortfolio();
    const limits = pState.limits;
    const portfolio = pState.portfolio;
    const alerts = [];
    if (portfolio?.drawdown > 0.05) {
      alerts.push({level: "WARNING", message: `Drawdown exceeds 5%: ${(portfolio.drawdown * 100).toFixed(1)}%`});
    }
    if (limits?.ok === false) {
      alerts.push({level: "CRITICAL", message: `Risk limit breach: ${(limits.reasons || []).join(", ")}`});
    }
    return ok({
      state: "ok",
      riskConfig: {
        maxPositionNotional: 5000,
        maxGrossExposure: 15000,
        maxDailyLoss: 500,
        maxDrawdownPct: 10,
        maxLeverage: 1
      },
      portfolio: portfolio ? {
        equity: portfolio.equity,
        cash: portfolio.cash,
        grossExposure: portfolio.grossExposure,
        netExposure: portfolio.netExposure,
        dailyPnl: portfolio.dailyPnl,
        drawdownPct: portfolio.drawdown !== null ? portfolio.drawdown * 100 : 0
      } : null,
      verdict: limits || {ok: true, decision: "ALLOW"},
      alerts,
      killSwitchActive: limits?.ok === false,
      note: "Deterministic Risk Gate is backend-authoritative. AI cannot override or alter risk limits."
    });
  }

  async function strategyLab(query) {
    const sym = parseSymbol(query.get("symbol"));
    if (!sym.ok) return fail(400, "error", sym.code, sym.message);
    const interval = parseInterval(query.get("interval"));
    if (!interval.ok) return fail(400, "error", interval.code, interval.message);
    const limit = parseLimit(query.get("limit"), 300);
    if (!limit.ok) return fail(400, "error", limit.code, limit.message);

    const candlesRes = await market.getCandles(sym.symbol, {interval: interval.interval, limit: limit.limit});
    if (candlesRes.state === "unavailable" || !candlesRes.data || candlesRes.data.length < 35) {
      return fail(503, "unavailable", "candles-unavailable", "insufficient candle data for strategy lab");
    }
    const candles = candlesRes.data;
    const strategies = ["sma-cross", "momentum", "famous-turtle"];
    const results = [];
    for (const stratName of strategies) {
      const strategy = createStrategy(stratName);
      if (strategy) {
        try {
          const res = runBacktestV2({candles, strategy, startingCash: 10000, feeRate: 0.001, slippageBps: 5});
          results.push({
            name: stratName,
            description: STRATEGY_DESCRIPTIONS[stratName] || "",
            returnPct: res.inSample?.returnPct ? res.inSample.returnPct * 100 : 0,
            trades: res.inSample?.trades || 0,
            finalEquity: res.inSample?.equity || 10000,
            reproducible: res.reproducible
          });
        } catch {
          // ignore strategy error
        }
      }
    }
    return ok({state: "ok", symbol: sym.symbol, candleCount: candles.length, strategies: results, note: paperNote});
  }

  async function addJournalEntry(body) {
    let parsed;
    try {
      parsed = typeof body === "string" ? JSON.parse(body) : body;
    } catch {
      return fail(400, "error", "invalid-json", "request body must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.text !== "string" || !parsed.text.trim()) {
      return fail(400, "error", "invalid-entry", "journal entry text is required");
    }
    try {
      const entryData = {
        timestamp: now(),
        type: typeof parsed.type === "string" ? parsed.type.slice(0, 40) : "thesis",
        symbol: typeof parsed.symbol === "string" ? parsed.symbol.toUpperCase().slice(0, 24) : "GENERAL",
        title: typeof parsed.title === "string" ? parsed.title.slice(0, 160) : "User Entry",
        text: parsed.text.trim(),
        tags: Array.isArray(parsed.tags)
          ? parsed.tags.filter((tag) => typeof tag === "string").slice(0, 20).map((tag) => tag.slice(0, 40))
          : []
      };
      let record;
      if (store) {
        record = await store.withTransaction(async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", ["trading_nova:journal:main"]);
          const saved = await store.get("paper-journal", "main", client);
          const snapshot = unpackJournalSnapshot(saved);
          if (snapshot?.invalid) throw new Error("journal storage is invalid");
          const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
          if (entries.length > 0 && !verifyJournal(entries)) throw new Error("journal integrity check failed");
          record = appendJournalEntry(entries, entryData);
          // Store the canonical serialized snapshot as text inside JSONB. JSONB
          // reorders object keys, which would otherwise invalidate the legacy
          // hash chain because its hashes intentionally preserve insertion order.
          await store.put("paper-journal", "main", {payload: JSON.stringify({version: 1, updatedAt: entryData.timestamp, entries})}, client);
          return record;
        });
      } else {
        record = await appendJournalToFile(stateFile, {...entryData, timestamp: undefined}, entryData.timestamp);
      }
      return ok({state: "ok", record, note: store ? "PostgreSQL-backed journal entry hash-chained and appended." : "Journal entry hash-chained and appended."});
    } catch (error) {
      const reason = typeof error?.code === "string" && /^[A-Z0-9_]{1,16}$/.test(error.code) ? error.code : undefined;
      return fail(500, "error", "journal-save-failed", "could not save journal entry safely", reason);
    }
  }

  return {health, marketData, indicators, portfolio, journal, backtest, submitPaperOrder, markets, aiCouncil, orders, riskStatus, strategyLab, addJournalEntry};
}

export {FRESH_MAX_AGE_MS, ok, fail, num};
