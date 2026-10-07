// tests/ws-d-state.test.js — WS-D web foundation: /api/portfolio + /api/journal
// over the real engine modules (risk/portfolio, risk/limits, journal/journal)
// with an injected paper-state snapshot file and injected clock.

import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {appendJournalEntry} from "../src/journal/journal.js";
import {startTestServer, getJson, findSecretViolations} from "./ws-d-helpers.js";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));

async function withTempState(raw, fn, {nowValue} = {}) {
  const dir = mkdtempSync(join(TESTS_DIR, "tmp-ws-d-"));
  const stateFile = join(dir, "paper-state.json");
  try {
    if (raw !== null) writeFileSync(stateFile, typeof raw === "string" ? raw : JSON.stringify(raw));
    return await fn(stateFile, nowValue);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

function validChain() {
  const chain = [];
  appendJournalEntry(chain, {kind: "boot", mode: "paper", note: "paper engine start"});
  appendJournalEntry(chain, {kind: "paper-fill", symbol: "BTCUSDT", side: "BUY", quantity: 0.1, price: 20000});
  return chain;
}

const PORTFOLIO = {cash: 9000, startingEquity: 10000, positions: [{symbol: "BTCUSDT", quantity: 0.1, markPrice: 20000}]};
const LIMITS_OK = {
  daily: {realizedPnl: -50, startingEquity: 10000, dailyLossLimitPct: 2},
  weekly: {realizedPnl: -50, startingEquity: 10000, weeklyLossLimitPct: 5},
  drawdown: {peakEquity: 10000, currentEquity: 11000, maxDrawdownPct: 10}
};

test("/api/portfolio is honest-empty when no paper state exists", async () => {
  await withTempState(null, async (stateFile) => {
    const srv = await startTestServer({stateFile});
    try {
      const res = await getJson(srv.base, "/api/portfolio");
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.data.state, "empty");
      assert.equal(res.body.data.portfolio, null);
      assert.match(res.body.data.note, /not wired/i);
      assert.deepEqual(findSecretViolations(res.body, res.text), []);
    } finally {
      await srv.close();
    }
  });
});

test("/api/portfolio returns real engine portfolio math + limit verdict", async () => {
  const nowValue = 1700000010000;
  await withTempState({version: 1, updatedAt: 1700000000000, portfolio: PORTFOLIO, limits: LIMITS_OK}, async (stateFile) => {
    const srv = await startTestServer({stateFile, now: () => nowValue});
    try {
      const res = await getJson(srv.base, "/api/portfolio");
      assert.equal(res.status, 200);
      const d = res.body.data;
      assert.equal(d.state, "ok");
      // These are buildPortfolioState outputs — real engine math, hand-computed:
      // equity = 9000 + 0.1*20000 = 11000; exposures = 2000;
      // dailyPnl = 11000 - 10000 = 1000; drawdown = max(0, (10000-11000)/10000) = 0.
      assert.equal(d.portfolio.equity, 11000);
      assert.equal(d.portfolio.cash, 9000);
      assert.equal(d.portfolio.grossExposure, 2000);
      assert.equal(d.portfolio.netExposure, 2000);
      assert.equal(d.portfolio.dailyPnl, 1000);
      assert.equal(d.portfolio.drawdown, 0);
      assert.equal(d.portfolio.positions[0].notional, 2000);
      assert.equal(d.limits.ok, true);
      assert.equal(d.ageMs, 10000);
      assert.equal(d.portfolio.equity < 0, false);
      assert.deepEqual(findSecretViolations(res.body, res.text), []);
    } finally {
      await srv.close();
    }
  }, {nowValue});
});

test("/api/portfolio surfaces a breached limit as BLOCKED (fail-closed verdict)", async () => {
  const limitsBreached = {
    daily: {realizedPnl: -500, startingEquity: 10000, dailyLossLimitPct: 2},
    weekly: {realizedPnl: -500, startingEquity: 10000, weeklyLossLimitPct: 5},
    drawdown: {peakEquity: 11000, currentEquity: 11000, maxDrawdownPct: 10}
  };
  await withTempState({version: 1, updatedAt: 1700000000000, portfolio: PORTFOLIO, limits: limitsBreached}, async (stateFile) => {
    const srv = await startTestServer({stateFile});
    try {
      const res = await getJson(srv.base, "/api/portfolio");
      assert.equal(res.status, 200);
      assert.equal(res.body.data.limits.ok, false);
      assert.ok(res.body.data.limits.reasons.includes("daily:daily_loss_limit"));
      assert.ok(res.body.data.limits.blockedBy.includes("daily"));
    } finally {
      await srv.close();
    }
  });
});

test("corrupt or invalid paper state is a 500 error state — no internals leaked", async () => {
  await withTempState("{not json", async (stateFile) => {
    const srv = await startTestServer({stateFile});
    try {
      const res = await getJson(srv.base, "/api/portfolio");
      assert.equal(res.status, 500);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.state, "error");
      assert.equal(res.body.error.code, "paper-state-error");
      assert.ok(!res.text.includes(TESTS_DIR), "no filesystem paths in error payloads");
      assert.ok(!/\bat \S+\.js:\d+/.test(res.text), "no stack traces in error payloads");
      assert.deepEqual(findSecretViolations(res.body, res.text), []);
    } finally {
      await srv.close();
    }
  });

  await withTempState({version: 1, portfolio: {cash: "definitely-not-a-number"}}, async (stateFile) => {
    const srv = await startTestServer({stateFile});
    try {
      const res = await getJson(srv.base, "/api/portfolio");
      assert.equal(res.status, 500);
      assert.equal(res.body.error.reason, "paper-state-invalid-portfolio");
    } finally {
      await srv.close();
    }
  });
});

test("/api/journal verifies the real hash chain; tampering is surfaced honestly", async () => {
  const chain = validChain();
  await withTempState({version: 1, updatedAt: 1700000000000, journal: chain}, async (stateFile) => {
    const srv = await startTestServer({stateFile});
    try {
      const res = await getJson(srv.base, "/api/journal");
      assert.equal(res.status, 200);
      const d = res.body.data;
      assert.equal(d.state, "ok");
      assert.equal(d.total, 2);
      assert.equal(d.verified, true);
      assert.equal(d.integrity, "verified");
      assert.equal(d.entries[0].entry.kind, "boot");
      assert.deepEqual(findSecretViolations(res.body, res.text), []);
    } finally {
      await srv.close();
    }
  });

  // Tamper: edit an entry without rehashing -> the chain must NOT verify.
  const tampered = validChain();
  tampered[1] = {...tampered[1], entry: {...tampered[1].entry, price: 1}};
  await withTempState({version: 1, updatedAt: 1700000000000, journal: tampered}, async (stateFile) => {
    const srv = await startTestServer({stateFile});
    try {
      const res = await getJson(srv.base, "/api/journal");
      assert.equal(res.status, 200);
      assert.equal(res.body.data.verified, false);
      assert.equal(res.body.data.integrity, "broken");
      assert.match(res.body.data.note, /untrusted/);
    } finally {
      await srv.close();
    }
  });
});

test("/api/journal is honest-empty without a state file", async () => {
  await withTempState(null, async (stateFile) => {
    const srv = await startTestServer({stateFile});
    try {
      const res = await getJson(srv.base, "/api/journal");
      assert.equal(res.status, 200);
      assert.equal(res.body.data.state, "empty");
      assert.deepEqual(res.body.data.entries, []);
      assert.equal(res.body.data.total, 0);
    } finally {
      await srv.close();
    }
  });
});
