import test from "node:test";
import assert from "node:assert/strict";
import {dailyLossCheck, weeklyLossCheck, drawdownCheck, evaluateLimits} from "../src/risk/limits.js";

// ---------------------------------------------------------------------------
// dailyLossCheck
// ---------------------------------------------------------------------------

test("dailyLossCheck reports used/limit/remaining under the limit", () => {
  // Hand-computed: limit = 10000 * 2% = 200; loss of 50 uses 50, 150 left.
  assert.deepEqual(dailyLossCheck({realizedPnl:-50, startingEquity:10000, dailyLossLimitPct:2}),
    {ok:true, used:50, limit:200, remaining:150, reason:null});
  // Hand-computed: a profit of 300 consumes nothing of a loss budget.
  assert.deepEqual(dailyLossCheck({realizedPnl:300, startingEquity:10000, dailyLossLimitPct:2}),
    {ok:true, used:0, limit:200, remaining:200, reason:null});
});

test("dailyLossCheck boundary: a limit reached exactly is a breach", () => {
  // Matches gate.js MAX_DAILY_LOSS, which blocks when dailyPnl <= -maxDailyLoss.
  // Hand-computed: loss of exactly 200 against a 200 limit => blocked.
  assert.deepEqual(dailyLossCheck({realizedPnl:-200, startingEquity:10000, dailyLossLimitPct:2}),
    {ok:false, used:200, limit:200, remaining:0, reason:"daily_loss_limit"});
});

test("dailyLossCheck blocks one cent beyond the limit", () => {
  // Hand-computed: loss of 200.01 against a 200 limit => blocked, remaining
  // is negative by one cent (float dust tolerated via bounded comparison).
  const result = dailyLossCheck({realizedPnl:-200.01, startingEquity:10000, dailyLossLimitPct:2});
  assert.equal(result.ok, false);
  assert.equal(result.reason, "daily_loss_limit");
  assert.equal(result.used, 200.01);
  assert.equal(result.limit, 200);
  assert.ok(result.remaining < 0);
  assert.ok(Math.abs(result.remaining + 0.01) < 1e-9);
});

test("dailyLossCheck allows one cent below the limit", () => {
  const result = dailyLossCheck({realizedPnl:-199.99, startingEquity:10000, dailyLossLimitPct:2});
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.ok(result.remaining > 0);
  assert.ok(Math.abs(result.remaining - 0.01) < 1e-9);
});

test("dailyLossCheck fails closed on missing/NaN/zero inputs", () => {
  const bad = (reason) => ({ok:false, used:null, limit:null, remaining:null, reason});
  assert.deepEqual(dailyLossCheck({startingEquity:10000, dailyLossLimitPct:2}), bad("invalid_realized_pnl"));
  assert.deepEqual(dailyLossCheck({realizedPnl:NaN, startingEquity:10000, dailyLossLimitPct:2}), bad("invalid_realized_pnl"));
  assert.deepEqual(dailyLossCheck({realizedPnl:"x", startingEquity:10000, dailyLossLimitPct:2}), bad("invalid_realized_pnl"));
  // Zero equity would make the percentage base a zero divisor.
  assert.deepEqual(dailyLossCheck({realizedPnl:-50, startingEquity:0, dailyLossLimitPct:2}), bad("invalid_starting_equity"));
  assert.deepEqual(dailyLossCheck({realizedPnl:-50, startingEquity:-1, dailyLossLimitPct:2}), bad("invalid_starting_equity"));
  assert.deepEqual(dailyLossCheck({realizedPnl:-50, startingEquity:NaN, dailyLossLimitPct:2}), bad("invalid_starting_equity"));
  assert.deepEqual(dailyLossCheck({realizedPnl:-50, startingEquity:10000, dailyLossLimitPct:0}), bad("invalid_daily_loss_limit_pct"));
  assert.deepEqual(dailyLossCheck({realizedPnl:-50, startingEquity:10000, dailyLossLimitPct:101}), bad("invalid_daily_loss_limit_pct"));
  assert.deepEqual(dailyLossCheck({realizedPnl:-50, startingEquity:10000, dailyLossLimitPct:undefined}), bad("invalid_daily_loss_limit_pct"));
  assert.deepEqual(dailyLossCheck(undefined), bad("invalid_realized_pnl"));
  assert.deepEqual(dailyLossCheck(null), bad("invalid_realized_pnl"));
});

// ---------------------------------------------------------------------------
// weeklyLossCheck
// ---------------------------------------------------------------------------

