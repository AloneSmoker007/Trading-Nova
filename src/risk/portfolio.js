export function validatePortfolioState(state) {
  if (!state || typeof state !== "object") throw new Error("portfolio state required");
  for (const key of ["equity","cash","grossExposure","netExposure","dailyPnl","drawdown"]) {
    if (!Number.isFinite(state[key])) throw new Error(`invalid portfolio field: ${key}`);
  }
  if (state.equity < 0 || state.cash < 0 || state.grossExposure < 0 || state.drawdown < 0) throw new Error("invalid portfolio values");
  // High-water mark, when present, must be a usable equity figure.
  if (state.peakEquity !== undefined && (!Number.isFinite(state.peakEquity) || state.peakEquity <= 0)) {
    throw new Error("invalid portfolio field: peakEquity");
  }
  // Every position must be well formed: malformed positions can otherwise
  // inject NaN into exposure math downstream.
  if (state.positions !== undefined) {
    if (!Array.isArray(state.positions)) throw new Error("invalid portfolio field: positions");
    for (const p of state.positions) {
      if (!p || typeof p !== "object" || typeof p.symbol !== "string" || p.symbol.trim() === ""
        || !Number.isFinite(p.quantity) || !Number.isFinite(p.markPrice) || p.markPrice <= 0) {
        throw new Error("invalid portfolio position");
      }
    }
  }
  return Object.freeze({...state});
}

export function buildPortfolioState({cash, positions = [], startingEquity = cash, peakEquity = null, dayStartEquity = null} = {}) {
  if (!Number.isFinite(cash) || cash < 0) throw new Error("invalid cash");
  if (!Number.isFinite(startingEquity) || startingEquity <= 0) throw new Error("invalid starting equity");
  if (peakEquity !== null && (!Number.isFinite(peakEquity) || peakEquity <= 0)) throw new Error("invalid peak equity");
  if (dayStartEquity !== null && (!Number.isFinite(dayStartEquity) || dayStartEquity <= 0)) throw new Error("invalid day start equity");
  let grossExposure = 0;
  let netExposure = 0;
  const normalized = positions.map((p) => {
    if (!p?.symbol || !Number.isFinite(p.quantity) || !Number.isFinite(p.markPrice) || p.markPrice <= 0) throw new Error("invalid position");
    const notional = Math.abs(p.quantity * p.markPrice);
    grossExposure += notional;
    netExposure += p.quantity * p.markPrice;
    return Object.freeze({...p, notional});
  });
  const equity = cash + normalized.reduce((s,p)=>s + p.quantity*p.markPrice, 0);
  // Drawdown is measured from PEAK (high-water mark) equity, not starting
  // equity: an account that compounded and then gave it back must be stopped.
  // A new equity high raises the peak (drawdown 0). Without a supplied peak the
  // starting equity is the best known high-water mark.
  const effectivePeak = Math.max(peakEquity ?? startingEquity, equity);
  const drawdown = Math.max(0, (effectivePeak - equity) / effectivePeak);
  // dailyPnl is day-over-day when dayStartEquity is supplied; otherwise the
  // only known baseline is startingEquity.
  const dailyPnl = dayStartEquity === null ? equity - startingEquity : equity - dayStartEquity;
  return validatePortfolioState({cash,equity,grossExposure,netExposure,dailyPnl,drawdown,peakEquity:effectivePeak,positions:normalized});
}
