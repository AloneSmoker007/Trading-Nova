import test from "node:test";
import assert from "node:assert/strict";
import {createNovaServer, matchApi} from "../server/app.js";

test("Phase 8: release gate keeps execution paper-only", () => {
  for (const mode of ["shadow", "limited-live", "live"]) {
    assert.throws(() => createNovaServer({tradingMode: mode}), /paper-only/);
  }
  assert.doesNotThrow(() => createNovaServer({tradingMode: "paper"}));
});

test("Phase 8: public API surface is explicitly bounded", () => {
  assert.ok(matchApi("/api/health"));
  assert.ok(matchApi("/api/market/BTCUSDT"));
  assert.ok(matchApi("/api/indicators/BTCUSDT"));
  assert.ok(matchApi("/api/portfolio"));
  assert.ok(matchApi("/api/journal"));
  assert.ok(matchApi("/api/backtest"));
  assert.ok(matchApi("/api/paper/orders"));
  assert.equal(matchApi("/api/admin"), null);
  assert.equal(matchApi("/api/live/orders"), null);
  assert.equal(matchApi("/api/unknown"), null);
});

test("Phase 8: release-critical security controls remain present", async () => {
  const {SECURITY_HEADERS} = await import("../server/app.js");
  assert.equal(SECURITY_HEADERS["X-Content-Type-Options"], "nosniff");
  assert.equal(SECURITY_HEADERS["X-Frame-Options"], "DENY");
  assert.equal(SECURITY_HEADERS["Referrer-Policy"], "no-referrer");
  assert.equal(SECURITY_HEADERS["Cross-Origin-Opener-Policy"], "same-origin");
  assert.match(SECURITY_HEADERS["Content-Security-Policy"], /default-src 'none'/);
});
