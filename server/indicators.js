// server/indicators.js — compute the indicator panel from real engine modules.
//
// All numbers come from src/indicators/* (pure, deterministic, fail-closed).
// Warm-up windows and unusable inputs produce `null` here — never a guess,
// never NaN/Infinity in the JSON (JSON.stringify would silently turn NaN into
// null, so every value is normalised explicitly first).

import {sma, ema, vwap, macd, bollinger, supportResistance} from "../src/indicators/trend.js";
import {rsi, stochastic, atr, adx, obv} from "../src/indicators/momentum.js";
import {volatilityRegime, historicalVolatility, keltner, donchian} from "../src/indicators/volatility.js";
import {marketStructure, breakout, trendDirection} from "../src/indicators/structure.js";

// Finite numbers pass through; everything else (null/undefined/NaN/±Infinity)
// becomes null so the JSON stays honest and strictly valid.
const num = (v) => (Number.isFinite(v) ? v : null);
const last = (arr) => (Array.isArray(arr) && arr.length ? num(arr[arr.length - 1]) : null);

function lastOf(obj, key) {
  return obj && Array.isArray(obj[key]) ? last(obj[key]) : null;
}

// Compute a fixed, documented indicator set over normalised candles
// ({open, high, low, close, volume, …} — see src/market-data/schema.js).
// Returns a JSON-safe object; `null` means "not computable from this window".
export function computeIndicators(candles) {
  const closes = Array.isArray(candles) ? candles.map((c) => c.close) : [];
  const macdRes = macd(closes);
  const boll = bollinger(closes, 20, 2);
  const stoch = stochastic(Array.isArray(candles) ? candles : [], 14, 3);
  const sr = supportResistance(Array.isArray(candles) ? candles : [], 20);
  const structure = marketStructure(Array.isArray(candles) ? candles : [], 20);
  const brk = breakout(Array.isArray(candles) ? candles : [], 20);
  const kel = keltner(Array.isArray(candles) ? candles : [], 20, 2);
  const don = donchian(Array.isArray(candles) ? candles : [], 20);

  return {
    trend: {
      sma20: last(sma(closes, 20)),
      sma50: last(sma(closes, 50)),
      ema12: last(ema(closes, 12)),
      ema26: last(ema(closes, 26)),
      vwap: last(vwap(Array.isArray(candles) ? candles : [])),
      macd: lastOf(macdRes, "macd"),
      macdSignal: lastOf(macdRes, "signal"),
      macdHistogram: lastOf(macdRes, "histogram"),
      bollingerUpper: lastOf(boll, "upper"),
      bollingerMiddle: lastOf(boll, "middle"),
      bollingerLower: lastOf(boll, "lower"),
      trendDirection: trendDirection(closes, 20, 50)
    },
    momentum: {
      rsi14: last(rsi(closes, 14)),
      stochasticK: lastOf(stoch, "k"),
      stochasticD: lastOf(stoch, "d"),
      atr14: last(atr(Array.isArray(candles) ? candles : [], 14)),
      adx14: last(adx(Array.isArray(candles) ? candles : [], 14)),
      obv: last(obv(Array.isArray(candles) ? candles : []))
    },
    volatility: {
      regime: volatilityRegime(closes, 20),
      historicalVolatility20: num(historicalVolatility(closes, 20, 252)),
      keltnerUpper: kel ? num(kel.upper) : null,
      keltnerMiddle: kel ? num(kel.middle) : null,
      keltnerLower: kel ? num(kel.lower) : null,
      donchianUpper: don ? num(don.upper) : null,
      donchianLower: don ? num(don.lower) : null
    },
    structure: {
      support: sr && sr.support !== undefined ? num(sr.support) : null,
      resistance: sr && sr.resistance !== undefined ? num(sr.resistance) : null,
      breakout: {
        ok: Boolean(brk && brk.ok),
        direction: brk && brk.ok ? brk.direction : null,
        level: brk && brk.ok ? num(brk.level) : null
      },
      swingCount: structure && Array.isArray(structure.swings) ? structure.swings.length : 0,
      recentEvents: structure && Array.isArray(structure.events)
        ? structure.events.slice(-5).map((e) => ({index: e.index, type: e.type, direction: e.direction}))
        : []
    }
  };
}
