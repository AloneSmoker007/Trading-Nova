import {maxDrawdown as seriesMaxDrawdown} from "./metrics.js";

/**
 * Candle-close signals are submitted after a candle closes and therefore fill
 * no earlier than the next candle's open. This deliberately avoids same-bar
 * close fills that would use a price already known only after the signal point.
 */
export function runBacktestV2({
  candles,
  strategy,
  startingCash = 10000,
  feeRate = 0,
  slippageBps = 0,
  walkForward = 0
}) {
  if (!Array.isArray(candles) || candles.length === 0 || typeof strategy !== "function"
      || !Number.isFinite(startingCash) || startingCash <= 0
      || !Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1
      || !Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps >= 10000
      || !Number.isSafeInteger(walkForward) || walkForward < 0) {
    throw new TypeError("invalid backtest inputs");
  }
  if (candles.some((c) => !c || !Number.isFinite(c.open) || c.open <= 0
      || !Number.isFinite(c.close) || c.close <= 0)) {
    throw new TypeError("backtest candles require positive finite open and close prices");
  }

  const split = walkForward > 0
    ? Math.min(candles.length - 1, walkForward)
    : candles.length;

  const run = (rows) => {
    let cash = startingCash;
    let position = 0;
    let trades = 0;
    let pendingOrder = null;
    const equityCurve = [];

    for (const candle of rows) {
      // First fill the order created after the previous candle's close.
      // A market order whose cash/position constraints no longer hold is
      // rejected on this bar rather than silently filled at a stale price.
      if (pendingOrder) {
        const {side, quantity} = pendingOrder;
        const slip = candle.open * (slippageBps / 10000);
        const price = side === "BUY" ? candle.open + slip : candle.open - slip;
        const notional = quantity * price;
        const fee = notional * feeRate;

        if (side === "BUY" && Number.isFinite(notional + fee) && cash >= notional + fee) {
          cash -= notional + fee;
          position += quantity;
          trades++;
        } else if (side === "SELL" && Number.isFinite(notional - fee)
            && position >= quantity) {
          cash += notional - fee;
          position -= quantity;
          trades++;
        }
        pendingOrder = null;
      }

      // This strategy decision uses the candle's completed close. Any order
      // it emits is only eligible to fill at the next candle's open.
      const signal = strategy(candle, {cash, position});
      if (signal && ["BUY", "SELL"].includes(signal.side)
          && Number.isFinite(signal.quantity) && signal.quantity > 0) {
        pendingOrder = {side: signal.side, quantity: signal.quantity};
      }

      equityCurve.push(cash + position * candle.close);
    }

    // Any order signalled by the final candle is deliberately left unfilled:
    // no later candle exists to provide a causal execution price.
    const last = rows.at(-1)?.close ?? 0;
    const equity = cash + position * last;
    return {
      equity,
      trades,
      returnPct: (equity - startingCash) / startingCash,
      equityCurve,
      maxDrawdown: seriesMaxDrawdown(equityCurve)
    };
  };

  return {
    inSample: run(candles.slice(0, split)),
    outOfSample: walkForward ? run(candles.slice(split)) : null,
    parameters: {feeRate, slippageBps, walkForward},
    reproducible: true
  };
}

export function sensitivityGrid({
  candles,
  strategy,
  fees = [0, 0.001],
  slippageBps = [0, 5, 10]
}) {
  return fees.flatMap((feeRate) => slippageBps.map((slippage) => ({
    feeRate,
    slippageBps: slippage,
    result: runBacktestV2({
      candles,
      strategy,
      feeRate,
      slippageBps: slippage
    }).inSample
  })));
}
