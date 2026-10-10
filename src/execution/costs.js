// Deterministic market-order cost model for the paper-only execution service.
// Buys cross the current ask; sells cross the current bid. Configured slippage
// is applied beyond that quote, and fees are charged on executed quote notional.
// These are simulation assumptions, not a promise of venue-specific costs.

export const DEFAULT_PAPER_FEE_RATE = 0.001; // 0.10% per filled side
export const DEFAULT_PAPER_SLIPPAGE_BPS = 5; // 0.05% beyond bid/ask
export const MAX_PAPER_FEE_RATE = 0.05;
export const MAX_PAPER_SLIPPAGE_BPS = 1000;

export function validatePaperExecutionCostConfig({
  feeRate = DEFAULT_PAPER_FEE_RATE,
  slippageBps = DEFAULT_PAPER_SLIPPAGE_BPS
} = {}) {
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > MAX_PAPER_FEE_RATE) {
    throw new RangeError("paper fee rate must be between 0 and " + MAX_PAPER_FEE_RATE);
  }
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_PAPER_SLIPPAGE_BPS) {
    throw new RangeError("paper slippage must be an integer from 0 to " + MAX_PAPER_SLIPPAGE_BPS + " bps");
  }
  return Object.freeze({feeRate, slippageBps});
}

export function paperExecutionCostConfigFromEnv(env = process.env) {
  const feeRate = env.NOVA_PAPER_FEE_RATE === undefined
    ? DEFAULT_PAPER_FEE_RATE
    : Number(env.NOVA_PAPER_FEE_RATE);
  const slippageBps = env.NOVA_PAPER_SLIPPAGE_BPS === undefined
    ? DEFAULT_PAPER_SLIPPAGE_BPS
    : Number(env.NOVA_PAPER_SLIPPAGE_BPS);
  return validatePaperExecutionCostConfig({feeRate, slippageBps});
}

/**
 * Calculate a reproducible market-order quote using a fresh bid/ask snapshot.
 * The last-traded price is a reference/mark only; it is never substituted for
 * the executable side of the book. Missing, crossed or non-finite quotes fail.
 */
export function estimateMarketExecution({
  side,
  quantity,
  last,
  bid,
  ask,
  feeRate = DEFAULT_PAPER_FEE_RATE,
  slippageBps = DEFAULT_PAPER_SLIPPAGE_BPS
} = {}) {
  const costs = validatePaperExecutionCostConfig({feeRate, slippageBps});
  const normalizedSide = typeof side === "string" ? side.trim().toUpperCase() : "";
  if (!["BUY", "SELL"].includes(normalizedSide)) throw new TypeError("paper execution side must be BUY or SELL");
  if (!Number.isFinite(quantity) || quantity <= 0) throw new TypeError("paper execution quantity must be positive and finite");
  if (![last, bid, ask].every((value) => Number.isFinite(value) && value > 0)) {
    throw new TypeError("paper execution requires positive finite last, bid and ask prices");
  }
  if (bid > ask) throw new RangeError("paper execution quote is crossed: bid exceeds ask");

  const midPrice = (bid + ask) / 2;
  const quotePrice = normalizedSide === "BUY" ? ask : bid;
  const slippagePerUnit = quotePrice * costs.slippageBps / 10000;
  const executionPrice = normalizedSide === "BUY"
    ? quotePrice + slippagePerUnit
    : quotePrice - slippagePerUnit;
  const notional = quantity * executionPrice;
  const fee = notional * costs.feeRate;
  const spreadBps = ((ask - bid) / midPrice) * 10000;
  const spreadCost = Math.abs(quotePrice - midPrice) * quantity;
  const slippageCost = Math.abs(executionPrice - quotePrice) * quantity;

  if (![midPrice, executionPrice, notional, fee, spreadBps, spreadCost, slippageCost]
      .every(Number.isFinite)
      || executionPrice <= 0 || notional <= 0 || fee < 0) {
    throw new RangeError("paper execution cost calculation was not finite and positive");
  }

  return Object.freeze({
    side: normalizedSide,
    quantity,
    referencePrice: last,
    midPrice,
    quoteBid: bid,
    quoteAsk: ask,
    quotePrice,
    executionPrice,
    notional,
    fee,
    feeRate: costs.feeRate,
    slippageBps: costs.slippageBps,
    spreadBps,
    spreadCost,
    slippageCost
  });
}