test("weeklyLossCheck computes the weekly budget independently", () => {
  // Hand-computed: limit = 10000 * 5% = 500; 125.5 used => 374.5 remaining.
  assert.deepEqual(weeklyLossCheck({realizedPnl:-125.5, startingEquity:10000, weeklyLossLimitPct:5}),
    {ok:true, used:125.5, limit:500, remaining:374.5, reason:null});
  // Hand-computed: a weekly loss of exactly 500 is a breach.
  assert.deepEqual(weeklyLossCheck({realizedPnl:-500, startingEquity:10000, weeklyLossLimitPct:5}),
    {ok:false, used:500, limit:500, remaining:0, reason:"weekly_loss_limit"});
  // One cent beyond the weekly limit blocks.
  const result = weeklyLossCheck({realizedPnl:-500.01, startingEquity:10000, weeklyLossLimitPct:5});
  assert.equal(result.ok, false);
  assert.equal(result.reason, "weekly_loss_limit");
  assert.ok(result.remaining < 0);
});

test("weeklyLossCheck fails closed on missing/NaN/zero inputs", () => {
  const bad = (reason) => ({ok:false, used:null, limit:null, remaining:null, reason});
  assert.deepEqual(weeklyLossCheck({startingEquity:10000, weeklyLossLimitPct:5}), bad("invalid_realized_pnl"));
  assert.deepEqual(weeklyLossCheck({realizedPnl:-50, startingEquity:0, weeklyLossLimitPct:5}), bad("invalid_starting_equity"));
  assert.deepEqual(weeklyLossCheck({realizedPnl:-50, startingEquity:10000, weeklyLossLimitPct:NaN}), bad("invalid_weekly_loss_limit_pct"));
  assert.deepEqual(weeklyLossCheck({realizedPnl:-50, startingEquity:10000}), bad("invalid_weekly_loss_limit_pct"));
});

// ---------------------------------------------------------------------------
// drawdownCheck
// ---------------------------------------------------------------------------

test("drawdownCheck computes drawdown as a percentage of the peak", () => {
  // Hand-computed: (1000 - 750) / 1000 = 25% drawdown against a 20% limit.
  assert.deepEqual(drawdownCheck({peakEquity:1000, currentEquity:750, maxDrawdownPct:20}),
    {ok:false, drawdownPct:25, limitPct:20, remaining:-5, reason:"max_drawdown"});
  // Hand-computed: (1000 - 850) / 1000 = 15% drawdown, 5 points of headroom.
  assert.deepEqual(drawdownCheck({peakEquity:1000, currentEquity:850, maxDrawdownPct:20}),
    {ok:true, drawdownPct:15, limitPct:20, remaining:5, reason:null});
  // Hand-computed: total loss, (1000 - 0) / 1000 = 100% drawdown.
  assert.deepEqual(drawdownCheck({peakEquity:1000, currentEquity:0, maxDrawdownPct:20}),
    {ok:false, drawdownPct:100, limitPct:20, remaining:-80, reason:"max_drawdown"});
});

test("drawdownCheck boundary: a drawdown at the limit exactly is a breach", () => {
  // Matches gate.js MAX_DRAWDOWN, which blocks when drawdown >= maxDrawdown.
  // Hand-computed: (1000 - 800) / 1000 = 20% against a 20% limit => blocked.
  assert.deepEqual(drawdownCheck({peakEquity:1000, currentEquity:800, maxDrawdownPct:20}),
    {ok:false, drawdownPct:20, limitPct:20, remaining:0, reason:"max_drawdown"});
});

test("drawdownCheck clamps a new equity high to zero drawdown", () => {
  // Hand-computed: current above peak is a gain, not drawdown; clamping at 0
  // never inflates `remaining` beyond the configured limit.
  assert.deepEqual(drawdownCheck({peakEquity:1000, currentEquity:1100, maxDrawdownPct:20}),
    {ok:true, drawdownPct:0, limitPct:20, remaining:20, reason:null});
});

