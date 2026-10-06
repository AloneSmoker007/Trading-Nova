import test from "node:test";
import assert from "node:assert/strict";
import {
  stdDev,
  bollingerWidth,
  volatilityRegime,
  historicalVolatility,
  keltner,
  donchian
} from "../src/indicators/volatility.js";

// Float helper for values derived from square roots etc. (expected values are still
// hand-computed closed forms written out in the comments).
const near = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ~${expected}, got ${actual}`);

// Synthetic candles: close = c, high = c+1, low = c-1 => typical price = c and
// true range = max(2, |c+1-prevClose|, |c-1-prevClose|) = 2 for consecutive closes.
const candleSet = closes => closes.map(c => ({ open: c, high: c + 1, low: c - 1, close: c, volume: 1 }));

test("stdDev is the sample standard deviation of the trailing window", () => {
  // [1,2,3]: mean 2, sum squared devs 2, /(3-1) = 1, sqrt(1) = 1
  assert.equal(stdDev([1, 2, 3], 3), 1);
  // trailing window only: [2,3,4] -> mean 3, devs -1,0,1 -> also 1
  assert.equal(stdDev([1, 2, 3, 4], 3), 1);
  // older values outside the window must not matter
  assert.equal(stdDev([100, 1, 2, 3], 3), 1);
});

test("stdDev fails safe on empty, short, and invalid input", () => {
  assert.equal(stdDev([], 20), null);
  assert.equal(stdDev([1, 2, 3], 20), null); // period > values.length -> undefined
  assert.equal(stdDev([5], 1), null); // period < 2 -> sample std undefined
  assert.equal(stdDev(null), null);
  assert.equal(stdDev("nope", 2), null);
});

test("stdDev drops non-finite entries before computing", () => {
  // cleaned = [1,2,3] -> stdDev 1 as above
  assert.equal(stdDev([1, NaN, 2, null, 3], 3), 1);
});

test("bollingerWidth is the normalized bandwidth (upper-lower)/middle", () => {
  // [1,2,3]: mean 2, std 1 -> 2 * mult 2 * 1 / 2 = 2
  assert.equal(bollingerWidth([1, 2, 3], 3, 2), 2);
  // [2,4,6,8,10]: mean 6, sum squared devs 40, /4 = 10, std = sqrt(10)
  // width = 2 * 2 * sqrt(10) / 6 = 2*sqrt(10)/3
  near(bollingerWidth([2, 4, 6, 8, 10], 5, 2), (2 * Math.sqrt(10)) / 3);
});

test("bollingerWidth edge cases: zero width, zero middle, short input", () => {
  assert.equal(bollingerWidth([2, 2, 2], 3, 2), 0); // zero volatility -> zero width (defined)
  assert.equal(bollingerWidth([0, 0, 0], 3, 2), null); // middle 0 -> zero division -> null
  assert.equal(bollingerWidth([], 3), null);
  assert.equal(bollingerWidth([1, 2, 3], 5), null); // period > values.length
});

test("historicalVolatility annualizes the trailing return volatility", () => {
  // [8,12,6,9] -> simple returns [0.5,-0.5,0.5] exactly.
  // sample std = sqrt((2/3)/2) = 1/sqrt(3); HV = (1/sqrt(3))*sqrt(252) = sqrt(84)
  near(historicalVolatility([8, 12, 6, 9], 3, 252), Math.sqrt(84));
  // same series with periodsPerYear 4 -> (1/sqrt(3))*2 = sqrt(4/3)
  near(historicalVolatility([8, 12, 6, 9], 3, 4), Math.sqrt(4 / 3));
});

test("historicalVolatility handles zero bases and fails safe on short input", () => {
  // [0,4,2,3]: zero base => 0 return (statistics.js convention), then [-0.5, 0.5].
  // returns [0,-0.5,0.5]: mean 0, sum squared devs 0.5, /2 = 0.25, std 0.5, *sqrt(4) = 1
  assert.equal(historicalVolatility([0, 4, 2, 3], 3, 4), 1);
  assert.equal(historicalVolatility([8, 12], 3, 252), null); // needs period+1 values
  assert.equal(historicalVolatility([8, 12, 6, 9], 3, 0), null); // periodsPerYear must be > 0
  assert.equal(historicalVolatility([], 3, 252), null);
});

test("keltner uses typical price and true range", () => {
  const C = candleSet([10, 11, 12, 13, 14]);
  // trailing 3 typical prices [12,13,14]: middle 13. Every true range is 2 => ATR 2.
  // upper 13 + 2*2 = 17, lower 13 - 2*2 = 9
  assert.deepEqual(keltner(C, 3, 2), { upper: 17, middle: 13, lower: 9 });
  // mult 0 collapses the channel onto the middle line
  assert.deepEqual(keltner(C, 3, 0), { upper: 13, middle: 13, lower: 13 });
});

test("keltner fails safe on empty, short, and invalid candles", () => {
  const C = candleSet([10, 11, 12, 13, 14]);
  assert.equal(keltner([], 3), null);
  assert.equal(keltner(C, 10), null); // fewer than `period` candles
  assert.equal(keltner([{ high: NaN, low: 1, close: 1 }], 1), null); // invalid candle dropped
  assert.equal(keltner(null, 3), null);
});

test("donchian spans the trailing high/low range", () => {
  const C = candleSet([10, 11, 12, 13, 14]); // highs [11..15], lows [9..13]
  // trailing 3: highs [13,14,15] -> 15, lows [11,12,13] -> 11
  assert.deepEqual(donchian(C, 3), { upper: 15, lower: 11 });
  assert.deepEqual(donchian(C, 1), { upper: 15, lower: 13 });
});

test("donchian fails safe on empty, short, and invalid candles", () => {
  const C = candleSet([10, 11, 12, 13, 14]);
  assert.equal(donchian([], 3), null);
  assert.equal(donchian(C, 10), null);
  assert.equal(donchian([{ high: 1, low: NaN, close: 1 }], 1), null);
});

test("volatilityRegime flags high recent volatility", () => {
  // 12 values -> returns [0 x8, 0.2, -1/3, 0.25]. lookback 3:
  // recent std ~0.323 vs full-sample std ~0.146, ratio ~2.22 >= 1.5 -> "high"
  const v = [100, 100, 100, 100, 100, 100, 100, 100, 100, 120, 80, 100];
  assert.equal(volatilityRegime(v, 3), "high");
});

test("volatilityRegime flags low recent volatility and flat series", () => {
  // last 4 returns are exactly 0 => ratio 0 <= 0.5 -> "low"
  assert.equal(volatilityRegime([100, 130, 70, 120, 80, 120, 120, 120, 120, 120], 4), "low");
  // perfectly flat series: zero volatility everywhere -> "low"
  assert.equal(volatilityRegime([5, 5, 5, 5, 5], 3), "low");
});

test("volatilityRegime is normal when recent equals history or data is short", () => {
  // lookback covers every return: recent std === base std => ratio exactly 1 -> "normal"
  assert.equal(volatilityRegime([100, 110, 120, 130], 20), "normal");
  // insufficient data (or a 1-return lookback) -> neutral "normal", never throws
  assert.equal(volatilityRegime([100], 20), "normal");
  assert.equal(volatilityRegime([], 5), "normal");
  assert.equal(volatilityRegime([100, 110, 120], 1), "normal");
  assert.equal(volatilityRegime(null, 5), "normal");
});

test("volatility module is pure: identical input => identical output", () => {
  const v = [1, 2, 3, 4, 5];
  assert.equal(stdDev(v, 3), stdDev(v, 3));
  assert.equal(volatilityRegime(v, 2), volatilityRegime(v, 2));
  assert.equal(historicalVolatility(v, 3, 252), historicalVolatility(v, 3, 252));
});
