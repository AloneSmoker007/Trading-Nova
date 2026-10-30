import {runBacktestV2} from "../src/backtest/engine-v2.js";
import {createStrategy} from "./strategies.js";

// Read-only comparisons on the EXACT candles/split of the primary run. No
// optimization, extra provider calls, portfolio writes or promotion verdict.
export function backtestComparison({candles, strategyName, startingCash, walkForward, base}) {
  if (!Number.isSafeInteger(walkForward) || walkForward < 2 || walkForward > candles.length - 2) {
    throw new TypeError("comparison requires two nonempty execution windows");
  }
  const windows = {inSample: candles.slice(0, walkForward), outOfSample: candles.slice(walkForward)};
  const feeRate = base.parameters.feeRate, slippageBps = base.parameters.slippageBps;
  const summary = result => ({returnPct: result.returnPct, equity: result.equity,
    trades: result.trades, maxDrawdown: result.maxDrawdown});
  const cash = {returnPct: 0, equity: startingCash, trades: 0, maxDrawdown: 0};
  const buyHold = {};
  for (const [key, rows] of Object.entries(windows)) {
    let signalled = false;
    const result = runBacktestV2({candles: rows, startingCash, feeRate, slippageBps,
      strategy: (candle) => {
        if (signalled) return null;
        signalled = true;
        return {side: "BUY", quantity: startingCash * 0.95 / candle.close};
      }}).inSample;
    buyHold[key] = {...summary(result), state: result.trades === 1 ? "filled" : "not-filled",
      strategyExcessReturn: result.trades === 1 ? base[key].returnPct - result.returnPct : null};
  }
  const scenarios = [{id: "base", feeRate, slippageBps, result: base}];
  for (const costs of [{id: "double-cost", feeRate: feeRate * 2, slippageBps: slippageBps * 2},
    {id: "higher-slippage", feeRate: feeRate * 3, slippageBps: slippageBps * 4}]) {
    // Factories contain indicator history: never reuse an instance across cost
    // scenarios. Preserve the primary engine's causal IS -> OOS warm history.
    const strategy = createStrategy(strategyName);
    if (!strategy) throw new TypeError("unknown comparison strategy");
    scenarios.push({...costs, result: runBacktestV2({candles, strategy, startingCash, walkForward,
      feeRate: costs.feeRate, slippageBps: costs.slippageBps})});
  }
  return {
    benchmarks: {
      cash: {inSample: {...cash, strategyExcessReturn: base.inSample.returnPct},
        outOfSample: {...cash, strategyExcessReturn: base.outOfSample.returnPct}},
      buyHold,
      assumptions: "Cash earns zero interest. Buy-and-hold signals 95% of starting cash at each window's first close and attempts one fill at the next open with base fees/slippage. A cash-rejected entry is not a valid filled benchmark. Terminal equity marks the open position; no exit fee is simulated."
    },
    costSensitivity: {
      state: "descriptive-only",
      scenarios: scenarios.map(({id, feeRate, slippageBps, result}) => ({id, feeRate, slippageBps,
        inSample: summary(result.inSample), outOfSample: summary(result.outOfSample)})),
      outOfSampleReturnRange: {
        min: Math.min(...scenarios.map(x => x.result.outOfSample.returnPct)),
        max: Math.max(...scenarios.map(x => x.result.outOfSample.returnPct))
      },
      note: "Three fixed cost assumptions, not optimization, multiple rolling windows, statistical significance or a profitability certificate. Each scenario starts with fresh strategy state; causal indicator history warms through IS into OOS while cash/positions reset. Costs can alter fill acceptance and strategy paths, so returns need not be monotonic."
    }
  };
}
