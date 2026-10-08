// server/strategies.js — deterministic backtest strategies for the read-only API.
//
// Backtesting uses the real engine (src/backtest/engine-v2.js). The strategy
// itself must be a pure function of candles seen so far — same input, same
// output, no clocks, no randomness, no look-ahead (it only ever sees candles
// the engine has already passed it).
//
// PAPER/SHADOW ONLY. These strategies exist to summarise history honestly.
// They are not advice, not a prediction, and cannot place a real order.

import {sma} from "../src/indicators/trend.js";

// Classic moving-average cross: go fully invested when the short SMA crosses
// above the long SMA, flat when it crosses below. Position is sized at 95% of
// available cash (the engine refuses any order cash cannot cover).
function makeSmaCross(shortPeriod = 10, longPeriod = 30) {
  const closes = [];
  let prevShort = null;
  let prevLong = null;
  return function smaCross(candle, {cash, position} = {}) {
    if (!candle || !Number.isFinite(candle.close)) return null;
    closes.push(candle.close);
    if (closes.length < longPeriod + 1) return null;
    const shortSeries = sma(closes, shortPeriod);
    const longSeries = sma(closes, longPeriod);
    const short = shortSeries[closes.length - 1];
    const long = longSeries[closes.length - 1];
    const signal = prevShort !== null && prevLong !== null
      ? (prevShort <= prevLong && short > long ? "golden" : prevShort >= prevLong && short < long ? "death" : null)
      : null;
    prevShort = short;
    prevLong = long;
    if (signal === "golden" && position === 0 && cash > 0) {
      const quantity = (cash * 0.95) / candle.close;
      return quantity > 0 ? {side: "BUY", quantity} : null;
    }
    if (signal === "death" && position > 0) return {side: "SELL", quantity: position};
    return null;
  };
}

function makeMomentum(period = 14) {
  const closes = [];
  return function momentumStrat(candle, {cash, position} = {}) {
    if (!candle || !Number.isFinite(candle.close)) return null;
    closes.push(candle.close);
    if (closes.length < period + 1) return null;
    const prev = closes[closes.length - 1 - period];
    const changePct = ((candle.close - prev) / prev) * 100;
    if (changePct > 3 && position === 0 && cash > 0) {
      const quantity = Math.floor((cash * 0.95) / candle.close);
      return quantity > 0 ? {side: "BUY", quantity} : null;
    }
    if (changePct < -2 && position > 0) {
      return {side: "SELL", quantity: position};
    }
    return null;
  };
}

function makeFamousTurtle(period = 20) {
  const closes = [];
  return function turtleStrat(candle, {cash, position} = {}) {
    if (!candle || !Number.isFinite(candle.close)) return null;
    closes.push(candle.close);
    if (closes.length < period + 1) return null;
    const window = closes.slice(closes.length - 1 - period, closes.length - 1);
    const high20 = Math.max(...window);
    const low10 = Math.min(...window.slice(period - 10));
    if (candle.close > high20 && position === 0 && cash > 0) {
      const quantity = Math.floor((cash * 0.95) / candle.close);
      return quantity > 0 ? {side: "BUY", quantity} : null;
    }
    if (candle.close < low10 && position > 0) {
      return {side: "SELL", quantity: position};
    }
    return null;
  };
}

// Each call must return a FRESH strategy instance: the factory keeps rolling
// state, and a reused instance would leak state across backtest runs.
export function createStrategy(name) {
  switch (name) {
    case "sma-cross":
      return makeSmaCross(10, 30);
    case "momentum":
      return makeMomentum(14);
    case "famous-turtle":
      return makeFamousTurtle(20);
    default:
      return null;
  }
}

export const STRATEGY_DESCRIPTIONS = Object.freeze({
  "sma-cross": "SMA(10/30) cross: fully invested on golden cross, flat on death cross (95% of cash per entry).",
  "momentum": "14-candle rate-of-change momentum strategy: buy on >3% surge, exit on <-2% drop.",
  "famous-turtle": "Famous Turtle Trader 20-candle Donchian breakout methodology (documented public strategy)."
});
