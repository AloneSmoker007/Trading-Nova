# Trading-Nova — Durable Project Memory

**Last locked:** 2026-10-08  
**Repository:** `AloneSmoker007/Trading-Nova`  
**Main at lock:** `d4df166a68dae82f9c70d86d1bf5e7661dfb20b2`

## User goal
Build a realistic trading web app that the user can personally use to learn trading. The current account uses fake money, but market conditions and paper execution should be as realistic as practical.

## Hard constraints
- Real-money trading is OFF.
- No broker/exchange live credentials are needed now.
- Never claim guaranteed profit.
- Gemini/AI must not bypass the deterministic Risk Gate.
- Internet/web content is research input, never an execution command.
- No restart or unnecessary redesign.
- Main stays green.
- Safe workflow: gap → spec → risk → one task → implement → test → review → CI → PR → merge only when green → checkpoint.
- Do not fabricate production, profitability, security or external operational evidence.

## Locked product capabilities
- Real/near-real-time market data and charts.
- Watchlists, markets, portfolio, positions, orders, fills, P&L and history.
- Market/limit/stop/TP paper orders supported by the engine.
- Realistic paper fills, fees, spread, slippage, partial fills, rejects, latency and restart recovery.
- Technical, fundamental, news, sentiment, strategy, risk and research AI brains.
- Human Brain: user journal, preferences, theses, mistakes, outcomes and durable learning memory.
- Internet Brain: fresh public research/news with source, freshness and evidence tracking.
- Market Brain: price/volume/order-flow/derivatives/intermarket context where available.
- Risk-adjusted opportunity ranking, consensus/dissent, uncertainty and WAIT/NO-TRADE.
- Backtesting, OOS, walk-forward, robustness and realistic-cost validation.
- Famous-trader/known-strategy simulation and paper-only copy/signal experiments using documented public methodology; never invent private trades.
- Strategy Lab, challenger/shadow modes, performance comparison, promotion/revalidation.
- Advanced portfolio risk, drawdown/loss limits, exposure/concentration/correlation/volatility/liquidity controls and kill switch.
- AI explanations, journal review, loss autopsy, alerts and learning reports.
- Professional responsive UI with backend-authoritative state.
- Gemini API server-side only.

## Current repo certification boundary
Phase 8 certifies the current personal paper/shadow release only. Real-money execution is explicitly blocked. The current main release does not prove profitability, Internet production exposure or independent penetration testing.

## Known next infrastructure gate
Open PR #34 adds isolated real-PostgreSQL/Neon CI and paper-order persistence/restart/idempotency verification, but its base is stale relative to current main and it must be audited/rebased before any merge decision. PR #44 is only Codespaces web-preview preparation and does not change trading behavior.

## Promotion path
Paper → Shadow → validated sandbox/testnet → explicit human approval → separately reviewed limited live → controlled live.

## Rule for future sessions
Treat `docs/TRADING-NOVA-MASTER-ROADMAP.md` as the authoritative roadmap and this file as durable project memory. Do not confuse Trading-Nova with Nova-AI or AI-Work-Hub.
