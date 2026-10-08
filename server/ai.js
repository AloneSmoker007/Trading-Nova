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

  // 2. Fundamental Brain
  const quoteVolume = ticker?.quoteVolume24h ?? 0;
  let fundScore = 50;
  let fundReason = "Standard market liquidity baseline";
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

  // 3. News Brain (Public market momentum proxy)
  const change24h = ticker?.changePct24h ?? 0;
  let newsScore = 50;
  let newsReason = "Balanced news and public market momentum";
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

  // 4. Sentiment Brain
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
  let resReason = "Fresh candle history and ticker feed available";
  if (!candles || candles.length < 20) {
    resScore = 35;
    resReason = "Insufficient historical candles for point-in-time evidence";
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

  const rolesDetail = [
    { role: "Technical", score: techScore, status: techScore >= 60 ? "BULLISH" : techScore <= 40 ? "BEARISH" : "NEUTRAL", reason: techReason },
    { role: "Fundamental", score: fundScore, status: fundScore >= 60 ? "STRONG" : fundScore <= 40 ? "WEAK" : "NEUTRAL", reason: fundReason },
    { role: "News", score: newsScore, status: newsScore >= 60 ? "POSITIVE" : newsScore <= 40 ? "NEGATIVE" : "NEUTRAL", reason: newsReason },
    { role: "Sentiment", score: sentScore, status: sentScore >= 60 ? "STABLE" : sentScore <= 40 ? "FEAR" : "NEUTRAL", reason: sentReason },
    { role: "Strategy", score: stratScore, status: stratScore >= 60 ? "ALIGNED" : stratScore <= 40 ? "OPPOSED" : "NEUTRAL", reason: stratReason },
    { role: "Risk", score: riskScore, status: riskScore >= 60 ? "SAFE" : riskScore <= 40 ? "HIGH_RISK" : "MODERATE", reason: riskReason },
    { role: "Research", score: resScore, status: resScore >= 60 ? "VALIDATED" : "INSUFFICIENT_DATA", reason: resReason }
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
    explanation: urduExplanation,
    generatedAt: Date.now(),
    note: "AI council provides advisory opportunity scores only. Real execution requires server-side Risk Gate ALLOW."
  };
}
