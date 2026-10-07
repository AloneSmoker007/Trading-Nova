// server/state.js — read-only paper state (portfolio + journal) loader.
//
// The web app NEVER writes trading state. It reads an optional JSON snapshot
// produced later by the paper-execution path (WS-A / milestone M3) and exposes
// it through the real engine modules:
//   - src/risk/portfolio.js  buildPortfolioState / validatePortfolioState
//   - src/risk/limits.js     evaluateLimits (fail-closed verdict)
//   - src/journal/journal.js verifyJournal (hash-chain integrity)
//
// Snapshot contract (all fields optional except version):
//   {
//     "version": 1,
//     "updatedAt": 1700000000000,                  // epoch ms
//     "portfolio": {
//       "cash": 10000,
//       "startingEquity": 10000,
//       "positions": [{"symbol": "BTCUSDT", "quantity": 0.1, "markPrice": 42000}]
//     },
//     "limits": {
//       "daily":   {"realizedPnl": 0, "startingEquity": 10000, "dailyLossLimitPct": 2},
//       "weekly":  {"realizedPnl": 0, "startingEquity": 10000, "weeklyLossLimitPct": 5},
//       "drawdown":{"peakEquity": 10000, "currentEquity": 10000, "maxDrawdownPct": 10}
//     },
//     "journal": [{"index": 0, "previousHash": "GENESIS", "entry": {...}, "hash": "..."}]
//   }
//
// Honest states returned to the API layer:
//   {state:"empty"}                 no snapshot file — there is genuinely no paper state yet
//   {state:"ok", ...}               snapshot present and valid (age reported)
//   {state:"error", reason, ...}    snapshot present but unreadable/invalid — never "assumed fine"

import {readFile} from "node:fs/promises";
import {buildPortfolioState} from "../src/risk/portfolio.js";
import {evaluateLimits} from "../src/risk/limits.js";
import {verifyJournal} from "../src/journal/journal.js";

const MAX_JOURNAL_ENTRIES = 200;

function safePortfolio(raw) {
  if (!raw || typeof raw !== "object") return null;
  const cash = raw.cash;
  const startingEquity = raw.startingEquity !== undefined ? raw.startingEquity : raw.cash;
  const positions = Array.isArray(raw.positions) ? raw.positions : [];
  return buildPortfolioState({cash, positions, startingEquity});
}

export async function loadPaperState(stateFile, now = Date.now()) {
  let text;
  try {
    text = await readFile(stateFile, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return {state: "empty", reason: "no-paper-state"};
    return {state: "error", reason: "paper-state-unreadable"};
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return {state: "error", reason: "paper-state-invalid-json"};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {state: "error", reason: "paper-state-invalid-shape"};
  }

  let portfolio = null;
  let limits = null;
  if (raw.portfolio !== undefined) {
    if (!raw.portfolio || typeof raw.portfolio !== "object" || Array.isArray(raw.portfolio)) {
      return {state: "error", reason: "paper-state-invalid-portfolio"};
    }
    try {
      portfolio = safePortfolio(raw.portfolio);
    } catch {
      return {state: "error", reason: "paper-state-invalid-portfolio"};
    }
    if (!portfolio) {
      return {state: "error", reason: "paper-state-invalid-portfolio"};
    }
    if (raw.limits && typeof raw.limits === "object") {
      limits = evaluateLimits(raw.limits); // fail-closed verdict; never assumed fine
    }
  }

  const journal = Array.isArray(raw.journal) ? raw.journal : [];
  const verified = journal.length === 0 ? true : verifyJournal(journal);
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : null;

  return {
    state: "ok",
    portfolio,
    limits,
    journal: {
      entries: journal.slice(-MAX_JOURNAL_ENTRIES),
      total: journal.length,
      returned: Math.min(journal.length, MAX_JOURNAL_ENTRIES),
      verified,
      integrity: verified ? "verified" : "broken"
    },
    updatedAt,
    ageMs: updatedAt !== null ? Math.max(0, now - updatedAt) : null
  };
}

export {MAX_JOURNAL_ENTRIES};
