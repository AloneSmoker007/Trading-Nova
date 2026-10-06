import test from "node:test";
import assert from "node:assert/strict";
import {
  expectancy,
  rMultiples,
  profitFactor,
  winRate,
  averageWinLoss,
  sortino,
  calmar,
  recoveryFactor,
  maxDrawdownSeries,
  maxDrawdown,
  sharpe
} from "../src/backtest/metrics.js";

// Float helper for values derived from square roots etc. (expected values are still
// hand-computed closed forms written out in the comments).
const near = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ~${expected}, got ${actual}`);

test("rMultiples divides pnl by initial risk", () => {
  // 100/50 = 2, -25/50 = -0.5, 0/10 = 0
  assert.deepEqual(rMultiples([{ pnl: 100, risk: 50 }, { pnl: -25, risk: 50 }, { pnl: 0, risk: 10 }]), [2, -0.5, 0]);
});

test("rMultiples excludes trades without a positive finite risk", () => {
  // risk 0 and risk -5 cannot form an R; NaN pnl is not a trade result -> only [5/5]
  assert.deepEqual(rMultiples([{ pnl: 10, risk: 0 }, { pnl: 10, risk: -5 }, { pnl: NaN, risk: 5 }, { pnl: 5, risk: 5 }]), [1]);
  assert.deepEqual(rMultiples([]), []);
  assert.deepEqual(rMultiples(null), []);
});

test("expectancy is the mean R-multiple per trade", () => {
  // mean([2, -0.5, 0]) = 1.5/3 = 0.5
  const t = [{ pnl: 100, risk: 50 }, { pnl: -25, risk: 50 }, { pnl: 0, risk: 10 }];
  assert.equal(expectancy(t), 0.5);
  // no usable risk anywhere -> expectancy undefined (null), not 0
  assert.equal(expectancy([]), null);
  assert.equal(expectancy([{ pnl: 5 }]), null);
});

test("profitFactor is gross profit over gross loss", () => {
  // (100+30) / 50 = 130/50 = 2.6
  assert.equal(profitFactor([{ pnl: 100 }, { pnl: -50 }, { pnl: 30 }]), 2.6);
  // non-finite pnl dropped: 10/5 = 2
  assert.equal(profitFactor([{ pnl: NaN }, { pnl: 10 }, { pnl: -5 }]), 2);
});

test("profitFactor edge cases: all losses, all wins, flat, empty", () => {
  assert.equal(profitFactor([{ pnl: -10 }, { pnl: -30 }]), 0); // 0/40 = 0 (defined)
  assert.equal(profitFactor([{ pnl: 10 }, { pnl: 20 }]), null); // zero gross loss -> null, not Infinity
  assert.equal(profitFactor([{ pnl: 0 }]), null); // 0/0 -> null
  assert.equal(profitFactor([]), null);
});

test("winRate counts pnl > 0 over trades with a result", () => {
  // 2 wins out of 4 (the pnl 0 trade is not a win) = 0.5
  assert.equal(winRate([{ pnl: 100 }, { pnl: -50 }, { pnl: 30 }, { pnl: 0 }]), 0.5);
  assert.equal(winRate([{ pnl: -1 }, { pnl: -2 }]), 0); // all losses -> 0 (defined)
  assert.equal(winRate([]), null); // no trades -> unknown, not 0
});

test("averageWinLoss averages R-multiples per side", () => {
  // winners R [2, 1] -> 1.5 ; loser R [-0.5] -> -0.5 (signed)
  const t = [{ pnl: 100, risk: 50 }, { pnl: -25, risk: 50 }, { pnl: 30, risk: 30 }];
  assert.deepEqual(averageWinLoss(t), { averageWin: 1.5, averageLoss: -0.5 });
  // missing side and flat trades -> that field is null (average of nothing is undefined)
  assert.deepEqual(averageWinLoss([{ pnl: 10, risk: 10 }]), { averageWin: 1, averageLoss: null });
  assert.deepEqual(averageWinLoss([{ pnl: 0, risk: 10 }, { pnl: 10, risk: 10 }]), { averageWin: 1, averageLoss: null });
  assert.deepEqual(averageWinLoss([]), { averageWin: null, averageLoss: null });
});

test("sortino divides mean excess return by downside deviation", () => {
  // returns [0.10, -0.05, 0.02], MAR 0: mean = 0.07/3, only -0.05 is below the MAR,
  // DD = sqrt(0.05^2 / 3) = 0.05/sqrt(3) => ratio = (0.07/3) / (0.05/sqrt(3)) = 7*sqrt(3)/15
  near(sortino([0.1, -0.05, 0.02]), (7 / 15) * Math.sqrt(3));
  // non-finite returns dropped: [0.1, -0.2] -> mean -0.05, DD = sqrt(0.2^2 / 2) = sqrt(0.02)
  // ratio = -0.05/sqrt(0.02) = -sqrt(2)/4
  near(sortino([NaN, 0.1, -0.2]), -Math.SQRT2 / 4);
});

test("sortino respects the minimum acceptable return", () => {
  // returns [-0.02, 0.03], MAR -0.01: excess [-0.01, 0.04] -> mean 0.015,
  // DD = sqrt(0.01^2 / 2) = 0.01/sqrt(2) => ratio = 0.015*sqrt(2)/0.01 = 1.5*sqrt(2)
  near(sortino([-0.02, 0.03], -0.01), 1.5 * Math.sqrt(2));
});

test("sortino returns null when there is no downside", () => {
  assert.equal(sortino([0.1, 0.2]), null); // no negative excess -> null, never Infinity
  assert.equal(sortino([0.05], 0.05), null); // excess exactly at the MAR -> no downside
  assert.equal(sortino([], 0), null);
  assert.equal(sortino(null), null);
});

test("sharpe divides mean excess return by excess volatility", () => {
  // [0.02, -0.02]: mean 0, sample std = 0.02*sqrt(2) > 0 -> ratio 0
  assert.equal(sharpe([0.02, -0.02]), 0);
  // [0.03, -0.01]: mean 0.01, sample std = 0.02*sqrt(2) -> 0.01/(0.02*sqrt(2)) = sqrt(2)/4
  near(sharpe([0.03, -0.01]), Math.SQRT2 / 4);
  // risk-free rate shifts both observations to +/- 0.125 => mean 0 => 0
  assert.equal(sharpe([0.5, 0.25], 0.375), 0);
});

test("sharpe fails safe on short samples and zero volatility", () => {
  assert.equal(sharpe([0.05]), null); // sample std needs >= 2 returns
  assert.equal(sharpe([]), null);
  assert.equal(sharpe([0, 0, 0]), null); // zero volatility -> null, not Infinity
  assert.equal(sharpe([0, 0, 0], 0.01), null);
});

test("maxDrawdownSeries tracks the running peak and never exceeds 0", () => {
  // peaks 100,100,100,100,100: 50/100-1 = -0.5, 75/100-1 = -0.25, 25/100-1 = -0.75
  assert.deepEqual(maxDrawdownSeries([100, 100, 50, 75, 25]), [0, 0, -0.5, -0.25, -0.75]);
  // peak rises first: 50/200-1 = -0.75 (not vs the first value)
  assert.deepEqual(maxDrawdownSeries([100, 200, 50]), [0, 0, -0.75]);
});

test("maxDrawdownSeries keeps input length and ignores non-finite slots", () => {
  // NaN slot: no signal (drawdown 0) and it does not move the running peak -> 50/100-1 = -0.5
  assert.deepEqual(maxDrawdownSeries([100, NaN, 50]), [0, 0, -0.5]);
  // peak <= 0: the ratio is undefined -> 0
  assert.deepEqual(maxDrawdownSeries([-10, -20]), [0, 0]);
  assert.deepEqual(maxDrawdownSeries([]), []);
  assert.deepEqual(maxDrawdownSeries(null), []);
});

test("maxDrawdown reports the worst point as a scalar", () => {
  assert.equal(maxDrawdown([100, 100, 50, 75, 25]), -0.75);
  assert.equal(maxDrawdown([1, 2, 3]), 0); // rising equity -> no observed drawdown
  assert.equal(maxDrawdown([]), 0);
});

test("calmar divides CAGR by the max drawdown of the compounded curve", () => {
  // returns [0.25, -0.25, 0.25]: curve 1 -> 1.25 -> 0.9375 -> 1.171875 (exact binary values),
  // max drawdown = 0.9375/1.25 - 1 = -0.25, CAGR = 1.171875^(252/3) - 1 = 1.171875^84 - 1
  near(calmar([0.25, -0.25, 0.25], 252), (1.171875 ** 84 - 1) / 0.25);
  // two-return case: curve 1 -> 1.25 -> 0.9375, drawdown -0.25, CAGR = 0.9375^126 - 1
  near(calmar([0.25, -0.25], 252), (0.9375 ** 126 - 1) / 0.25);
});

test("calmar fails safe on bad input, wiped-out equity, and no drawdown", () => {
  assert.equal(calmar([0.1, 0.1], 252), null); // never dips -> ratio would be Infinity -> null
  assert.equal(calmar([], 252), null);
  assert.equal(calmar([0.25, -0.25], 0), null); // cannot annualize
  assert.equal(calmar([-1.5]), null); // growth factor -0.5 -> CAGR undefined
});

test("recoveryFactor is net pnl over the max absolute drawdown", () => {
  // cumulative 50, 30, 60: peak dips 20 below 50 -> 60/20 = 3
  assert.equal(recoveryFactor([{ pnl: 50 }, { pnl: -20 }, { pnl: 30 }]), 3);
  // losing system: cumulative -10, -40 vs peak 0 -> drawdown 40 -> -40/40 = -1
  assert.equal(recoveryFactor([{ pnl: -10 }, { pnl: -30 }]), -1);
});

test("recoveryFactor fails safe on empty input and no drawdown", () => {
  assert.equal(recoveryFactor([]), null);
  assert.equal(recoveryFactor([{ pnl: 10 }, { pnl: 20 }]), null); // monotonic climb -> null, not Infinity
});

test("metrics module is pure: identical input => identical output", () => {
  const t = [{ pnl: 100, risk: 50 }, { pnl: -25, risk: 50 }];
  assert.equal(profitFactor(t), profitFactor(t));
  assert.equal(expectancy(t), expectancy(t));
  assert.deepEqual(rMultiples(t), rMultiples(t));
});
