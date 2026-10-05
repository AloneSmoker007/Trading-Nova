export function validatePortfolioState(state) {
  if (!state || typeof state !== "object") throw new Error("portfolio state required");
  for (const key of ["equity","cash","grossExposure","netExposure","dailyPnl","drawdown"]) {
    if (!Number.isFinite(state[key])) throw new Error(`invalid portfolio field: ${key}`);
  }
  if (state.equity < 0 || state.cash < 0 || state.grossExposure < 0 || state.drawdown < 0) throw new Error("invalid portfolio values");
  return Object.freeze({...state});
}

export function buildPortfolioState({cash, positions = [], startingEquity = cash}) {
  if (!Number.isFinite(cash) || cash < 0) throw new Error("invalid cash");
  if (!Number.isFinite(startingEquity) || startingEquity <= 0) throw new Error("invalid starting equity");
  let grossExposure = 0;
  let netExposure = 0;
  const normalized = positions.map((p) => {
    if (!p?.symbol || !Number.isFinite(p.quantity) || !Number.isFinite(p.markPrice)) throw new Error("invalid position");
    const notional = Math.abs(p.quantity * p.markPrice);
    grossExposure += notional;
    netExposure += p.quantity * p.markPrice;
    return Object.freeze({...p, notional});
  });
  const equity = cash + normalized.reduce((s,p)=>s + p.quantity*p.markPrice, 0);
  const drawdown = Math.max(0, (startingEquity - equity) / startingEquity);
  return validatePortfolioState({cash,equity,grossExposure,netExposure,dailyPnl: equity-startingEquity,drawdown,positions:normalized});
}