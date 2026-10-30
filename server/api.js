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
import {DEFAULT_PAPER_FEE_RATE, DEFAULT_PAPER_SLIPPAGE_BPS} from "../src/execution/costs.js";
import {createStrategy, STRATEGY_DESCRIPTIONS} from "./strategies.js";
import {computeAiCouncil} from "./ai.js";
import {parseSymbol, parseInterval, parseLimit, parseStrategy} from "./validate.js";
import {createWatchlistService} from "./watchlist.js";

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
  startedAt = Date.now(),
  paperFeeRate = DEFAULT_PAPER_FEE_RATE,
  paperSlippageBps = DEFAULT_PAPER_SLIPPAGE_BPS
}) {
  const paperNote = "Paper/shadow only. Real money OFF. This API is read-only for GET endpoints.";
  const watchlistService = createWatchlistService({store, now,
    file: typeof stateFile === "string" ? stateFile + ".watchlist.json" : undefined});
  const paperOrderService = createPaperOrderService({
    market, stateFile, executionStateFile, store, now, tradingMode,
    resolveThesis: resolveThesisReference,
    feeRate: paperFeeRate,
    slippageBps: paperSlippageBps
  });

  async function resolveThesisReference(order) {
    const snapshot = await journal();
    const data = snapshot?.status === 200 && snapshot.body?.ok === true ? snapshot.body.data : null;
    if (!data || data.verified !== true || !Array.isArray(data.entries)) {
      return {response: fail(503, "unavailable", "thesis-verification-unavailable",
        "The journal hash chain could not be verified; the paper order was not accepted.")};
    }
    const record = data.entries.find((item) => item?.hash === order.thesisHash);
    if (!record) {
      return {response: fail(400, "error", "thesis-not-found",
        "thesisHash must identify a recent verified journal record.")};
    }
    const entry = record.entry;
    if (!entry || typeof entry.type !== "string" || entry.type.toLowerCase() !== "thesis") {
      return {response: fail(400, "error", "journal-record-not-thesis",
        "thesisHash must identify a journal record whose type is thesis.")};
    }
    const thesisSymbol = typeof entry.symbol === "string" ? entry.symbol.toUpperCase() : "GENERAL";
    if (thesisSymbol !== "GENERAL" && thesisSymbol !== order.symbol) {
      return {response: fail(400, "error", "thesis-symbol-mismatch",
        "The verified thesis symbol does not match the paper order symbol.")};
    }
    return {thesisRef: Object.freeze({
      hash: record.hash,
      index: record.index,
      timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : null,
      symbol: thesisSymbol,
      title: typeof entry.title === "string" ? entry.title.slice(0, 160) : "Untitled thesis"
    })};
  }

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
      // Keep chart data truthful: this is the same normalized OHLCV feed used by indicators.
      // Lightweight Charts expects Unix timestamps in seconds.
      candles: candles.map((c) => ({
        time: Math.floor(c.openTime / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      })),
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

    // walkForward is the number of candles reserved for the in-sample run.
    // Omitted means an automatic ~70/30 split, bounded to leave at least
    // 35 candles in each sample. Explicit values are validated before I/O.
    const rawWalkForward = query.get("walkForward");
    let requestedWalkForward = null;
    if (rawWalkForward !== null && rawWalkForward !== "") {
      if (!/^\d{1,7}$/.test(rawWalkForward)) {
        return fail(400, "error", "invalid-walk-forward", "walkForward must be an integer candle split");
      }
      requestedWalkForward = Number(rawWalkForward);
      if (!Number.isSafeInteger(requestedWalkForward)
          || requestedWalkForward < 35
          || requestedWalkForward > limit.limit - 35) {
        return fail(400, "error", "invalid-walk-forward", "walkForward must leave at least 35 candles in each sample");
      }
    }

    const res = await market.getCandles(sym.symbol, {interval: interval.interval, limit: limit.limit});
    if (res.state === "unavailable") {
      return fail(503, "unavailable", "candles-unavailable", "candle history unavailable", res.reason);
    }
    const candles = res.data;
    if (candles.length < 70) {
      return fail(503, "unavailable", "insufficient-data", "at least 70 candles are required for in-sample and out-of-sample evaluation", `candleCount=${candles.length}`);
    }
    const walkForward = requestedWalkForward === null
      ? Math.min(Math.max(Math.floor(candles.length * 0.7), 35), candles.length - 35)
      : requestedWalkForward;
    if (walkForward < 35 || walkForward > candles.length - 35) {
      return fail(400, "error", "invalid-walk-forward", "walkForward must leave at least 35 available candles in each sample", `walkForward=${walkForward} candleCount=${candles.length}`);
    }

    const strategy = createStrategy(strat.strategy);
    const startingCash = 10000;
    let result;
    try {
      // Candle-close signals fill at the next candle open; OOS metrics are
      // returned separately from the in-sample window.
      result = runBacktestV2({candles, strategy, startingCash, feeRate: 0.001, slippageBps: 5, walkForward});
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
      evaluationSplit: {
        mode: requestedWalkForward === null ? "automatic" : "explicit",
        inSampleCandles: walkForward,
        outOfSampleCandles: candles.length - walkForward
      },
      startingCash,
      inSample: result.inSample,
      outOfSample: result.outOfSample,
      reproducible: result.reproducible,
      note: "Backtest uses a deterministic in-sample/out-of-sample split over historical candles. Candle-close signals fill at the next candle open. Paper/shadow only; past performance is not a prediction of future results. Real money OFF."
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

  async function paperOrders() {
    const result = await paperOrderService.getPaperOrders();
    if (result.state === "error") {
      return fail(500, "error", "paper-orders-error", "could not fetch pending paper orders");
    }
    return ok({
      state: "ok",
      orders: result.orders,
      total: result.total,
      pendingCount: result.pendingCount,
      note: result.note || paperNote
    });
  }

  async function cancelPaperOrder(orderId) {
    try {
      return await paperOrderService.cancelOrder(orderId);
    } catch {
      return fail(500, "error", "paper-order-cancel-failed", "paper order could not be safely canceled");
    }
  }

  async function processPaperOrders() {
    return paperOrderService.processPendingOrders();
  }

  async function markets() {
    let saved;
    try { saved = await watchlistService.read(); }
    catch { return fail(503, "unavailable", "watchlist-unavailable", "Saved watchlist could not be read."); }
    // At most 20 symbols; the market service independently caps/coalesces all
    // upstream work. Keep order stable without serial quote-request delays.
    const snapshots = await Promise.all(saved.symbols.map(async sym => {
      let row = {symbol: sym, state: "unavailable", last: null, bid: null, ask: null,
        volume24h: null, quoteVolume24h: null, changePct24h: null, stale: true, ageMs: null};
      try {
        const res = await market.getTicker(sym);
        if (["ok", "stale"].includes(res.state) && Number.isFinite(res.data?.last) && res.data.last > 0) {
          const t = res.data;
          const fresh = res.state === "ok" && res.stale !== true && Number.isFinite(res.ageMs)
            && res.ageMs >= 0 && res.ageMs <= FRESH_MAX_AGE_MS;
          row = {
            symbol: sym, state: fresh ? "ok" : "stale",
            last: num(t.last),
            bid: num(t.bid),
            ask: num(t.ask),
            volume24h: num(t.volume24h),
            quoteVolume24h: num(t.quoteVolume24h),
            changePct24h: num(t.changePct24h),
            stale: !fresh, ageMs: Number.isFinite(res.ageMs) && res.ageMs >= 0 ? res.ageMs : null
          };
        }
      } catch {
        // Keep the saved symbol visible with an honest unavailable quote.
      }
      return {row, receivedAt: now()};
    }));
    const assessedAt = now();
    const results = snapshots.map(({row, receivedAt}) => {
      if (row.state === "unavailable") return row;
      const elapsed = assessedAt - receivedAt;
      const ageMs = row.ageMs !== null && Number.isFinite(elapsed) && elapsed >= 0 ? row.ageMs + elapsed : null;
      const stale = row.stale || ageMs === null || ageMs > FRESH_MAX_AGE_MS;
      return {...row, ageMs, stale, state: stale ? "stale" : "ok"};
    });
    return ok({...saved, state: results.length === 0 ? "empty" : results.some(row => row.state !== "ok") ? "stale" : "ok",
      count: results.length, markets: results, note: paperNote});
  }

  async function watchlist() {
    try { const saved = await watchlistService.read(); return ok({...saved, state: saved.symbols.length ? "ok" : "empty"}); }
    catch { return fail(503, "unavailable", "watchlist-unavailable", "Saved watchlist could not be read."); }
  }

  async function saveWatchlist(body) {
    let input;
    try { input = typeof body === "string" ? JSON.parse(body) : body; }
    catch { return fail(400, "error", "invalid-json", "Send a JSON watchlist."); }
    try {
      const saved = await watchlistService.save(input);
      return ok({...saved, state: saved.symbols.length ? "ok" : "empty"});
    } catch (error) {
      if (error?.code === "invalid-watchlist") return fail(400, "error", error.code, "Use up to 20 unique USDT market symbols and a valid watchlist revision.");
      if (error?.code === "watchlist-conflict") return fail(409, "error", error.code, "Watchlist changed in another request. Reload it before editing.");
      return fail(503, "unavailable", "watchlist-unavailable", "Watchlist could not be saved.");
    }
  }

  async function aiCouncil(query, symbolRaw) {
    const sym = parseSymbol(symbolRaw);
    if (!sym.ok) return fail(400, "error", sym.code, sym.message);
    const tickerRes = await market.getTicker(sym.symbol);
    const tickerReadAt = now();
    const candlesRes = await market.getCandles(sym.symbol, {interval: "1h", limit: 100});
    const candlesReadAt = now();
    if (!["ok", "stale"].includes(tickerRes?.state)
        || !Number.isFinite(tickerRes?.data?.last) || tickerRes.data.last <= 0
        || !["ok", "stale"].includes(candlesRes?.state)
        || !Array.isArray(candlesRes.data) || candlesRes.data.length < 20) {
      return fail(503, "unavailable", "council-data-unavailable", "AI Council needs a market quote and sufficient candle history; no current analysis is available");
    }
    // Fetch/cache recency is part of the evidence. A successful HTTP response
    // carrying an old snapshot must never become a fresh research signal.
    const pState = await paperOrderService.getPortfolio();
    const assessedAt = now();
    const snapshotFreshness = (result, readAt) => {
      const elapsedMs = assessedAt - readAt;
      const ageMs = Number.isFinite(result.ageMs) && result.ageMs >= 0
        && Number.isFinite(elapsedMs) && elapsedMs >= 0 ? result.ageMs + elapsedMs : null;
      return {state: result.state, ageMs,
        fresh: result.state === "ok" && result.stale !== true && ageMs !== null && ageMs <= FRESH_MAX_AGE_MS};
    };
    const freshness = {maxAgeMs: FRESH_MAX_AGE_MS,
      ticker: snapshotFreshness(tickerRes, tickerReadAt), candles: snapshotFreshness(candlesRes, candlesReadAt)};
    const stale = !freshness.ticker.fresh || !freshness.candles.fresh;

    const council = computeAiCouncil({
      ticker: tickerRes.data,
      candles: candlesRes.data || [],
      portfolio: pState.portfolio,
      limits: pState.limits
    });
    if (stale) {
      council.decision = "WAIT";
      council.opportunityScore = null;
      council.uncertainty = "High";
      council.explanation = "WAIT/NO-TRADE: market snapshot is stale or freshness unknown. Historical role details are for reference only; obtain fresh quote and candle snapshots before using current research scores.";
      council.note = "Historical snapshot only; no current opportunity score. Deterministic Risk Gate remains mandatory for every paper order.";
    }

    return ok({state: stale ? "stale" : "ok", council, freshness,
      note: "Advisory AI multi-brain research council. Cannot bypass Risk Gate."});
  }

  async function orders(query) {
    const rawLimit = query?.get("limit");
    const rawOffset = query?.get("offset");
    const limit = rawLimit === null || rawLimit === undefined || rawLimit === "" ? 100 : Number(rawLimit);
    const offset = rawOffset === null || rawOffset === undefined || rawOffset === "" ? 0 : Number(rawOffset);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
        || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
      return fail(400, "error", "invalid-order-page", "limit must be 1-200 and offset must be a non-negative integer");
    }
    const res = await paperOrderService.getOrders({limit, offset});
    if (res.state === "error") return fail(500, "error", "paper-orders-error", "could not fetch orders");
    return ok({state: "ok", fills: res.fills, total: res.total, limit: res.limit,
      offset: res.offset, hasMore: res.hasMore, note: paperNote});
  }

  async function learningOutcomes() {
    const report = await paperOrderService.getLearningReport();
    if (report.state === "error") {
      return fail(503, "unavailable", "paper-learning-unavailable",
        "Paper execution history could not be converted into a complete learning report.");
    }
    let reviewState = "unavailable";
    let lossAutopsies = [];
    const journalSnapshot = await journal();
    const journalData = journalSnapshot?.status === 200 && journalSnapshot.body?.ok === true
      ? journalSnapshot.body.data : null;
    if (journalData?.verified === true && Array.isArray(journalData.entries)
        && Number.isSafeInteger(journalData.total) && journalData.total === journalData.entries.length) {
      const outcomes = new Map(report.outcomes.map((outcome) => [outcome.outcomeId, outcome]));
      let reviewsValid = true;
      const reviews = [];
      for (const record of journalData.entries) {
        const entry = record?.entry;
        if (!entry || String(entry.type).toLowerCase() !== "loss-autopsy") continue;
        const ref = entry.reviewOf;
        const outcome = ref && outcomes.get(ref.outcomeId);
        if (!outcome || outcome.result !== "LOSS"
            || ref.thesisHash !== (outcome.thesisRef?.hash || null)
            || ref.symbol !== outcome.symbol || ref.result !== outcome.result
            || ref.netPnl !== outcome.netPnl || ref.closedAt !== outcome.closedAt
            || ref.source !== outcome.source) {
          reviewsValid = false;
          break;
        }
        reviews.push({
          recordHash: record.hash,
          recordIndex: record.index,
          timestamp: entry.timestamp,
          outcomeId: ref.outcomeId,
          thesisHash: ref.thesisHash,
          symbol: ref.symbol,
          title: typeof entry.title === "string" ? entry.title.slice(0, 160) : "Loss autopsy",
          text: typeof entry.text === "string" ? entry.text.slice(0, 2000) : "",
          tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 20) : [],
          source: "user-authored-loss-autopsy"
        });
      }
      if (reviewsValid) {
        reviewState = "verified";
        lossAutopsies = reviews;
      }
    }
    const reviewedLosses = new Set(lossAutopsies.map((review) => review.outcomeId));
    const losses = report.outcomes.filter((outcome) => outcome.result === "LOSS");
    return ok({
      ...report,
      reviewState,
      lossAutopsies,
      summary: {
        ...report.summary,
        lossAutopsyCount: reviewState === "verified" ? lossAutopsies.length : null,
        reviewedLossCount: reviewState === "verified" ? reviewedLosses.size : null,
        unreviewedLossCount: reviewState === "verified"
          ? losses.filter((outcome) => !reviewedLosses.has(outcome.outcomeId)).length : null
      },
      note: report.state === "empty"
        ? "No realized paper outcomes yet. Open positions and unmatched fills are not invented as outcomes. Real money OFF."
        : "Server-derived FIFO outcomes from reconciled paper fills, including simulated fees. Loss autopsies are hash-chained user reviews, not execution facts or profitability evidence."
    });
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
    const type = typeof parsed.type === "string" ? parsed.type.trim().toLowerCase().slice(0, 40) : "thesis";
    let reviewOf;
    if (type === "loss-autopsy") {
      if (parsed.text.trim().length > 2000) {
        return fail(400, "error", "loss-autopsy-too-long",
          "loss-autopsy text must contain at most 2000 characters");
      }
      if (typeof parsed.outcomeId !== "string" || !/^[a-f0-9]{64}$/.test(parsed.outcomeId)) {
        return fail(400, "error", "invalid-learning-outcome-id",
          "loss-autopsy entries require a lowercase sha256 outcomeId");
      }
      const report = await paperOrderService.getLearningReport();
      if (report.state === "error") {
        return fail(503, "unavailable", "paper-learning-unavailable",
          "Paper execution history could not be verified; the loss autopsy was not saved.");
      }
      const outcome = report.outcomes.find((item) => item.outcomeId === parsed.outcomeId);
      if (!outcome) {
        return fail(400, "error", "learning-outcome-not-found",
          "outcomeId must identify an existing server-derived realized paper outcome");
      }
      if (outcome.result !== "LOSS") {
        return fail(400, "error", "loss-autopsy-requires-loss",
          "loss-autopsy entries can only review a server-derived realized LOSS");
      }
      reviewOf = {
        outcomeId: outcome.outcomeId,
        thesisHash: outcome.thesisRef?.hash || null,
        symbol: outcome.symbol,
        result: outcome.result,
        netPnl: outcome.netPnl,
        closedAt: outcome.closedAt,
        source: outcome.source
      };
    }
    try {
      const entryData = {
        timestamp: now(),
        type,
        symbol: reviewOf?.symbol || (typeof parsed.symbol === "string" ? parsed.symbol.toUpperCase().slice(0, 24) : "GENERAL"),
        title: typeof parsed.title === "string" ? parsed.title.slice(0, 160) : "User Entry",
        text: parsed.text.trim(),
        tags: Array.isArray(parsed.tags)
          ? parsed.tags.filter((tag) => typeof tag === "string").slice(0, 20).map((tag) => tag.slice(0, 40))
          : [],
        ...(reviewOf ? {reviewOf} : {})
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

  return {health, marketData, indicators, portfolio, journal, backtest, submitPaperOrder, paperOrders, cancelPaperOrder, processPaperOrders, markets, watchlist, saveWatchlist, aiCouncil, orders, learningOutcomes, riskStatus, strategyLab, addJournalEntry};
}

export {FRESH_MAX_AGE_MS, ok, fail, num};
