import test from "node:test";
import assert from "node:assert/strict";
import {positionSize, riskPerTrade, maxPosition, exposureCheck} from "../src/risk/sizing.js";

// ---------------------------------------------------------------------------
// positionSize
// ---------------------------------------------------------------------------

test("positionSize sizes from the risk budget and the stop distance", () => {
  // Hand-computed: risk = 10000 * 2% = 200; stop distance = 100 - 95 = 5;
  // units = 200 / 5 = 40.
  assert.deepEqual(positionSize({accountEquity:10000, riskPerTradePct:2, entryPrice:100, stopPrice:95}),
    {ok:true, units:40, riskAmount:200, stopDistance:5, reason:null});
  // Hand-computed: risk = 25000 * 1.5% = 375; stop distance = 120 - 118 = 2;
  // units = 375 / 2 = 187.5.
  assert.deepEqual(positionSize({accountEquity:25000, riskPerTradePct:1.5, entryPrice:120, stopPrice:118}),
    {ok:true, units:187.5, riskAmount:375, stopDistance:2, reason:null});
});

test("positionSize rejects an inverted or zero-width stop", () => {
  const fail = {ok:false, units:null, riskAmount:null, stopDistance:null, reason:"invalid_stop"};
  // Stop above entry: inverted stop, risk per unit undefined.
  assert.deepEqual(positionSize({accountEquity:10000, riskPerTradePct:2, entryPrice:100, stopPrice:120}), fail);
  // Stop exactly at entry: zero-width stop would mean dividing by zero.
  assert.deepEqual(positionSize({accountEquity:10000, riskPerTradePct:2, entryPrice:100, stopPrice:100}), fail);
});

test("positionSize fails closed on zero/NaN/missing equity", () => {
  const base = {riskPerTradePct:2, entryPrice:100, stopPrice:95};
  const expect = {ok:false, units:null, riskAmount:null, stopDistance:null, reason:"invalid_account_equity"};
  assert.deepEqual(positionSize({...base, accountEquity:0}), expect);
  assert.deepEqual(positionSize({...base, accountEquity:-5}), expect);
  assert.deepEqual(positionSize({...base, accountEquity:NaN}), expect);
  assert.deepEqual(positionSize({...base, accountEquity:Infinity}), expect);
  assert.deepEqual(positionSize({...base}), expect); // missing
  assert.deepEqual(positionSize(null), expect); // whole input missing
});

test("positionSize fails closed on bad percentages and prices", () => {
  const ok = {accountEquity:10000, riskPerTradePct:2, entryPrice:100, stopPrice:95};
  const pctFail = {ok:false, units:null, riskAmount:null, stopDistance:null, reason:"invalid_risk_per_trade_pct"};
  assert.deepEqual(positionSize({...ok, riskPerTradePct:0}), pctFail);
  assert.deepEqual(positionSize({...ok, riskPerTradePct:-1}), pctFail);
  assert.deepEqual(positionSize({...ok, riskPerTradePct:101}), pctFail);
  assert.deepEqual(positionSize({...ok, riskPerTradePct:NaN}), pctFail);
  assert.deepEqual(positionSize({...ok, riskPerTradePct:undefined}), pctFail);
  const entryFail = {ok:false, units:null, riskAmount:null, stopDistance:null, reason:"invalid_entry_price"};
  assert.deepEqual(positionSize({...ok, entryPrice:0}), entryFail);
  assert.deepEqual(positionSize({...ok, entryPrice:NaN}), entryFail);
  assert.deepEqual(positionSize({...ok, entryPrice:Infinity}), entryFail);
  const stopFail = {ok:false, units:null, riskAmount:null, stopDistance:null, reason:"invalid_stop_price"};
  assert.deepEqual(positionSize({...ok, stopPrice:0}), stopFail);
  assert.deepEqual(positionSize({...ok, stopPrice:-1}), stopFail);
  assert.deepEqual(positionSize({...ok, stopPrice:NaN}), stopFail);
});

test("positionSize fails closed instead of returning Infinity", () => {
  // 1e308 * 100 overflows to Infinity before the division by 100 can scale it
  // back; the guard must return a machine-readable reason, never Infinity.
  assert.deepEqual(positionSize({accountEquity:1e308, riskPerTradePct:100, entryPrice:100, stopPrice:95}),
    {ok:false, units:null, riskAmount:null, stopDistance:null, reason:"arithmetic_overflow"});
});

test("positionSize is deterministic", () => {
  const input = {accountEquity:4321.5, riskPerTradePct:1.25, entryPrice:77.5, stopPrice:73.5};
  assert.deepEqual(positionSize(input), positionSize(input));
});

// ---------------------------------------------------------------------------
// riskPerTrade
// ---------------------------------------------------------------------------

