// Deterministic market-order cost model for the paper-only execution service.
// Buys cross the current ask; sells cross the current bid. Configured slippage
// is applied beyond that quote, and fees are charged on executed quote notional.
// These are simulation assumptions, not a promise of venue-specific costs.

export const DEFAULT_PAPER_FEE_RATE = 0.001; // 0.10% per filled side
export const DEFAULT_PAPER_SLIPPAGE_BPS = 5; // 0.05% beyond bid/ask
export const MAX_PAPER_FEE_RATE = 0.05;
export const MAX_PAPER_SLIPPAGE_BPS = 1000;
export const DEFAULT_PAPER_DEPTH_PARTICIPATION_RATE = 0.1;

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
  const readNumber = (key, fallback) => {
    if (env[key] === undefined) return fallback;
    if (typeof env[key] !== "string" || env[key].trim() === "") {
      throw new TypeError(key + " must be a non-empty number");
    }
    const parsed = Number(env[key]);
    if (!Number.isFinite(parsed)) throw new TypeError(key + " must be a finite number");
    return parsed;
  };
  return validatePaperExecutionCostConfig({
    feeRate: readNumber("NOVA_PAPER_FEE_RATE", DEFAULT_PAPER_FEE_RATE),
    slippageBps: readNumber("NOVA_PAPER_SLIPPAGE_BPS", DEFAULT_PAPER_SLIPPAGE_BPS)
  });
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

/**
 * Simulate one LIMIT-order execution against a fresh Binance public depth
 * snapshot. At most 10% of each displayed level is considered available to
 * this paper order; this is a conservative participation assumption, not a
 * queue-position, market-impact or venue-fill guarantee.
 */
export function estimateLimitDepthExecution({
  side,
  quantity,
  limitPrice,
  referencePrice,
  book,
  feeRate = DEFAULT_PAPER_FEE_RATE,
  slippageBps = DEFAULT_PAPER_SLIPPAGE_BPS,
  participationRate = DEFAULT_PAPER_DEPTH_PARTICIPATION_RATE
} = {}) {
  const costs = validatePaperExecutionCostConfig({feeRate, slippageBps});
  const normalizedSide = typeof side === "string" ? side.trim().toUpperCase() : "";
  if (!["BUY", "SELL"].includes(normalizedSide)) throw new TypeError("paper execution side must be BUY or SELL");
  if (!Number.isFinite(quantity) || quantity <= 0
      || !Number.isFinite(limitPrice) || limitPrice <= 0
      || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    throw new TypeError("limit depth execution requires positive finite quantity and prices");
  }
  if (!Number.isFinite(participationRate) || participationRate <= 0 || participationRate > 0.25) {
    throw new RangeError("depth participation rate must be greater than 0 and at most 25%");
  }
  if (!book || book.source !== "binance-public"
      || !Number.isSafeInteger(book.lastUpdateId) || book.lastUpdateId < 1
      || !Array.isArray(book.bids) || !Array.isArray(book.asks)
      || !book.bids.length || !book.asks.length) {
    throw new TypeError("fresh Binance public depth snapshot required");
  }
  const validateLevels = (levels, descending) => {
    let previous = null;
    for (const level of levels) {
      if (!level || !Number.isFinite(level.price) || level.price <= 0
          || !Number.isFinite(level.quantity) || level.quantity <= 0
          || (previous !== null && (descending ? previous <= level.price : previous >= level.price))) {
        throw new TypeError("invalid or unsorted order-book depth");
      }
      previous = level.price;
    }
  };
  validateLevels(book.bids, true);
  validateLevels(book.asks, false);
  const bestBid = book.bids[0].price;
  const bestAsk = book.asks[0].price;
  if (bestBid > bestAsk) throw new RangeError("paper order-book snapshot is crossed");

  const midPrice = (bestBid + bestAsk) / 2;
  const levels = normalizedSide === "BUY" ? book.asks : book.bids;
  let remaining = quantity;
  let filledQuantity = 0;
  let notional = 0;
  let fee = 0;
  let quoteNotional = 0;
  let spreadCost = 0;
  let slippageCost = 0;
  for (const level of levels) {
    if (normalizedSide === "BUY" && level.price > limitPrice) break;
    if (normalizedSide === "SELL" && level.price < limitPrice) break;
    const executionPrice = normalizedSide === "BUY"
      ? level.price * (1 + costs.slippageBps / 10000)
      : level.price * (1 - costs.slippageBps / 10000);
    if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
      throw new RangeError("limit depth execution price is invalid");
    }
    // A limit order may not pay more or receive less than its limit after the
    // configured slippage assumption. Never clamp a worse quote into a fake fill.
    if (normalizedSide === "BUY" && executionPrice > limitPrice) break;
    if (normalizedSide === "SELL" && executionPrice < limitPrice) break;
    const available = level.quantity * participationRate;
    const take = Math.min(remaining, available);
    if (take <= 1e-12) continue;
    const levelNotional = take * executionPrice;
    const levelFee = levelNotional * costs.feeRate;
    if (![take, levelNotional, levelFee].every(Number.isFinite) || levelNotional <= 0 || levelFee < 0) {
      throw new RangeError("limit depth execution costs are invalid");
    }
    filledQuantity += take;
    remaining = Math.max(0, remaining - take);
    notional += levelNotional;
    fee += levelFee;
    quoteNotional += take * level.price;
    spreadCost += Math.abs(level.price - midPrice) * take;
    slippageCost += Math.abs(executionPrice - level.price) * take;
    if (remaining <= 1e-12) break;
  }
  if (filledQuantity <= 1e-12) return null;
  const executionPrice = notional / filledQuantity;
  const quotePrice = quoteNotional / filledQuantity;
  const spreadBps = ((bestAsk - bestBid) / midPrice) * 10000;
  const weightedSlippageBps = quoteNotional > 0 ? slippageCost / quoteNotional * 10000 : 0;
  if (![executionPrice, quotePrice, notional, fee, spreadBps, spreadCost, slippageCost, weightedSlippageBps]
      .every(Number.isFinite) || executionPrice <= 0 || notional <= 0 || fee < 0) {
    throw new RangeError("limit depth execution result is invalid");
  }
  return Object.freeze({
    side: normalizedSide,
    quantity: filledQuantity,
    referencePrice,
    midPrice,
    quoteBid: bestBid,
    quoteAsk: bestAsk,
    quotePrice,
    executionPrice,
    notional,
    fee,
    feeRate: costs.feeRate,
    spreadBps,
    spreadCost,
    slippageBps: weightedSlippageBps,
    slippageCost,
    bookUpdateId: book.lastUpdateId,
    participationRate,
    liquidityModel: "binance-public-depth-visible-size"
  });
}
