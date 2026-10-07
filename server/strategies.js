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
      const quantity = Math.floor((cash * 0.95) / candle.close);
      return quantity > 0 ? {side: "BUY", quantity} : null;
    }
    if (signal === "death" && position > 0) return {side: "SELL", quantity: position};
    return null;
  };
}

// Each call must return a FRESH strategy instance: the factory keeps rolling
// state, and a reused instance would leak state across backtest runs.
export function createStrategy(name) {
  switch (name) {
    case "sma-cross":
      return makeSmaCross(10, 30);
    default:
      return null;
  }
}

export const STRATEGY_DESCRIPTIONS = Object.freeze({
  "sma-cross": "SMA(10/30) cross: fully invested on golden cross, flat on death cross (95% of cash per entry)."
});