test("riskPerTrade caps the risk amount at the absolute maximum", () => {
  // Hand-computed: uncapped = 10000 * 2% = 200; cap 150 binds => 150.
  assert.deepEqual(riskPerTrade({accountEquity:10000, riskPerTradePct:2, maxRiskPerTradeAbsolute:150}),
    {ok:true, riskAmount:150, uncappedRiskAmount:200, capped:true, reason:null});
  // Cap of 500 does not bind => 200.
  assert.deepEqual(riskPerTrade({accountEquity:10000, riskPerTradePct:2, maxRiskPerTradeAbsolute:500}),
    {ok:true, riskAmount:200, uncappedRiskAmount:200, capped:false, reason:null});
  // Cap exactly at 200: the cap is a ceiling, not a breach.
  assert.deepEqual(riskPerTrade({accountEquity:10000, riskPerTradePct:2, maxRiskPerTradeAbsolute:200}),
    {ok:true, riskAmount:200, uncappedRiskAmount:200, capped:false, reason:null});
});

test("riskPerTrade fails closed on bad inputs", () => {
  const ok = {accountEquity:10000, riskPerTradePct:2, maxRiskPerTradeAbsolute:150};
  const equityFail = {ok:false, riskAmount:null, uncappedRiskAmount:null, capped:null, reason:"invalid_account_equity"};
  assert.deepEqual(riskPerTrade({...ok, accountEquity:0}), equityFail);
  assert.deepEqual(riskPerTrade({...ok, accountEquity:NaN}), equityFail);
  assert.deepEqual(riskPerTrade({...ok, accountEquity:undefined}), equityFail);
  const pctFail = {ok:false, riskAmount:null, uncappedRiskAmount:null, capped:null, reason:"invalid_risk_per_trade_pct"};
  assert.deepEqual(riskPerTrade({...ok, riskPerTradePct:0}), pctFail);
  assert.deepEqual(riskPerTrade({...ok, riskPerTradePct:101}), pctFail);
  const capFail = {ok:false, riskAmount:null, uncappedRiskAmount:null, capped:null, reason:"invalid_max_risk_absolute"};
  assert.deepEqual(riskPerTrade({...ok, maxRiskPerTradeAbsolute:0}), capFail);
  assert.deepEqual(riskPerTrade({...ok, maxRiskPerTradeAbsolute:-100}), capFail);
  assert.deepEqual(riskPerTrade({...ok, maxRiskPerTradeAbsolute:NaN}), capFail);
  assert.deepEqual(riskPerTrade({...ok, maxRiskPerTradeAbsolute:Infinity}), capFail);
});

// ---------------------------------------------------------------------------
// maxPosition
// ---------------------------------------------------------------------------

test("maxPosition converts the notional ceiling into units", () => {
  // Hand-computed: 10000 * 25% = 2500 notional; 2500 / 50 = 50 units.
  assert.deepEqual(maxPosition({accountEquity:10000, maxPositionPct:25, price:50}),
    {ok:true, units:50, maxNotional:2500, reason:null});
  // Hand-computed: 10000 * 1% = 100 notional; 100 / 8 = 12.5 units.
  assert.deepEqual(maxPosition({accountEquity:10000, maxPositionPct:1, price:8}),
    {ok:true, units:12.5, maxNotional:100, reason:null});
});

test("maxPosition fails closed on zero price and zero equity", () => {
  const priceFail = {ok:false, units:null, maxNotional:null, reason:"invalid_price"};
  assert.deepEqual(maxPosition({accountEquity:10000, maxPositionPct:25, price:0}), priceFail);
  assert.deepEqual(maxPosition({accountEquity:10000, maxPositionPct:25, price:-3}), priceFail);
  assert.deepEqual(maxPosition({accountEquity:10000, maxPositionPct:25, price:NaN}), priceFail);
  const equityFail = {ok:false, units:null, maxNotional:null, reason:"invalid_account_equity"};
  assert.deepEqual(maxPosition({accountEquity:0, maxPositionPct:25, price:50}), equityFail);
  assert.deepEqual(maxPosition({accountEquity:NaN, maxPositionPct:25, price:50}), equityFail);
  const pctFail = {ok:false, units:null, maxNotional:null, reason:"invalid_max_position_pct"};
  assert.deepEqual(maxPosition({accountEquity:10000, maxPositionPct:0, price:50}), pctFail);
  assert.deepEqual(maxPosition({accountEquity:10000, maxPositionPct:100.5, price:50}), pctFail);
});

// ---------------------------------------------------------------------------
// exposureCheck
// ---------------------------------------------------------------------------