test("drawdownCheck fails closed on missing/NaN/zero inputs", () => {
  const bad = (reason) => ({ok:false, drawdownPct:null, limitPct:null, remaining:null, reason});
  // Zero peak equity would make the percentage base a zero divisor.
  assert.deepEqual(drawdownCheck({peakEquity:0, currentEquity:800, maxDrawdownPct:20}), bad("invalid_peak_equity"));
  assert.deepEqual(drawdownCheck({peakEquity:NaN, currentEquity:800, maxDrawdownPct:20}), bad("invalid_peak_equity"));
  assert.deepEqual(drawdownCheck({currentEquity:800, maxDrawdownPct:20}), bad("invalid_peak_equity"));
  assert.deepEqual(drawdownCheck({peakEquity:1000, currentEquity:-1, maxDrawdownPct:20}), bad("invalid_current_equity"));
  assert.deepEqual(drawdownCheck({peakEquity:1000, currentEquity:NaN, maxDrawdownPct:20}), bad("invalid_current_equity"));
  assert.deepEqual(drawdownCheck({peakEquity:1000, maxDrawdownPct:20}), bad("invalid_current_equity"));
  assert.deepEqual(drawdownCheck({peakEquity:1000, currentEquity:800, maxDrawdownPct:0}), bad("invalid_max_drawdown_pct"));
  assert.deepEqual(drawdownCheck({peakEquity:1000, currentEquity:800, maxDrawdownPct:101}), bad("invalid_max_drawdown_pct"));
  assert.deepEqual(drawdownCheck(null), bad("invalid_peak_equity"));
});

// ---------------------------------------------------------------------------
// evaluateLimits
// ---------------------------------------------------------------------------

function safeState() {
  return {
    daily:{realizedPnl:-50, startingEquity:10000, dailyLossLimitPct:2},
    weekly:{realizedPnl:-50, startingEquity:10000, weeklyLossLimitPct:5},
    drawdown:{peakEquity:10000, currentEquity:9500, maxDrawdownPct:20}
  };
}

test("evaluateLimits allows only when every limit proves safe", () => {
  // Hand-computed: daily used 50 < 200, weekly used 50 < 500,
  // drawdown (10000-9500)/10000 = 5% < 20% => all clear.
  assert.deepEqual(evaluateLimits(safeState()), {ok:true, blockedBy:[], reasons:[]});
});

test("evaluateLimits blocks each breached limit with a machine-readable reason", () => {
  const daily = safeState();
  daily.daily.realizedPnl = -200.01; // one cent past the 200 limit
  assert.deepEqual(evaluateLimits(daily), {ok:false, blockedBy:["daily"], reasons:["daily:daily_loss_limit"]});

  const weekly = safeState();
  weekly.weekly.realizedPnl = -500; // exactly at the 500 limit is a breach
  assert.deepEqual(evaluateLimits(weekly), {ok:false, blockedBy:["weekly"], reasons:["weekly:weekly_loss_limit"]});

  const dd = safeState();
  dd.drawdown.currentEquity = 7900; // (10000-7900)/10000 = 21% > 20%
  assert.deepEqual(evaluateLimits(dd), {ok:false, blockedBy:["drawdown"], reasons:["drawdown:max_drawdown"]});
});

test("evaluateLimits aggregates every breach in stable order", () => {
  const state = safeState();
  state.daily.realizedPnl = -300;    // 300 used vs 200 limit
  state.weekly.realizedPnl = -600;   // 600 used vs 500 limit
  state.drawdown.currentEquity = 7900;
  assert.deepEqual(evaluateLimits(state),
    {ok:false, blockedBy:["daily", "weekly", "drawdown"],
      reasons:["daily:daily_loss_limit", "weekly:weekly_loss_limit", "drawdown:max_drawdown"]});
});

test("evaluateLimits treats unknown or missing state as blocked, never as fine", () => {
  const missingWeekly = safeState();
  delete missingWeekly.weekly;
  assert.deepEqual(evaluateLimits(missingWeekly),
    {ok:false, blockedBy:["weekly"], reasons:["weekly:missing_state"]});

  assert.deepEqual(evaluateLimits(undefined),
    {ok:false, blockedBy:["daily", "weekly", "drawdown"],
      reasons:["daily:missing_state", "weekly:missing_state", "drawdown:missing_state"]});

  const malformed = safeState();
  malformed.drawdown.maxDrawdownPct = undefined;
  assert.deepEqual(evaluateLimits(malformed),
    {ok:false, blockedBy:["drawdown"], reasons:["drawdown:invalid_max_drawdown_pct"]});

  const nanInput = safeState();
  nanInput.daily.realizedPnl = NaN;
  assert.deepEqual(evaluateLimits(nanInput),
    {ok:false, blockedBy:["daily"], reasons:["daily:invalid_realized_pnl"]});
});

test("evaluateLimits is deterministic", () => {
  const state = safeState();
  assert.deepEqual(evaluateLimits(state), evaluateLimits(state));
  assert.deepEqual(evaluateLimits(state), {ok:true, blockedBy:[], reasons:[]});
});
