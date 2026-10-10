// server/ai.js — Multi-brain AI Council for Trading Nova.
//
// GOLDEN SAFETY RULE: Server-side advisory output ONLY.
// AI outputs are untrusted research advice and CANNOT bypass the deterministic Risk Gate.
// AI cannot execute orders, modify risk limits, or enable live trading.

import { runResearchCouncil } from "../src/intelligence/multi-agent.js";
import { computeIndicators } from "./indicators.js";

export function computeAiCouncil({ ticker, candles, portfolio, limits }) {
  const symbol = ticker?.symbol || "UNKNOWN";
  const ind = candles && candles.length >= 20 ? computeIndicators(candles) : null;

  // 1. Technical Brain
  let techScore = 50;
  let techReason = "Insufficient candles for full technical signal";
  if (ind) {
    let score = 50;
    const rsi = ind.momentum?.rsi14;
    if (rsi !== null && Number.isFinite(rsi)) {
      if (rsi < 30) score += 20; // oversold
      else if (rsi > 70) score -= 15; // overbought
      else score += (50 - Math.abs(rsi - 50)) * 0.2;
    }
    const sma20 = ind.trend?.sma20;
    const sma50 = ind.trend?.sma50;
    if (sma20 && sma50) {
      if (sma20 > sma50) score += 15;
      else score -= 15;
    }
    if (ind.trend?.trendDirection === "bullish") score += 10;
    if (ind.trend?.trendDirection === "bearish") score -= 10;
    techScore = Math.max(10, Math.min(95, Math.round(score)));
    techReason = `RSI(14)=${rsi ? rsi.toFixed(1) : "N/A"}, Trend=${ind.trend?.trendDirection || "neutral"}, SMA20/50 ${sma20 && sma50 && sma20 > sma50 ? "bullish cross" : "bearish/neutral"}`;
  }

  // 2. Liquidity proxy (quote volume is not company fundamentals)
  const quoteVolume = ticker?.quoteVolume24h ?? 0;
  let fundScore = 50;
  let fundReason = "24h quote volume unavailable; liquidity cannot be assessed from this field."
  if (quoteVolume > 10000000) {
    fundScore = 75;
    fundReason = `High 24h liquidity volume ($${(quoteVolume / 1e6).toFixed(1)}M quote volume)`;
  } else if (quoteVolume > 1000000) {
    fundScore = 60;
    fundReason = `Moderate 24h liquidity volume ($${(quoteVolume / 1e6).toFixed(2)}M quote volume)`;
  } else if (quoteVolume > 0) {
    fundScore = 40;
    fundReason = `Low liquidity volume ($${quoteVolume.toFixed(0)})`;
  }

  // 3. 24h price-momentum proxy (not a public-news feed)
  const change24h = ticker?.changePct24h ?? 0;
  let newsScore = 50;
  let newsReason = "Neutral 24h price momentum; no article-level news input is connected."
  if (change24h > 5) {
    newsScore = 75;
    newsReason = `Strong positive 24h price momentum (+${change24h.toFixed(2)}%)`;
  } else if (change24h < -5) {
    newsScore = 30;
    newsReason = `Negative 24h price momentum (${change24h.toFixed(2)}%)`;
  } else {
    newsScore = 50 + change24h * 2;
    newsReason = `24h change ${change24h >= 0 ? "+" : ""}${change24h.toFixed(2)}%`;
  }
  newsScore = Math.max(10, Math.min(95, Math.round(newsScore)));

  // 4. Volatility-regime proxy (not social/news sentiment)
  let sentScore = 50;
  let sentReason = "Volatility regime normal";
  if (ind?.volatility) {
    const vol = ind.volatility;
    if (vol.regime === "high") {
      sentScore = 40;
      sentReason = "High volatility regime — fear/caution recommended";
    } else if (vol.regime === "low") {
      sentScore = 65;
      sentReason = "Low volatility regime — stable sentiment";
    } else {
      sentScore = 55;
      sentReason = "Normal volatility regime";
    }
  }

  // 5. Strategy Brain
  let stratScore = 50;
  let stratReason = "Neutral strategy alignment";
  if (ind?.momentum && ind?.structure) {
    const macd = ind.trend?.macd;
    const macdSig = ind.trend?.macdSignal;
    if (macd !== null && macdSig !== null && macd > macdSig) {
      stratScore += 15;
    }
    if (ind.structure.breakout?.ok) {
      stratScore += ind.structure.breakout.direction === "BULLISH" ? 20 : -20;
    }
    stratScore = Math.max(10, Math.min(95, Math.round(stratScore)));
    stratReason = `MACD ${macd > macdSig ? "bullish" : "bearish"}, Breakout=${ind.structure.breakout?.ok ? ind.structure.breakout.direction : "none"}`;
  }

  // 6. Risk Brain
  let riskScore = 70;
  let riskReason = "Portfolio risk limits within green thresholds";
  if (portfolio) {
    const drawdown = portfolio.drawdown ?? 0;
    if (drawdown > 0.05) {
      riskScore = 30;
      riskReason = `Elevated drawdown detected (${(drawdown * 100).toFixed(1)}%) — reduce risk`;
    } else if (portfolio.grossExposure > 10000) {
      riskScore = 45;
      riskReason = `High gross exposure ($${portfolio.grossExposure.toFixed(0)})`;
    }
  }
  if (limits?.ok === false) {
    riskScore = 10;
    riskReason = `Risk limit breached: ${(limits.reasons || []).join(", ")}`;
  }

  // 7. Research Brain (Evidence quality and freshness)
  let resScore = 80;
  let resReason = "Historical candle data available; this role does not independently verify source freshness or external research.";
  if (!candles || candles.length < 20) {
    resScore = 35;
    resReason = "Insufficient historical candles for indicator context; no external research feed is evaluated.";
  }

  const evidence = {
    technical: [{ score: techScore, kind: "data", reason: techReason }],
    macro: [{ score: fundScore, kind: "data", reason: fundReason }],
    news: [{ score: newsScore, kind: "interpretation", reason: newsReason }],
    derivatives: [{ score: sentScore, kind: "interpretation", reason: sentReason }],
    microstructure: [{ score: stratScore, kind: "data", reason: stratReason }],
    risk: [{ score: riskScore, kind: "data", reason: riskReason }],
    skeptic: [{ score: resScore, kind: "data", reason: resReason }]
  };

  const councilResult = runResearchCouncil({ evidence });

  // Preserve stable role keys for API consumers, but expose honest display
  // labels and explicit input provenance. The UI must not present volume as
  // fundamental analysis, price momentum as news, or volatility as sentiment.
  const rolesDetail = [
    {
      role: "Technical",
      displayName: "Technical indicators",
      displayStatus: ind ? (ind.trend?.trendDirection || "trend unknown").toUpperCase() : "INSUFFICIENT DATA",
      basis: "RSI(14), SMA(20/50), and candle-trend indicators.",
      score: techScore,
      status: techScore >= 60 ? "BULLISH" : techScore <= 40 ? "BEARISH" : "NEUTRAL",
      reason: techReason
    },
    {
      role: "Liquidity proxy",
      legacyRole: "Fundamental",
      displayName: "Liquidity proxy",
      displayStatus: quoteVolume > 10000000 ? "HIGH VOLUME" : quoteVolume > 1000000 ? "MODERATE VOLUME" : quoteVolume > 0 ? "LOW VOLUME" : "VOLUME UNKNOWN",
      basis: "24-hour quote volume only. No company financial statements or fundamental-data feed is connected.",
      score: fundScore,
      status: quoteVolume > 10000000 ? "HIGH_VOLUME" : quoteVolume > 1000000 ? "MODERATE_VOLUME" : quoteVolume > 0 ? "LOW_VOLUME" : "VOLUME_UNKNOWN",
      reason: fundReason
    },
    {
      role: "24h momentum proxy",
      legacyRole: "News",
      displayName: "24h momentum proxy",
      displayStatus: change24h > 5 ? "POSITIVE MOMENTUM" : change24h < -5 ? "NEGATIVE MOMENTUM" : change24h > 1 ? "MILD POSITIVE CHANGE" : change24h < -1 ? "MILD NEGATIVE CHANGE" : "FLAT CHANGE",
      basis: "24-hour price change only. No public-news feed or article-level event evidence is connected.",
      score: newsScore,
      status: change24h > 5 ? "POSITIVE_MOMENTUM" : change24h < -5 ? "NEGATIVE_MOMENTUM" : change24h > 1 ? "MILD_POSITIVE_CHANGE" : change24h < -1 ? "MILD_NEGATIVE_CHANGE" : "FLAT_CHANGE",
      reason: newsReason
    },
    {
      role: "Volatility-regime proxy",
      legacyRole: "Sentiment",
      displayName: "Volatility-regime proxy",
      displayStatus: ind?.volatility?.regime === "high" ? "HIGH VOLATILITY" : ind?.volatility?.regime === "low" ? "LOW VOLATILITY" : ind?.volatility?.regime === "normal" ? "NORMAL VOLATILITY" : "VOLATILITY UNKNOWN",
      basis: "Candle-volatility regime only. No social, survey, or news-sentiment feed is connected.",
      score: sentScore,
      status: ind?.volatility?.regime === "high" ? "HIGH_VOLATILITY" : ind?.volatility?.regime === "low" ? "LOW_VOLATILITY" : ind?.volatility?.regime === "normal" ? "NORMAL_VOLATILITY" : "VOLATILITY_UNKNOWN",
      reason: sentReason
    },
    {
      role: "Strategy",
      displayName: "Strategy signals",
      displayStatus: stratScore >= 60 ? "ALIGNED" : stratScore <= 40 ? "OPPOSED" : "NEUTRAL",
      basis: "MACD and candle-breakout indicator alignment.",
      score: stratScore,
      status: stratScore >= 60 ? "ALIGNED" : stratScore <= 40 ? "OPPOSED" : "NEUTRAL",
      reason: stratReason
    },
    {
      role: "Risk",
      displayName: "Portfolio risk",
      displayStatus: limits?.ok === false ? "LIMIT BREACH" : "PAPER LIMITS",
      basis: "Current paper-portfolio exposures and deterministic risk-limit state.",
      score: riskScore,
      status: riskScore >= 60 ? "SAFE" : riskScore <= 40 ? "HIGH_RISK" : "MODERATE",
      reason: riskReason
    },
    {
      role: "Data sufficiency",
      legacyRole: "Research",
      displayName: "Data sufficiency",
      displayStatus: candles && candles.length >= 20 ? "CANDLES AVAILABLE" : "INSUFFICIENT DATA",
      basis: "Historical candle-count sufficiency only, not independent news or external-research validation.",
      score: resScore,
      status: candles && candles.length >= 20 ? "CANDLES_AVAILABLE" : "INSUFFICIENT_DATA",
      reason: resReason
    }
  ];

  const decision = limits?.ok === false ? "WAIT" : councilResult.decision;
  const opportunityScore = Math.round(councilResult.score);

  const urduExplanation = `AI Council Verdict for ${symbol}: Decision = ${decision}. Opportunity Score = ${opportunityScore}/100. Uncertainty = ${councilResult.uncertainty}.` +
    (councilResult.dissent?.length ? ` Key Dissenting Roles: ${councilResult.dissent.join(", ")}.` : "") +
    (limits?.ok === false ? " Risk Gate override: WAIT/NO-TRADE due to portfolio limit breach." : "");

  return {
    symbol,
    opportunityScore,
    uncertainty: councilResult.uncertainty,
    decision,
    dissent: councilResult.dissent,
    roles: rolesDetail,
    dataCoverage: {
      companyFundamentals: "not-connected",
      publicNews: "not-connected",
      socialSentiment: "not-connected",
      liquidity: "24h-quote-volume-proxy",
      priceMomentum: "24h-price-change-proxy",
      volatilityRegime: "candle-volatility-regime-proxy",
      note: "Company fundamentals, public news and social-sentiment feeds are not connected. Liquidity, momentum and volatility entries are explicitly labelled data proxies."
    },
    explanation: urduExplanation,
    generatedAt: Date.now(),
    note: "Advisory scores only. Fundamental/news/sentiment inputs are proxies, not connected feeds. Real execution still requires server-side Risk Gate ALLOW."
  };
}