test("exposureCheck sums gross exposure across longs and shorts", () => {
  // Hand-computed: |10 * 50| = 500 and |-4 * 125| = 500 => gross 1000;
  // 1000 / 4000 * 100 = 25%.
  const positions = [
    {symbol:"AAA", quantity:10, markPrice:50},
    {symbol:"BBB", quantity:-4, markPrice:125}
  ];
  assert.deepEqual(exposureCheck({positions, maxExposurePct:30, accountEquity:4000}),
    {ok:true, totalExposurePct:25, breaches:[], reason:null});
});

test("exposureCheck boundary matches the gate: exactly at the cap is allowed, above is a breach", () => {
  const positions = [
    {symbol:"AAA", quantity:10, markPrice:50},
    {symbol:"BBB", quantity:-4, markPrice:125}
  ];
  // 25% total exposure against a 25% cap: gate.js MAX_GROSS_EXPOSURE blocks on
  // strict `>`, so exactly at the cap is still allowed.
  assert.deepEqual(exposureCheck({positions, maxExposurePct:25, accountEquity:4000}),
    {ok:true, totalExposurePct:25, breaches:[], reason:null});
  // 25% against a 24% cap: one point over is a breach.
  assert.deepEqual(exposureCheck({positions, maxExposurePct:24, accountEquity:4000}),
    {ok:false, totalExposurePct:25, breaches:["max_exposure"], reason:"max_exposure"});
});

test("exposureCheck treats an empty book as zero exposure", () => {
  assert.deepEqual(exposureCheck({positions:[], maxExposurePct:10, accountEquity:1000}),
    {ok:true, totalExposurePct:0, breaches:[], reason:null});
});

test("exposureCheck fails closed on malformed positions and zero equity", () => {
  const good = {symbol:"AAA", quantity:10, markPrice:50};
  const positionFail = {ok:false, totalExposurePct:null, breaches:[], reason:"invalid_position"};
  assert.deepEqual(exposureCheck({positions:[good, null], maxExposurePct:50, accountEquity:4000}), positionFail);
  assert.deepEqual(exposureCheck({positions:[{quantity:10, markPrice:50}], maxExposurePct:50, accountEquity:4000}), positionFail);
  assert.deepEqual(exposureCheck({positions:[{symbol:"AAA", quantity:NaN, markPrice:50}], maxExposurePct:50, accountEquity:4000}), positionFail);
  assert.deepEqual(exposureCheck({positions:[{symbol:"AAA", quantity:10, markPrice:0}], maxExposurePct:50, accountEquity:4000}), positionFail);
  assert.deepEqual(exposureCheck({positions:[{symbol:"AAA", quantity:10, markPrice:-5}], maxExposurePct:50, accountEquity:4000}), positionFail);
  assert.deepEqual(exposureCheck({positions:[{symbol:"AAA", quantity:10}], maxExposurePct:50, accountEquity:4000}), positionFail);
  const listFail = {ok:false, totalExposurePct:null, breaches:[], reason:"invalid_positions"};
  assert.deepEqual(exposureCheck({positions:undefined, maxExposurePct:50, accountEquity:4000}), listFail);
  assert.deepEqual(exposureCheck({positions:{}, maxExposurePct:50, accountEquity:4000}), listFail);
  const equityFail = {ok:false, totalExposurePct:null, breaches:[], reason:"invalid_account_equity"};
  assert.deepEqual(exposureCheck({positions:[good], maxExposurePct:50, accountEquity:0}), equityFail);
  assert.deepEqual(exposureCheck({positions:[good], maxExposurePct:50, accountEquity:NaN}), equityFail);
  assert.deepEqual(exposureCheck({positions:[good], maxExposurePct:50, accountEquity:undefined}), equityFail);
  const pctFail = {ok:false, totalExposurePct:null, breaches:[], reason:"invalid_max_exposure_pct"};
  assert.deepEqual(exposureCheck({positions:[good], maxExposurePct:0, accountEquity:4000}), pctFail);
  assert.deepEqual(exposureCheck({positions:[good], maxExposurePct:101, accountEquity:4000}), pctFail);
});

test("exposureCheck fails closed on notional overflow", () => {
  // 1e308 * 1e308 overflows to Infinity; the guard must block instead of
  // silently reporting a broken percentage.
  assert.deepEqual(exposureCheck({positions:[{symbol:"AAA", quantity:1e308, markPrice:1e308}], maxExposurePct:50, accountEquity:4000}),
    {ok:false, totalExposurePct:null, breaches:[], reason:"arithmetic_overflow"});
});

test("exposureCheck is deterministic", () => {
  const input = {positions:[{symbol:"AAA", quantity:3, markPrice:7}], maxExposurePct:50, accountEquity:100};
  assert.deepEqual(exposureCheck(input), exposureCheck(input));
});
