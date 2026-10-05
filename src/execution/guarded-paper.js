// Composition factory: wires the fail-closed NO-TRADE market gate into the
// paper execution boundary (audit MARKET F-02). Without a market state
// provider the engine refuses to construct; without healthy, fresh market
// data submit() returns a deterministic NO_TRADE record instead of a fill.
import { createPaperExecution } from "./paper.js";
import { withMarketGate } from "../market-data/guard.js";

export function createGuardedPaperExecution({
  getMarketState,
  maxAgeMs = 10000,
  maxRetainedFills = 50000,
} = {}) {
  if (typeof getMarketState !== "function") throw new Error("market state provider required");
  const engine = createPaperExecution({ maxRetainedFills });
  return withMarketGate(engine, getMarketState, { maxAgeMs });
}
