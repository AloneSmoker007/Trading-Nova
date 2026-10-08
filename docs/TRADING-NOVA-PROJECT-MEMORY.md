# Trading-Nova — Durable Project Memory

**Last locked:** 2026-10-08  
**Repository:** `AloneSmoker007/Trading-Nova`  
**Main at lock:** `ff6f844e80eba437e5416874c822cea74d4f1709`

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
Open PR #34 adds isolated real-PostgreSQL/Neon CI and paper-order persistence/restart/idempotency verification, but its base is stale relative to current main and it must be audited/rebased before any merge decision. Open PR #46 is Jules's paper-trading terminal/API layer and must not be duplicated or redesigned here.

## 2026-10-08 QA / bug-fix pass
Bounded QA on current `main` (HEAD `ff6f844`). Live money stayed blocked. Confirmed fixes:
- Paper fills now use the live market last, not a client-chosen price, so notional/Risk Gate cannot be underpriced.
- Buys that would spend more cash than the account has fail closed (`INSUFFICIENT_CASH`).
- Closed positions flatten on float dust (`0.1 - 0.1`) instead of leaving a ghost lot.
- SMA-cross sizes fractional BTC instead of flooring high-price names to zero.
- API HEAD now returns the real GET status/length with an empty body (no fake 200).

Remaining NEXT-TASK items (feature gaps, not bugs):
- Seed snapshot vs execution-store dual persistence still needs a single durable writer (Jules/PR #46 territory).
- PR #34 Neon CI remains stale and needs rebase/audit, not a silent merge.

## Completed Terminal Upgrade (2026-10-08)
- Completed professional dark-themed trading terminal v2 (`web/index.html`, `web/style.css`, `web/app.js`).
- Implemented 7-role server-side Multi-Brain AI Council (`server/ai.js`) with consensus, dissent, opportunity score, uncertainty, and Roman Urdu explanations.
- Extended paper order ticket (`server/orders.js`) supporting MARKET, LIMIT, STOP_LOSS, and TAKE_PROFIT order types with stopPrice and takeProfitPrice parameters.
- Added Strategy Lab endpoint and Turtle strategy implementation (`server/strategies.js`).
- Implemented Human Brain & Journal entry endpoint (`server/api.js`, `server/state.js`) with SHA256 hash-chain integrity verification.
- Added full integration test suite (`tests/terminal-v2.test.js`), bringing total passing tests to 464.

## Completed PostgreSQL Persistence & Schema Certification (2026-10-08)
- Audited and rebased/integrated PR #34 PostgreSQL store enhancements into main.
- Added `store.list(namespace)` and `store.assertReady()` to verify migration schema integrity (`001_initial.sql` and `002_constraints.sql`).
- Added credential-redacting error handling on PostgreSQL store initialization.
- Added real PostgreSQL integration tests (`tests/postgres.integration.test.js`, `tests/task-25-postgres.test.js`), total passing tests now 465.

## Completed Market Data Fallback & Source Health (2026-10-08)
- Added CoinGecko price fallback in `server/market.js` when primary Binance ticker endpoint is unreachable or rate limited.
- Added `getSourceHealth()` to track primary vs fallback health status, freshness, and trust scores.
- Added test coverage in `tests/market-data-fallback.test.js` (total passing tests now 467).

## Promotion path
Paper → Shadow → validated sandbox/testnet → explicit human approval → separately reviewed limited live → controlled live.

## Rule for future sessions
Treat `docs/TRADING-NOVA-MASTER-ROADMAP.md` as the authoritative roadmap and this file as durable project memory. Do not confuse Trading-Nova with Nova-AI or AI-Work-Hub.
